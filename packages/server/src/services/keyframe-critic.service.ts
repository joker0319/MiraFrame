import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { asc, eq } from "drizzle-orm";
import { DRIZZLE, schema, type Db } from "../db";
import { encodeForVision, loadImageBuffer } from "./image-encoder";
import {
  buildRegenGuidance,
  buildVisionPrompt,
  isPlaceholderImage,
  mergeBatchCritiques,
  parseVisionCritique,
  planKeyframeRegen,
  planVisionBatches,
  readKeyframeCriticConfig,
  resolveVisionModel,
  type KeyframeRegenSkipReason,
  type ParsedVisionCritique,
  type VisionShotInput,
} from "./keyframe-critic";
import { collectRepairReferences, ShotRepairService } from "./shot-repair.service";
import { TextService } from "./text.service";

export interface KeyframeReviewResult {
  /** 合并后的评分；所有批次都失败时为 null */
  critique: ParsedVisionCritique["critique"] | null;
  threshold: number;
  missingOrders: number[];
  /** 实际送审的镜头数（取图失败的会被剔除） */
  reviewed: Array<{ shotId: number; order: number }>;
  /** 取图失败、没进审查的镜头 */
  unavailable: Array<{ shotId: number; order: number; error: string }>;
  batches: number;
  regenerated: Array<{ shotId: number; order: number; imageUrl: string }>;
  regenSkipped: Array<{ shotId: number; order: number; reason: KeyframeRegenSkipReason }>;
  regenFailed: Array<{ shotId: number; order: number; error: string }>;
  durationMs: number;
}

/**
 * 关键帧视觉审查（多模态 Critic）。
 *
 * 它补的是「质量チェック只有文本」这个洞：分镜审查读的是分镜脚本，
 * 一致性检查只认人脸距离，两者都回答不了「手有没有画歪」「画风有没有跑偏」
 * 「画面里是不是冒出了乱码文字」。这些恰好只有把图真的喂给视觉模型才能判断。
 *
 * 三层成本控制：
 * 1. 一次请求塞多张图（默认 4），6 镜项目只需 2 次调用，不是 6 次；
 * 2. 图片压到长边 768 / JPEG 0.8，单张 100KB 上下，请求体不会失控；
 * 3. 重画是可选动作，默认每轮最多 1 个镜头，且必须先满足「模型明确说该重画」。
 *
 * 整条链是**增强而不是关卡**：取图失败、模型返回坏 JSON、重画失败都不会抛出去，
 * 最多是这一轮没有审查结论 —— 生成流水线照常往下走。
 */
@Injectable()
export class KeyframeCriticService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(TextService) private readonly text: TextService,
    @Inject(ShotRepairService) private readonly repair: ShotRepairService,
  ) {}

  private env(key: string): string | undefined {
    return this.config.get<string>(key) ?? undefined;
  }

  async reviewProject(projectId: number): Promise<KeyframeReviewResult | null> {
    const config = readKeyframeCriticConfig((key) => this.env(key));
    if (!config.enabled) return null;

    const startedAt = Date.now();
    const [project] = await this.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);

    const shots = await this.db
      .select()
      .from(schema.shots)
      .where(eq(schema.shots.projectId, projectId))
      .orderBy(asc(schema.shots.order));
    // 占位图（SVG）不是真画面，审它只会得到「灰底无主体」这种噪音
    const usable = shots.filter((shot) => !isPlaceholderImage(shot.imageUrl));
    if (usable.length === 0) {
      console.log(`[keyframe-critic] 跳过 project=${projectId}：没有可用关键帧`);
      return null;
    }

    const characters = await this.db
      .select()
      .from(schema.characters)
      .where(eq(schema.characters.projectId, projectId))
      .orderBy(asc(schema.characters.id));
    const bindings = await this.db
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
    const characterById = new Map(characters.map((item) => [item.id, item]));

    // 长项目按预算截断：视觉审查是花钱的，先审前 N 个镜头，至少不会跑飞
    const scoped = usable.slice(0, config.maxShots);
    if (usable.length > scoped.length) {
      console.log(
        `[keyframe-critic] project=${projectId} 共 ${usable.length} 个可审镜头，按上限只审前 ${scoped.length} 个`,
      );
    }

    const inputs: Array<VisionShotInput & { referenceCount: number; basePrompt: string }> = [];
    const unavailable: KeyframeReviewResult["unavailable"] = [];

    for (const shot of scoped) {
      const boundIds = shot.characterIds?.length
        ? shot.characterIds
        : (boundByShot.get(shot.id) ?? []);
      const { references } = collectRepairReferences(
        boundIds,
        characters.map((item) => ({
          id: item.id,
          name: item.name,
          imageUrl: item.imageUrl,
          referenceImages: item.referenceImages,
        })),
      );
      inputs.push({
        shotId: shot.id,
        order: shot.order,
        description: shot.description || shot.imagePrompt,
        characterNames: boundIds
          .map((id) => characterById.get(id)?.name)
          .filter((name): name is string => Boolean(name)),
        referenceCount: references.length,
        basePrompt: shot.imagePrompt || shot.prompt || "",
      });
    }

    // 逐张取图 + 压缩。串行是为了让内存峰值可控：node-canvas 解一张 1024 图
    // 大约几十 MB，6 张并发容易把 worker 撑爆。
    const encoded: Array<{ input: (typeof inputs)[number]; dataUrl: string }> = [];
    const imageByOrder = new Map<number, string>();
    const shotById = new Map(scoped.map((shot) => [shot.id, shot]));
    for (const item of inputs) {
      const imageUrl = shotById.get(item.shotId)?.imageUrl;
      if (!imageUrl) continue;
      try {
        const buffer = await loadImageBuffer(imageUrl);
        const dataUrl = await encodeForVision(buffer);
        encoded.push({ input: item, dataUrl });
        imageByOrder.set(item.order, dataUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        unavailable.push({ shotId: item.shotId, order: item.order, error: message });
        console.warn(`[keyframe-critic] 取图失败 shot=#${item.order}：${message}`);
      }
    }
    if (encoded.length === 0) {
      console.warn(`[keyframe-critic] project=${projectId}：所有关键帧都取不到，跳过视觉审查`);
      return null;
    }

    const visionModel = resolveVisionModel((key) => this.env(key));
    const reviewable = encoded.map((item) => item.input);
    const batches = planVisionBatches(reviewable, config.maxImagesPerCall);
    const parsed: ParsedVisionCritique[] = [];

    for (const batch of batches) {
      const images = batch.shots
        .map((shot) => imageByOrder.get(shot.order))
        .filter((url): url is string => Boolean(url));
      if (images.length === 0) continue;
      const prompt = buildVisionPrompt(batch, {
        style: project?.style ?? null,
        projectTitle: project?.title ?? null,
      });
      try {
        const raw = await this.text.generateVision(prompt, images, {
          maxTokens: 2048,
          intent: "critique_keyframes",
          model: visionModel,
        });
        parsed.push(
          parseVisionCritique(
            raw,
            batch.shots.map((shot) => shot.order),
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 第一批就挂通常意味着整条链都不可用（没 key / 全熔断），后续批次再试也是白等
        console.warn(
          `[keyframe-critic] 第 ${batch.index}/${batches.length} 批审查失败：${message}`,
        );
        if (parsed.length === 0 && batch.index === 1) return null;
      }
    }
    if (parsed.length === 0) return null;

    const merged = mergeBatchCritiques(parsed);

    // 全局 issues 往往只有一两条概括，真正具体的问题在分镜头那层。
    // 展示时合并成一份带镜头号的清单，去重并限制条数（前端卡片放不下二十条）。
    const issues = [
      ...new Set([
        ...merged.critique.issues,
        ...merged.critique.shots.flatMap((shot) =>
          shot.issues.map((issue) => `镜头 #${shot.order}：${issue}`),
        ),
      ]),
    ].slice(0, 12);
    if (merged.missingOrders.length > 0) {
      issues.push(
        `镜头 ${merged.missingOrders.map((order) => `#${order}`).join("、")} 没有返回评分`,
      );
    }

    const result: KeyframeReviewResult = {
      critique: { ...merged.critique, issues },
      threshold: config.threshold,
      missingOrders: merged.missingOrders,
      reviewed: encoded.map((item) => ({ shotId: item.input.shotId, order: item.input.order })),
      unavailable,
      batches: batches.length,
      regenerated: [],
      regenSkipped: [],
      regenFailed: [],
      durationMs: 0,
    };

    if (config.regenerate && config.maxRegenerations > 0 && merged.critique.needsRegenerate) {
      const plan = planKeyframeRegen(
        inputs.filter((item) => imageByOrder.has(item.order)),
        merged.critique,
        config,
      );
      result.regenSkipped = plan.skipped;
      for (const candidate of plan.selected) {
        try {
          const repaired = await this.repair.repairWithReferences(projectId, candidate.shotId, {
            extraPrompt: buildRegenGuidance(candidate.suggestions) || undefined,
          });
          result.regenerated.push({
            shotId: candidate.shotId,
            order: candidate.order,
            imageUrl: repaired.imageUrl,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.regenFailed.push({
            shotId: candidate.shotId,
            order: candidate.order,
            error: message,
          });
          console.warn(`[keyframe-critic] 重画失败 shot=#${candidate.order}：${message}`);
        }
      }
    }

    result.durationMs = Date.now() - startedAt;
    return result;
  }
}
