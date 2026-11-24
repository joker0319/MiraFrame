import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { DRIZZLE, schema, type Db } from "../db";
import type { StoredShotConsistency } from "./consistency";
import { ConsistencyService, type ConsistencyInput } from "./consistency.service";
import { ImageService } from "./image.service";

export interface RepairShotResult {
  shotId: number;
  imageUrl: string;
  /** 实际传给图生图接口的参考图数量 */
  references: number;
  before: StoredShotConsistency | null;
  after: StoredShotConsistency | null;
}

/**
 * 把一致性校验反哺到生成：拿绑定角色的参考图走 Agnes 图生图重画漂移镜头。
 * 只改一张镜头图，不打断生成流水线；新图生成失败时旧图保留。
 */
@Injectable()
export class ShotRepairService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(ImageService) private readonly image: ImageService,
    @Inject(ConsistencyService) private readonly consistency: ConsistencyService,
  ) {}

  async repairWithReferences(projectId: number, shotId: number): Promise<RepairShotResult> {
    const [shot] = await this.db
      .select()
      .from(schema.shots)
      .where(and(eq(schema.shots.id, shotId), eq(schema.shots.projectId, projectId)))
      .limit(1);
    if (!shot) throw new NotFoundException("镜头不存在");

    const basePrompt = shot.imagePrompt || shot.prompt;
    if (!basePrompt) throw new BadRequestException("这个镜头还没有画面提示词，无法按参考图修正");

    const characters = await this.db
      .select()
      .from(schema.characters)
      .where(eq(schema.characters.projectId, projectId))
      .orderBy(asc(schema.characters.id));

    const boundIds = shot.characterIds?.length
      ? shot.characterIds
      : (
          await this.db
            .select({ characterId: schema.shotCharacterBindings.characterId })
            .from(schema.shotCharacterBindings)
            .where(eq(schema.shotCharacterBindings.shotId, shotId))
        ).map((row) => row.characterId);

    const labels: string[] = [];
    const references: string[] = [];
    for (const character of characters.filter((c) => boundIds.includes(c.id))) {
      const urls = dedupe([character.imageUrl, ...(character.referenceImages || [])]).slice(0, 3);
      for (const url of urls) {
        if (labels.length >= 4) break;
        labels.push(character.name);
        references.push(url);
      }
    }
    if (references.length === 0) {
      throw new BadRequestException("这个镜头绑定的角色还没有可用参考图，请先到角色设定补充角色图");
    }

    const prompt = buildRepairPrompt(basePrompt, labels);
    const imageUrl = await this.image.generateImage(prompt, {
      size: "1024x1024",
      referenceImages: references,
    });

    const before = shot.consistencyResult ?? null;
    await this.db
      .update(schema.shots)
      .set({ imageUrl, videoUrl: null, consistencyResult: null, updatedAt: new Date() })
      .where(eq(schema.shots.id, shotId));

    let after: StoredShotConsistency | null = null;
    try {
      after = await this.consistency.analyzeShotAndStore({
        shot: { id: shot.id, order: shot.order, imageUrl, characterIds: shot.characterIds },
        characters: characters.map((c) => ({
          id: c.id,
          name: c.name,
          imageUrl: c.imageUrl,
          referenceImages: c.referenceImages,
        })),
      });
    } catch (err) {
      // 人脸推理失败不能让已经换好的图回滚，前端仍可手动「重新检查」
      console.warn(`[shot-repair] consistency check failed for shot ${shotId}:`, err);
    }

    return { shotId, imageUrl, references: references.length, before, after };
  }
}

function dedupe(list: Array<string | null | undefined>): string[] {
  return [...new Set(list.filter((value): value is string => Boolean(value)))];
}

/** labels[i] 说明第 i+1 张参考图属于哪个角色，提示词里显式告诉模型要保脸。 */
export function buildRepairPrompt(basePrompt: string, labels: string[]): string {
  const mapping = labels.map((name, i) => `第 ${i + 1} 张：${name}`).join("；");
  return [
    basePrompt,
    "【角色一致性要求】",
    `输入的参考图对应关系：${mapping}。`,
    "请保留原分镜的场景、构图、光线和画风，让每位角色在画面中的脸型、五官、眉眼、发型和发色与对应参考图尽可能一致。",
    "不要改变角色身份，不要增加分镜里没有出现的角色。",
  ].join("\n");
}
