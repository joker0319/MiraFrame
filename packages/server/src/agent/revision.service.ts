import { Inject, Injectable } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { DRIZZLE, type Db } from "../db";
import { schema } from "../db";
import { analyzeCharacterImpact } from "./lineage";

export interface AssetImpact {
  changedCharacters: number;
  affectedShots: number;
  reusedShots: number;
}

export interface RevisionInput {
  projectId: number;
  content: string;
  feedbackType?: string;
  entityType?: string;
  entityId?: number;
}

@Injectable()
export class RevisionService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  targetStageFor(input: RevisionInput): string {
    if (input.entityType === "outline") return "plan_outline";
    if (input.entityType === "character" || input.entityType === "characters") return "plan_characters";
    if (input.entityType === "shots") return "plan_shots";
    if (input.entityType === "shot") {
      if (input.feedbackType === "script" || input.feedbackType === "dialogue") return "plan_shots";
      return "render_shot_images";
    }
    if (input.entityType === "project_video") return "compose_videos";
    return "review";
  }

  /**
   * 修改提交前先做影响面分析：只标脏真正受影响的产物，其余让渲染节点复用。
   *
   * 血缘来自 shots.characterIds（持久化字段），不来自 LangGraph state——
   * state 按 run 隔离，上一次 run 的血缘在新 run 里读不到。
   */
  async prepareAssets(input: RevisionInput): Promise<AssetImpact> {
    const shots = await this.db
      .select({
        id: schema.shots.id,
        characterIds: schema.shots.characterIds,
        prompt: schema.shots.prompt,
        imagePrompt: schema.shots.imagePrompt,
        imageUrl: schema.shots.imageUrl,
        videoUrl: schema.shots.videoUrl,
      })
      .from(schema.shots)
      .where(eq(schema.shots.projectId, input.projectId));
    const impact: AssetImpact = { changedCharacters: 0, affectedShots: 0, reusedShots: shots.length };

    const isCharacter = input.entityType === "character" || input.entityType === "characters";
    if (isCharacter) {
      const characters = await this.db
        .select({ id: schema.characters.id })
        .from(schema.characters)
        .where(eq(schema.characters.projectId, input.projectId));
      const changedIds = input.entityId ? [input.entityId] : characters.map((character) => character.id);
      impact.changedCharacters = changedIds.length;

      // 角色描述/形象变了，角色图本身也要重画（前端会重新生成）
      if (changedIds.length > 0 && input.feedbackType !== "rename") {
        await this.db
          .update(schema.characters)
          .set({ imageUrl: null, referenceImages: [], updatedAt: new Date() })
          .where(inArray(schema.characters.id, changedIds));
      }

      // 只把引用了这些角色的镜头标脏，其余镜头的 imageUrl/videoUrl 保留 → 渲染时跳过
      const analysis = analyzeCharacterImpact(shots, changedIds);
      impact.affectedShots = analysis.affected.length;
      impact.reusedShots = analysis.reused.length;
      if (analysis.affected.length > 0) {
        await this.db
          .update(schema.shots)
          .set({ imageUrl: null, videoUrl: null, consistencyResult: null, updatedAt: new Date() })
          .where(inArray(schema.shots.id, analysis.affected));
      }
      return impact;
    }

    if (input.entityType !== "shot") return impact;

    if (!input.entityId) {
      for (const shot of shots) {
        await this.prepareShotAsset(input, shot.id, shot.prompt, shot.imagePrompt);
      }
      impact.affectedShots = shots.length;
      impact.reusedShots = 0;
      return impact;
    }

    const [shot] = await this.db
      .select({ prompt: schema.shots.prompt, imagePrompt: schema.shots.imagePrompt })
      .from(schema.shots)
      .where(eq(schema.shots.id, input.entityId))
      .limit(1);
    await this.prepareShotAsset(input, input.entityId, shot?.prompt, shot?.imagePrompt);
    impact.affectedShots = shots.some((item) => item.id === input.entityId) ? 1 : 0;
    impact.reusedShots = shots.length - impact.affectedShots;
    return impact;
  }

  formatUserMessage(input: RevisionInput): string {
    const target = [input.entityType, input.entityId ? `#${input.entityId}` : null, input.feedbackType]
      .filter(Boolean)
      .join(" / ");
    return target ? `[修改反馈：${target}]\n${input.content}` : input.content;
  }

  formatAcceptedMessage(input: RevisionInput, targetStage: string, impact?: AssetImpact): string {
    const target = input.entityType === "shot" && input.entityId
      ? `镜头 #${input.entityId}`
      : this.entityLabel(input.entityType);
    const base = `已提交修改：${target}\n将重新执行节点：${targetStage}\n反馈内容：${input.content}`;
    if (!impact || impact.affectedShots === 0) return base;
    return `${base}\n增量范围：${impact.affectedShots} 个镜头重新渲染，${impact.reusedShots} 个镜头复用已有画面。`;
  }

  private async prepareShotAsset(
    input: RevisionInput,
    shotId: number,
    prompt?: string | null,
    imagePrompt?: string | null,
  ): Promise<void> {
    if (input.feedbackType === "regenerate_video" || input.feedbackType === "motion") {
      const nextPrompt = [prompt, `用户视频反馈：${input.content}`].filter(Boolean).join("\n");
      await this.db
        .update(schema.shots)
        .set({ prompt: nextPrompt, videoUrl: null, updatedAt: new Date() })
        .where(eq(schema.shots.id, shotId));
    }

    if (input.feedbackType === "regenerate_image" || input.feedbackType === "style") {
      const nextImagePrompt = [imagePrompt, `用户画面反馈：${input.content}`].filter(Boolean).join("\n");
      await this.db
        .update(schema.shots)
        .set({ imagePrompt: nextImagePrompt, imageUrl: null, videoUrl: null, consistencyResult: null, updatedAt: new Date() })
        .where(eq(schema.shots.id, shotId));
    }
  }

  private entityLabel(entityType?: string): string {
    const map: Record<string, string> = {
      outline: "故事大纲",
      character: "角色设定",
      characters: "角色设定",
      shots: "分镜脚本",
      shot: "镜头物料",
      project_video: "合成输出",
    };
    return entityType ? map[entityType] || entityType : "项目";
  }
}
