/**
 * 生成后的增强/审查：一致性检测、漂移修复、关键帧视觉审查。
 *
 * 这三件事的共同点是「不阻断主流程」：任何失败都只记录，生成继续。
 * 从 AgentProcessor 抽出来，一方面让 processor 只负责编排，
 * 另一方面让这层可以单独做编排测试，不必拉起 BullMQ/Nest。
 */
import type { ConfigService } from "@nestjs/config";
import { asc, eq } from "drizzle-orm";
import { schema, type Db } from "../../db";
import type { WsGateway } from "../../ws";
import {
  ConsistencyService,
  KeyframeCriticService,
  ShotRepairService,
  createImageEnvReader,
} from "../../services";
import type { ConsistencyRun } from "../../services/consistency";
import { collectRepairReferences } from "../../services/shot-repair.service";
import {
  isImageRepairAvailable,
  planAutoRepair,
  readAutoRepairConfig,
  runAutoRepair,
  worstDistanceOf,
} from "../../services/auto-repair";
import { toShotDto } from "../../contracts/dto";

export interface PostProcessingDeps {
  db: Db;
  wsGateway: WsGateway;
  config: ConfigService;
  consistencyService: ConsistencyService;
  shotRepair: ShotRepairService;
  keyframeCritic: KeyframeCriticService;
}

/** 一致性检查的产物，检测与自动修复共用，避免二次查库。 */
export interface ConsistencySnapshot {
  run: ConsistencyRun;
  shots: Array<{
    id: number;
    order: number;
    imageUrl: string | null;
    characterIds: number[] | null;
  }>;
  characters: Array<{
    id: number;
    name: string;
    imageUrl: string | null;
    referenceImages: string[] | null;
  }>;
}

export function createPostProcessing(deps: PostProcessingDeps) {
  const { db, wsGateway, config } = deps;

  /**
   * 镜头图生成完就自动校验角色长相，并把结论写回每个 shot。
   * 增强而非关卡：人脸模型没准备好、图片下载失败都不能让生成任务失败。
   */
  async function autoCheckConsistency(projectId: number): Promise<ConsistencySnapshot | null> {
    try {
      const [characters, shots] = await Promise.all([
        db
          .select()
          .from(schema.characters)
          .where(eq(schema.characters.projectId, projectId))
          .orderBy(asc(schema.characters.id)),
        db
          .select()
          .from(schema.shots)
          .where(eq(schema.shots.projectId, projectId))
          .orderBy(asc(schema.shots.order)),
      ]);
      if (characters.length === 0 || shots.length === 0) return null;

      const run = await deps.consistencyService.analyzeAndStore({
        projectId,
        characters: characters.map((c) => ({
          id: c.id,
          name: c.name,
          imageUrl: c.imageUrl,
          referenceImages: c.referenceImages,
        })),
        shots: shots.map((s) => ({
          id: s.id,
          order: s.order,
          imageUrl: s.imageUrl,
          characterIds: s.characterIds,
        })),
      });

      wsGateway.sendToProject(projectId, "consistency_eval_completed", {
        project_id: projectId,
        source: "auto",
        checked_at: run.checkedAt,
        summary: run.report.summary,
        shots: run.stored.map((item) => ({
          shot_id: item.shotId,
          consistency_result: item.consistencyResult,
        })),
      });
      console.log(
        `[processor] 自动一致性检查完成 project=${projectId} ` +
          `ok=${run.report.summary.ok} review=${run.report.summary.review} drift=${run.report.summary.drift} unverifiable=${run.report.summary.unverifiable}`,
      );

      return { run, shots, characters };
    } catch (error) {
      console.warn(`[processor] 自动一致性检查跳过 project=${projectId}:`, error);
      return null;
    }
  }

  /**
   * 自动修复漂移镜头：把「检出问题」和「按参考图重画」接成闭环。
   *
   * 三道闸按成本从低到高排：配置 → 图像服务是否真能出图 → 这一轮有没有漂移。
   * 图像服务那一道最重要：fake provider 和缺 key 都会静默返回占位图，
   * 放过去就会把真图换成灰底占位图，还顺手清掉视频。
   */
  async function autoRepairDriftedShots(
    projectId: number,
    snapshot: ConsistencySnapshot,
  ): Promise<void> {
    const repairConfig = readAutoRepairConfig((key) => config.get<string>(key) ?? undefined);
    if (!repairConfig.enabled || repairConfig.maxShots <= 0) return;

    if (!isImageRepairAvailable(createImageEnvReader(config))) {
      console.warn(
        `[processor] 自动修复跳过 project=${projectId}：图像 provider 不可用（fake 或缺 key）`,
      );
      return;
    }

    // characterIds 是主路径；只有历史数据才会只剩绑定表，这里合并一次，
    // 避免自动修复对老项目「看不见参考图」而静默跳过。
    const bindings = await db
      .select({
        shotId: schema.shotCharacterBindings.shotId,
        characterId: schema.shotCharacterBindings.characterId,
      })
      .from(schema.shotCharacterBindings)
      .innerJoin(schema.shots, eq(schema.shots.id, schema.shotCharacterBindings.shotId))
      .where(eq(schema.shots.projectId, projectId));

    const boundByShot = new Map<number, number[]>();
    for (const row of bindings) {
      const list = boundByShot.get(row.shotId) ?? [];
      list.push(row.characterId);
      boundByShot.set(row.shotId, list);
    }

    const byShotId = new Map(
      snapshot.run.stored.map((item) => [item.shotId, item.consistencyResult]),
    );
    const orderById = new Map(snapshot.shots.map((shot) => [shot.id, shot.order]));
    const candidates = snapshot.shots.map((shot) => {
      const result = byShotId.get(shot.id) ?? null;
      const boundIds = shot.characterIds?.length
        ? shot.characterIds
        : (boundByShot.get(shot.id) ?? []);
      const { references } = collectRepairReferences(boundIds, snapshot.characters);
      return {
        shotId: shot.id,
        order: shot.order,
        verdict: result?.verdict ?? ("unverifiable" as const),
        worstDistance: worstDistanceOf(result),
        referenceCount: references.length,
      };
    });

    const plan = planAutoRepair(candidates, repairConfig.maxShots);
    if (plan.selected.length === 0) {
      console.log(`[processor] 自动修复：本轮无可用漂移镜头 project=${projectId}`);
      return;
    }
    console.log(
      `[processor] 自动修复 ${plan.selected.length} 个漂移镜头 project=${projectId}：` +
        plan.selected.map((item) => `#${item.order}`).join("、"),
    );

    const outcome = await runAutoRepair({
      plan,
      repair: async (shotId) => {
        const result = await deps.shotRepair.repairWithReferences(projectId, shotId);
        // 修复服务只改库不广播，这里补一条 shot_updated，前端不用刷新就能看到新图
        const [updated] = await db
          .select()
          .from(schema.shots)
          .where(eq(schema.shots.id, shotId))
          .limit(1);
        if (updated) {
          wsGateway.sendToProject(projectId, "shot_updated", { shot: toShotDto(updated) });
        }
        return { shotId, references: result.references, after: result.after };
      },
      log: (message) => console.log(`[processor:auto-repair] ${message}`),
    });

    wsGateway.sendToProject(projectId, "consistency_repair_completed", {
      project_id: projectId,
      source: "auto",
      repaired: outcome.repaired.map((item) => ({
        shot_id: item.shotId,
        order: orderById.get(item.shotId) ?? null,
        references: item.references,
        verdict: item.verdict,
        resolved: item.resolved,
      })),
      skipped: outcome.skipped.map((item) => ({ shot_id: item.shotId, reason: item.reason })),
      failed: outcome.failed.map((item) => ({ shot_id: item.shotId, error: item.error })),
    });

    const unresolved = outcome.repaired.filter((item) => !item.resolved).length;
    console.log(
      `[processor] 自动修复完成 project=${projectId} ` +
        `repaired=${outcome.repaired.length} unresolved=${unresolved} failed=${outcome.failed.length} ` +
        `skipped=${outcome.skipped.length}`,
    );
  }

  /**
   * 关键帧视觉审查：把画面交给视觉模型。
   *
   * 与人脸一致性互补：人脸回答「是不是同一个人」，视觉模型回答「这张图画得对不对」。
   * 失败只记日志，绝不阻断后面的生视频。
   */
  async function critiqueKeyframes(projectId: number): Promise<void> {
    try {
      const result = await deps.keyframeCritic.reviewProject(projectId);
      if (!result || !result.critique) return;

      const { critique, threshold } = result;
      const passed = critique.score >= threshold;

      wsGateway.sendToProject(projectId, "critique_result", {
        stage: "keyframe",
        entity_type: "shots",
        entity_id: null,
        score: critique.score,
        threshold,
        passed,
        // 视觉审查目前只跑一轮：重画后不再复审，避免「审-改-审」无限花钱
        round: 1,
        max_rounds: 1,
        dimensions: critique.dimensions,
        issues: critique.issues,
        suggestions: critique.suggestions,
        will_regenerate: result.regenerated.length > 0,
      });

      // 重画改的是库里的图，修复服务不广播，这里补 shot_updated
      for (const item of result.regenerated) {
        const [updated] = await db
          .select()
          .from(schema.shots)
          .where(eq(schema.shots.id, item.shotId))
          .limit(1);
        if (updated) {
          wsGateway.sendToProject(projectId, "shot_updated", { shot: toShotDto(updated) });
        }
      }

      console.log(
        `[processor] 关键帧视觉审查 project=${projectId} ` +
          `score=${critique.score.toFixed(1)}/${threshold} ${passed ? "通过" : "未达标"} ` +
          `reviewed=${result.reviewed.length} batches=${result.batches} ` +
          `unavailable=${result.unavailable.length} regenerated=${result.regenerated.length} ` +
          `failed=${result.regenFailed.length} ${result.durationMs}ms`,
      );
    } catch (error) {
      console.warn(`[processor] 关键帧视觉审查跳过 project=${projectId}:`, error);
    }
  }

  return { autoCheckConsistency, autoRepairDriftedShots, critiqueKeyframes };
}

export type PostProcessing = ReturnType<typeof createPostProcessing>;
