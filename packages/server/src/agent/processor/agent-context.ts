/**
 * 一次生成 job 的 AgentContext 实现。
 *
 * 这一层是 agent 与 server 的边界：Agent 只看到 sendMessage/callLlm/...
 * 这里负责把每个调用翻译成 DB、供应商、WS 副作用。
 *
 * 从 AgentProcessor 抽出来后，processor 只剩生命周期与图循环；
 * 资产生成/上下文状态仍按 job 隔离（局部闭包），不会跨 job 串号。
 */
import type {
  AgentContext,
  CritiqueReport,
  LlmChatMessage,
  ToolDefinition,
} from "@miraframe/agent";
import type { AgentThinkingPhase, StoryOutline } from "@miraframe/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db";
import { schema } from "../../db";
import type { WsGateway } from "../../ws";
import type { ImageService, TextService, VideoService } from "../../services";
import type { AgentProjectSnapshot } from "../agent-run-state";
import { buildArtifactLineage, matchCharacterIds, type LineageCharacter } from "../lineage";
import type { PostProcessing } from "./post-processing";
import { toCritiqueResultPayload } from "../critique-payload";
import { toCharacterDto, toShotDto } from "../../contracts/dto";
import { buildShotImagePrompt, buildShotVideoPrompt, isPlayableVideoUrl } from "./prompts";

export interface AgentContextDeps {
  projectId: number;
  runId: number;
  threadId: string;
  db: Db;
  wsGateway: WsGateway;
  textService: TextService;
  imageService: ImageService;
  videoService: VideoService;
  project: AgentProjectSnapshot | undefined;
  /** 已经拼好的项目上下文 + 历史对话 + 记忆摘要 */
  contextBlock: string;
  initialOutline: StoryOutline | null;
  initialVisualBible: string | null;
  initialProgress: number;
  currentCharacters: () => Promise<LineageCharacter[]>;
  assertRunActive: () => Promise<void>;
  post: PostProcessing;
}

export interface AgentContextBundle {
  ctx: AgentContext;
  /** saveOutline 之后的最新值，供 processor 在人工门事件里读取 */
  currentOutline: () => StoryOutline | null;
  currentVisualBible: () => string | null;
}

export function createAgentContext(deps: AgentContextDeps): AgentContextBundle {
  const { projectId, runId, threadId } = deps;
  const project = deps.project;
  const contextBlock = deps.contextBlock;
  const currentCharacters = deps.currentCharacters;
  const assertRunActive = deps.assertRunActive;
  let latestOutline = deps.initialOutline;
  let latestVisualBible = deps.initialVisualBible;
  // 进度是单调量：只有显式给出 progress 才前进。
  let latestProgress = deps.initialProgress;

  // ---- Build the REAL agent context ----
  // 进度是单调量：只有显式给出 progress 才前进。只带 stage 的消息
  // 以前会写 progress=0，导致进度条在 Critic 跳过等场景中途回跳。
  // 从 run 的现有进度起步，重试/续跑时不会把进度打回 0。

  const ctx: AgentContext = {
    projectId,
    runId,
    threadId,
    sendMessage: async (
      content: string,
      opts?: { summary?: string; progress?: number; isLoading?: boolean; stage?: string },
    ) => {
      console.log(
        `[processor:msg] content="${content.substring(0, 80)}..." progress=${opts?.progress ?? "N/A"} stage=${opts?.stage ?? "N/A"}`,
      );
      if (typeof opts?.progress === "number") latestProgress = opts.progress;
      try {
        await deps.db.insert(schema.messages).values({
          projectId,
          runId,
          agent: "system",
          role: "assistant",
          content,
          summary: opts?.summary || null,
          progress: opts?.progress ?? null,
          isLoading: opts?.isLoading || false,
          createdAt: new Date(),
        });
      } catch (dbErr) {
        console.error(`[processor:msg] DB insert failed:`, dbErr);
      }

      // Send run_message for chat panel
      deps.wsGateway.sendToProject(projectId, "run_message", {
        agent: "system",
        role: "assistant",
        content,
        summary: opts?.summary,
        progress: opts?.progress,
        is_loading: opts?.isLoading,
      });

      // Also send run_progress for pipeline stage tracking
      if (opts?.progress !== undefined || opts?.stage) {
        const stage = opts?.stage || "plan_outline";
        // Map stage to progress value (matching old project's workflow_progress_for_stage)
        deps.wsGateway.sendToProject(projectId, "run_progress", {
          run_id: runId,
          project_id: projectId,
          current_agent: "system",
          current_stage: stage,
          stage,
          progress: latestProgress,
        });

        await deps.db
          .update(schema.agentRuns)
          .set({ progress: latestProgress, currentAgent: stage, updatedAt: new Date() })
          .where(eq(schema.agentRuns.id, runId));
      }
    },

    sendThinking: async (phase: AgentThinkingPhase, content: string, details?: string) => {
      console.log(`[processor:thinking] phase="${phase}" content="${content.substring(0, 60)}..."`);
      deps.wsGateway.sendToProject(projectId, "agent_thinking", {
        agent: "system",
        phase,
        content,
        details,
      });
    },

    /**
     * 评审结论的结构化出口。
     * 载荷用 snake_case，与 shot_updated / run_progress 等既有事件保持一致；
     * threshold / round / max_rounds 一并下发，前端不必再猜「为什么没过」。
     */
    reportCritique: async (report: CritiqueReport) => {
      deps.wsGateway.sendToProject(projectId, "critique_result", toCritiqueResultPayload(report));
    },

    callLlm: async (systemPrompt: string, userPrompt: string, opts?: { maxTokens?: number }) => {
      console.log(`[processor:llm] Calling LLM...`);
      console.log(
        `[processor:llm] systemPrompt (first 120 chars): ${systemPrompt.substring(0, 120)}`,
      );
      console.log(`[processor:llm] userPrompt (first 120 chars): ${userPrompt.substring(0, 120)}`);
      try {
        const promptWithProject = `${contextBlock}\n\nTask:\n${userPrompt}`;
        const result = await deps.textService.generate(promptWithProject, {
          ...opts,
          systemPrompt,
        });
        console.log(`[processor:llm] Response (first 200 chars): ${result.substring(0, 200)}`);
        return result;
      } catch (err) {
        console.error(`[processor:llm] FAILED:`, err);
        throw err;
      }
    },

    /**
     * 工具通道：模型在这里真正"决定调用哪个工具"。
     * 项目上下文只注入一次到首条 user 消息，避免多轮循环里重复拼接。
     */
    callLlmWithTools: async (
      messages: LlmChatMessage[],
      tools: ToolDefinition[],
      opts?: { maxTokens?: number; intent?: string },
    ) => {
      console.log(
        `[processor:llm:tools] tools=${tools.map((t) => t.name).join(",")} messages=${messages.length}`,
      );
      let injected = false;
      const withContext = messages.map((message) => {
        if (!injected && message.role === "user") {
          injected = true;
          return { ...message, content: `${contextBlock}\n\nTask:\n${message.content}` };
        }
        return message;
      });
      return deps.textService.generateWithTools(withContext, tools, opts);
    },

    /** 从数据库读取持久化血缘，跨 run 有效（LangGraph state 做不到） */
    getArtifactLineage: async () => {
      const rows = await deps.db
        .select({ id: schema.shots.id, characterIds: schema.shots.characterIds })
        .from(schema.shots)
        .where(eq(schema.shots.projectId, projectId));
      return buildArtifactLineage(rows);
    },

    saveOutline: async (outline: Record<string, unknown>, visualBible?: string | null) => {
      console.log(`[processor:db] Saving story outline`);
      latestOutline = outline as unknown as StoryOutline;
      latestVisualBible = visualBible || null;
      await deps.db
        .update(schema.projects)
        .set({
          storyOutline: outline,
          visualBible: visualBible || null,
          updatedAt: new Date(),
        })
        .where(eq(schema.projects.id, projectId));

      deps.wsGateway.sendToProject(projectId, "outline_updated", {
        project_id: projectId,
        story_outline: latestOutline,
        visual_bible: visualBible || null,
        outline_approved: false,
      });
    },

    createCharacter: async (char: { name: string; description: string }) => {
      console.log(`[processor:db] Creating character: "${char.name}"`);
      const [existing] = await deps.db
        .select()
        .from(schema.characters)
        .where(
          and(eq(schema.characters.projectId, projectId), eq(schema.characters.name, char.name)),
        )
        .orderBy(asc(schema.characters.id))
        .limit(1);

      if (existing) {
        const [updated] = await deps.db
          .update(schema.characters)
          .set({
            description: char.description || existing.description,
            updatedAt: new Date(),
          })
          .where(eq(schema.characters.id, existing.id))
          .returning();

        if (updated) {
          deps.wsGateway.sendToProject(projectId, "character_updated", {
            character: toCharacterDto(updated),
          });
        }

        return updated || existing;
      }

      const [record] = await deps.db
        .insert(schema.characters)
        .values({
          projectId,
          name: char.name,
          description: char.description,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
      if (record) {
        // Send full Character record via WS (matching old project's CharacterRead schema)
        deps.wsGateway.sendToProject(projectId, "character_created", {
          character: toCharacterDto(record),
        });
      }
      return record || { id: 0 };
    },

    generateCharacterImage: async () => {
      console.log(`[processor] Generating character images for project ${projectId}`);
      await assertRunActive();
      await ctx.sendMessage("正在生成角色人物照片...", {
        summary: "角色照片生成中",
        progress: 0.38,
        stage: "plan_characters",
      });

      const characters = await deps.db
        .select()
        .from(schema.characters)
        .where(eq(schema.characters.projectId, projectId))
        .orderBy(asc(schema.characters.id));

      const failures: string[] = [];
      let referencesChanged = false;
      for (const character of characters) {
        await assertRunActive();
        if (character.imageUrl) continue;
        const prompt = [
          `Create a polished character portrait for an AI comic/drama project.`,
          `Project style: ${project?.style || "anime"}.`,
          `Character name: ${character.name}.`,
          `Character description: ${character.description || ""}`,
          `Visual bible: ${latestVisualBible || "clean, consistent character design, expressive face, full body reference"}.`,
        ].join("\n");

        try {
          const imageUrl = await deps.imageService.generateImage(prompt);
          const [updated] = await deps.db
            .update(schema.characters)
            .set({
              imageUrl,
              referenceImages: [imageUrl],
              updatedAt: new Date(),
            })
            .where(eq(schema.characters.id, character.id))
            .returning();

          if (updated) {
            referencesChanged = true;
            deps.wsGateway.sendToProject(projectId, "character_updated", {
              character: toCharacterDto(updated),
            });
          }
        } catch (err) {
          console.warn(
            `[processor] Character image generation failed for "${character.name}":`,
            err,
          );
          failures.push(character.name);
          await ctx.sendMessage(`角色「${character.name}」照片生成暂时失败，可稍后重新生成。`, {
            summary: "角色照片生成失败",
            progress: 0.38,
            stage: "plan_characters",
          });
        }
      }
      if (referencesChanged) {
        // 参考图换了，之前基于旧参考图算出的镜头结论全部作废
        await deps.db
          .update(schema.shots)
          .set({ consistencyResult: null })
          .where(eq(schema.shots.projectId, projectId));
      }
      if (failures.length > 0) {
        throw new Error(
          `角色照片生成失败：${failures.join("、")}。请稍后重试，已成功的角色照片会保留。`,
        );
      }
    },

    createShot: async (shot: {
      order: number;
      description: string;
      camera?: string;
      dialogue?: string;
      action?: string;
      scene?: string;
      lighting?: string;
      prompt?: string;
      imagePrompt?: string;
      duration?: number;
      motionNote?: string;
    }) => {
      console.log(`[processor:db] Creating shot: order=${shot.order}`);
      const imagePrompt =
        shot.imagePrompt || buildShotImagePrompt(shot, latestVisualBible, project?.style);
      const videoPrompt = shot.prompt || buildShotVideoPrompt(shot, imagePrompt);
      const characterIds = matchCharacterIds(
        [shot.description, shot.scene, shot.action, shot.dialogue, shot.prompt, shot.imagePrompt]
          .filter(Boolean)
          .join(" "),
        await currentCharacters(),
      );
      const [existing] = await deps.db
        .select()
        .from(schema.shots)
        .where(and(eq(schema.shots.projectId, projectId), eq(schema.shots.order, shot.order)))
        .limit(1);

      if (existing) {
        const [updated] = await deps.db
          .update(schema.shots)
          .set({
            description: shot.description,
            prompt: videoPrompt,
            imagePrompt,
            camera: shot.camera || null,
            dialogue: shot.dialogue || null,
            action: shot.action || null,
            scene: shot.scene || null,
            lighting: shot.lighting || null,
            motionNote: shot.motionNote || null,
            duration: shot.duration || existing.duration || 5,
            characterIds: characterIds.length ? characterIds : existing.characterIds,
            updatedAt: new Date(),
          })
          .where(eq(schema.shots.id, existing.id))
          .returning();

        if (updated) {
          deps.wsGateway.sendToProject(projectId, "shot_updated", { shot: toShotDto(updated) });
        }

        return updated || existing;
      }

      const [record] = await deps.db
        .insert(schema.shots)
        .values({
          projectId,
          order: shot.order,
          description: shot.description,
          prompt: videoPrompt,
          imagePrompt,
          camera: shot.camera || null,
          dialogue: shot.dialogue || null,
          action: shot.action || null,
          scene: shot.scene || null,
          lighting: shot.lighting || null,
          motionNote: shot.motionNote || null,
          duration: shot.duration || 5,
          characterIds,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
      if (record) {
        // Send full Shot record via WS
        deps.wsGateway.sendToProject(projectId, "shot_created", {
          shot: toShotDto(record),
        });
      }
      return record || { id: 0 };
    },

    generateShotFrames: async () => {
      console.log(`[processor] Generating shot frames for project ${projectId}`);
      await assertRunActive();
      const shots = await deps.db
        .select()
        .from(schema.shots)
        .where(eq(schema.shots.projectId, projectId))
        .orderBy(asc(schema.shots.order));

      const failures: number[] = [];
      for (const shot of shots) {
        await assertRunActive();
        if (shot.imageUrl) continue;
        const imagePrompt =
          shot.imagePrompt || buildShotImagePrompt(shot, latestVisualBible, project?.style);
        try {
          const imageUrl = await deps.imageService.generateImage(imagePrompt);
          const [updated] = await deps.db
            .update(schema.shots)
            .set({
              imagePrompt,
              imageUrl,
              consistencyResult: null,
              updatedAt: new Date(),
            })
            .where(eq(schema.shots.id, shot.id))
            .returning();

          if (updated) {
            deps.wsGateway.sendToProject(projectId, "shot_updated", { shot: toShotDto(updated) });
          }
        } catch (err) {
          console.warn(`[processor] Shot frame generation failed for #${shot.order}:`, err);
          failures.push(shot.order);
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `分镜帧生成失败：镜头 ${failures.join("、")}。请稍后重试，已成功的分镜帧会保留。`,
        );
      }

      // 镜头图刚刚定稿，立刻基于当前参考图跑一次一致性校验。
      // 这段不能抛错：人脸服务未就绪或图片下载失败都不该拖垮生成流水线。
      const consistency = await deps.post.autoCheckConsistency(projectId);

      // 检出漂移后接着自动修：按绑定的角色参考图重画一次，再复检。
      // 预算、图像服务可用性、单个镜头失败都在方法内兜住，不影响后续视频阶段。
      if (consistency) {
        await deps.post.autoRepairDriftedShots(projectId, consistency);
      }

      // 人脸合格不等于画面合格：手画歪、画风跑偏、构图切头，只有把图喂给
      // 视觉模型才看得出来。放在修复之后，审的就是最终要拿去生成视频的那版。
      await deps.post.critiqueKeyframes(projectId);
    },

    generateShotVideos: async () => {
      console.log(`[processor] Generating shot videos for project ${projectId}`);
      await assertRunActive();
      const shots = await deps.db
        .select()
        .from(schema.shots)
        .where(eq(schema.shots.projectId, projectId))
        .orderBy(asc(schema.shots.order));

      const failures: number[] = [];
      for (const shot of shots) {
        await assertRunActive();
        if (shot.videoUrl && isPlayableVideoUrl(shot.videoUrl)) continue;
        const prompt =
          shot.prompt || buildShotVideoPrompt(shot, shot.imagePrompt || shot.description);
        try {
          const videoUrl = await deps.videoService.generateVideo(prompt, {
            imageUrl: shot.imageUrl,
            duration: shot.duration,
          });
          const [updated] = await deps.db
            .update(schema.shots)
            .set({
              prompt,
              videoUrl,
              updatedAt: new Date(),
            })
            .where(eq(schema.shots.id, shot.id))
            .returning();

          if (updated) {
            deps.wsGateway.sendToProject(projectId, "shot_updated", { shot: toShotDto(updated) });
          }
        } catch (err) {
          console.warn(`[processor] Shot video generation failed for #${shot.order}:`, err);
          failures.push(shot.order);
          await deps.db
            .update(schema.shots)
            .set({ videoUrl: null, updatedAt: new Date() })
            .where(eq(schema.shots.id, shot.id));
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `镜头视频生成失败：镜头 ${failures.join("、")}。请检查视频额度或稍后重试，已成功的视频会保留。`,
        );
      }
    },

    composeProjectVideo: async () => {
      console.log(`[processor] Composing final output for project ${projectId}`);
      await assertRunActive();
      const shots = await deps.db
        .select()
        .from(schema.shots)
        .where(eq(schema.shots.projectId, projectId))
        .orderBy(asc(schema.shots.order));
      const missing = shots.filter((shot) => !shot.videoUrl || !isPlayableVideoUrl(shot.videoUrl));
      if (missing.length > 0) {
        throw new Error(`还有 ${missing.length} 个镜头视频未完成，无法合成最终输出。`);
      }
      const clipUrls = shots
        .map((shot) => shot.videoUrl)
        .filter((url): url is string => Boolean(url));
      // 角色描述用于推断音色（少女/老妇/少年），没有则退回按名字判定
      const characters = await deps.db
        .select()
        .from(schema.characters)
        .where(eq(schema.characters.projectId, projectId));
      const characterDescriptions = Object.fromEntries(
        characters.map((character) => [
          character.name,
          [character.description, character.visualNotes].filter(Boolean).join(" "),
        ]),
      );
      const videoUrl =
        clipUrls.length > 0
          ? await deps.videoService.composeVideo(projectId, clipUrls, {
              dialogues: shots.map((shot) => shot.dialogue),
              characterDescriptions,
            })
          : null;

      await deps.db
        .update(schema.projects)
        .set({
          videoUrl,
          status: videoUrl ? "completed" : "draft",
          updatedAt: new Date(),
        })
        .where(eq(schema.projects.id, projectId));

      deps.wsGateway.sendToProject(projectId, "project_updated", {
        video_url: videoUrl,
        status: videoUrl ? "completed" : "draft",
      });
    },
  };

  return {
    ctx,
    currentOutline: () => latestOutline,
    currentVisualBible: () => latestVisualBible,
  };
}
