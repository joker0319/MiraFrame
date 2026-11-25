import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { REDIS_CLIENT, REDIS_SUBSCRIBER } from "../redis";
import { DRIZZLE, type Db } from "../db";
import { WsGateway } from "../ws";
import { ImageService, TextService, VideoService, ConsistencyService, ShotRepairService, KeyframeCriticService, createImageEnvReader } from "../services";
import type { ConsistencyRun } from "../services/consistency";
import { collectRepairReferences } from "../services/shot-repair.service";
import { isImageRepairAvailable, planAutoRepair, readAutoRepairConfig, runAutoRepair, worstDistanceOf } from "../services/auto-repair";
import { buildPhase2Graph, createCheckpointer, runWithNodeContext } from "@miraframe/agent";
import type { LlmChatMessage, ToolDefinition, CritiqueReport } from "@miraframe/agent";
import { Command, INTERRUPT, isInterrupted } from "@langchain/langgraph";
import { and, asc, eq } from "drizzle-orm";
import { schema } from "../db";
import type { GenerationInput } from "./agent.service";
import { buildInitialState, buildProjectContext, buildConversationHistory } from "./agent-run-state";
import { buildArtifactLineage, matchCharacterIds, type LineageCharacter } from "./lineage";
import { toCritiqueResultPayload } from "./critique-payload";
import { ConversationMemoryService } from "./conversation-memory.service";

/** 一致性检查的产物，检测与自动修复共用，避免二次查库。 */
interface ConsistencySnapshot {
  run: ConsistencyRun;
  shots: Array<{ id: number; order: number; imageUrl: string | null; characterIds: number[] | null }>;
  characters: Array<{
    id: number;
    name: string;
    imageUrl: string | null;
    referenceImages: string[] | null;
  }>;
}

@Processor("generation", { concurrency: 8 })
@Injectable()
export class AgentProcessor extends WorkerHost {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(REDIS_SUBSCRIBER) private readonly redisSub: Redis,
	    @Inject(DRIZZLE) private readonly db: Db,
	    @Inject(WsGateway) private readonly wsGateway: WsGateway,
	    @Inject(TextService) private readonly textService: TextService,
	    @Inject(ImageService) private readonly imageService: ImageService,
	    @Inject(VideoService) private readonly videoService: VideoService,
	    @Inject(ConsistencyService) private readonly consistencyService: ConsistencyService,
	    @Inject(ShotRepairService) private readonly shotRepair: ShotRepairService,
	    @Inject(KeyframeCriticService) private readonly keyframeCritic: KeyframeCriticService,
	    @Inject(ConfigService) private readonly config: ConfigService,
	    @Inject(ConversationMemoryService) private readonly memoryService: ConversationMemoryService,
	  ) {
    super();
  }

  async process(job: Job<GenerationInput>): Promise<void> {
    const { projectId, runId, threadId } = job.data;
    console.log(`[processor] === Starting generation job ===`);
    console.log(`[processor] projectId=${projectId} runId=${runId} threadId=${threadId}`);

    const [run] = await this.db
      .select({ status: schema.agentRuns.status })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, runId));
    if (run && run.status !== "running" && run.status !== "queued") {
      console.log(`[processor] Skipping run=${runId}; status=${run.status}`);
      return;
    }

    // Build the graph with checkpointer
    console.log(`[processor] Building graph...`);
    const graph = buildPhase2Graph();
    // checkpoint 落 PostgreSQL：重启后同一个 job 被重新拾起时，从已完成节点继续
    const checkpointer = await createCheckpointer(this.config.get<string>("app.databaseUrl"));
    const compiled = graph.compile({ checkpointer });
    console.log(`[processor] Graph compiled with ${Object.keys(graph).length} nodes`);

    const config = { configurable: { thread_id: threadId } };
    const [project] = await this.db
      .select({
        title: schema.projects.title,
        story: schema.projects.story,
        style: schema.projects.style,
        targetShotCount: schema.projects.targetShotCount,
        storyOutline: schema.projects.storyOutline,
        visualBible: schema.projects.visualBible,
      })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));

    const projectContext = buildProjectContext(projectId, project, job.data);

    // ---- 历史对话上下文 ----
    // messages 表此前只写不读，导致用户的第二轮反馈（"改回第一版但保留结尾"）
    // 对模型来说是一句没有指代对象的话。这里读回最近消息并配对成轮次；
    // 滑出保留窗口的旧轮次先折叠成滚动摘要，再注入 prompt。
    const historyRows = await this.db
      .select({
        id: schema.messages.id,
        agent: schema.messages.agent,
        role: schema.messages.role,
        content: schema.messages.content,
        summary: schema.messages.summary,
        createdAt: schema.messages.createdAt,
      })
      .from(schema.messages)
      .where(eq(schema.messages.projectId, projectId))
      .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id))
      .limit(120);
    const memory = await this.memoryService.ensure(projectId, historyRows, {
      excludeLatestUser: Boolean(job.data.feedback),
    });
    const conversationHistory = buildConversationHistory(historyRows, {
      excludeLatestUser: Boolean(job.data.feedback),
      memorySummary: memory.summary,
      coveredThroughId: memory.coveredThroughId,
    });
    const contextBlock = conversationHistory ? `${projectContext}\n\n${conversationHistory}` : projectContext;
    if (conversationHistory) {
      console.log(
        `[processor] 注入历史对话 ${conversationHistory.length} chars（摘要 ${memory.summary.length} 字，覆盖 ${memory.coveredTurns} 轮）`,
      );
    }

    // 角色是在 plan_characters 节点里才创建的，run 开头查一定为空 → 惰性加载，
    // 首次调用发生在 plan_shots，此时角色已经落库。
    let characterCache: LineageCharacter[] | null = null;
    const currentCharacters = async (): Promise<LineageCharacter[]> => {
      if (!characterCache) {
        characterCache = await this.db
          .select({ id: schema.characters.id, name: schema.characters.name })
          .from(schema.characters)
          .where(eq(schema.characters.projectId, projectId))
          .orderBy(asc(schema.characters.id));
      }
      return characterCache;
    };

    let latestOutline: Record<string, unknown> | null = project?.storyOutline || null;
    let latestVisualBible: string | null = project?.visualBible || null;

    // ---- Build the REAL agent context ----
    const ctx = {
      projectId,
      runId,
      threadId,
      sendMessage: async (content: string, opts?: { summary?: string; progress?: number; isLoading?: boolean; stage?: string }) => {
        console.log(`[processor:msg] content="${content.substring(0, 80)}..." progress=${opts?.progress ?? "N/A"} stage=${opts?.stage ?? "N/A"}`);
        try {
          await this.db.insert(schema.messages).values({
            projectId,
            runId,
            agent: "system",
            role: "assistant",
            content,
            summary: opts?.summary || null,
            progress: opts?.progress || null,
            isLoading: opts?.isLoading || false,
            createdAt: new Date(),
          });
        } catch (dbErr) {
          console.error(`[processor:msg] DB insert failed:`, dbErr);
        }

        // Send run_message for chat panel
        this.wsGateway.sendToProject(projectId, "run_message", {
          agent: "system",
          role: "assistant",
          content,
          summary: opts?.summary,
          progress: opts?.progress,
          isLoading: opts?.isLoading,
        });

        // Also send run_progress for pipeline stage tracking
        if (opts?.progress !== undefined || opts?.stage) {
          const stage = opts?.stage || "plan_outline";
          // Map stage to progress value (matching old project's workflow_progress_for_stage)
          this.wsGateway.sendToProject(projectId, "run_progress", {
            run_id: runId,
            project_id: projectId,
            current_agent: "system",
            current_stage: stage,
            stage,
            progress: opts?.progress || 0,
          });

          await this.db
            .update(schema.agentRuns)
            .set({ progress: opts.progress ?? 0, currentAgent: stage, updatedAt: new Date() })
            .where(eq(schema.agentRuns.id, runId));
        }
      },

      sendThinking: async (phase: string, content: string, details?: string) => {
        console.log(`[processor:thinking] phase="${phase}" content="${content.substring(0, 60)}..."`);
        this.wsGateway.sendToProject(projectId, "agent_thinking", {
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
        this.wsGateway.sendToProject(projectId, "critique_result", toCritiqueResultPayload(report));
      },

      callLlm: async (systemPrompt: string, userPrompt: string, opts?: { maxTokens?: number }) => {
        console.log(`[processor:llm] Calling LLM...`);
        console.log(`[processor:llm] systemPrompt (first 120 chars): ${systemPrompt.substring(0, 120)}`);
        console.log(`[processor:llm] userPrompt (first 120 chars): ${userPrompt.substring(0, 120)}`);
        try {
          const promptWithProject = `${contextBlock}\n\nTask:\n${userPrompt}`;
          const result = await this.textService.generate(promptWithProject, {
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
        console.log(`[processor:llm:tools] tools=${tools.map((t) => t.name).join(",")} messages=${messages.length}`);
        let injected = false;
        const withContext = messages.map((message) => {
          if (!injected && message.role === "user") {
            injected = true;
            return { ...message, content: `${contextBlock}\n\nTask:\n${message.content}` };
          }
          return message;
        });
        return this.textService.generateWithTools(withContext, tools, opts);
      },

      /** 从数据库读取持久化血缘，跨 run 有效（LangGraph state 做不到） */
      getArtifactLineage: async () => {
        const rows = await this.db
          .select({ id: schema.shots.id, characterIds: schema.shots.characterIds })
          .from(schema.shots)
          .where(eq(schema.shots.projectId, projectId));
        return buildArtifactLineage(rows);
      },

      saveOutline: async (outline: Record<string, unknown>, visualBible?: string | null) => {
        console.log(`[processor:db] Saving story outline`);
        latestOutline = outline;
        latestVisualBible = visualBible || null;
        await this.db
          .update(schema.projects)
          .set({
            storyOutline: outline,
            visualBible: visualBible || null,
            updatedAt: new Date(),
          })
          .where(eq(schema.projects.id, projectId));

        this.wsGateway.sendToProject(projectId, "outline_updated", {
          project_id: projectId,
          story_outline: outline,
          visual_bible: visualBible || null,
          outline_approved: false,
        });
      },

      createCharacter: async (char: { name: string; description: string }) => {
        console.log(`[processor:db] Creating character: "${char.name}"`);
        const [existing] = await this.db
          .select()
          .from(schema.characters)
          .where(and(eq(schema.characters.projectId, projectId), eq(schema.characters.name, char.name)))
          .orderBy(asc(schema.characters.id))
          .limit(1);

        if (existing) {
          const [updated] = await this.db
            .update(schema.characters)
            .set({
              description: char.description || existing.description,
              updatedAt: new Date(),
            })
            .where(eq(schema.characters.id, existing.id))
            .returning();

          if (updated) {
            this.wsGateway.sendToProject(projectId, "character_updated", {
              character: toCharacterPayload(updated),
            });
          }

          return updated || existing;
        }

        const [record] = await this.db
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
          this.wsGateway.sendToProject(projectId, "character_created", {
            character: {
              id: record.id,
              project_id: projectId,
              name: record.name,
              description: record.description,
              image_url: record.imageUrl,
              reference_images: record.referenceImages,
              visual_notes: record.visualNotes,
              approval_state: "draft",
              approval_version: record.approvalVersion || 0,
            },
          });
        }
        return record || { id: 0 };
      },

      generateCharacterImage: async () => {
        console.log(`[processor] Generating character images for project ${projectId}`);
        await ctx.sendMessage("正在生成角色人物照片...", {
          summary: "角色照片生成中",
          progress: 0.38,
          stage: "plan_characters",
        });

        const characters = await this.db
          .select()
          .from(schema.characters)
          .where(eq(schema.characters.projectId, projectId))
          .orderBy(asc(schema.characters.id));

        const failures: string[] = [];
        let referencesChanged = false;
        for (const character of characters) {
          if (character.imageUrl) continue;
          const prompt = [
            `Create a polished character portrait for an AI comic/drama project.`,
            `Project style: ${project?.style || "anime"}.`,
            `Character name: ${character.name}.`,
            `Character description: ${character.description || ""}`,
            `Visual bible: ${latestVisualBible || "clean, consistent character design, expressive face, full body reference"}.`,
          ].join("\n");

          try {
            const imageUrl = await this.imageService.generateImage(prompt);
            const [updated] = await this.db
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
              this.wsGateway.sendToProject(projectId, "character_updated", {
                character: toCharacterPayload(updated),
              });
            }
          } catch (err) {
            console.warn(`[processor] Character image generation failed for "${character.name}":`, err);
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
          await this.db
            .update(schema.shots)
            .set({ consistencyResult: null })
            .where(eq(schema.shots.projectId, projectId));
        }
        if (failures.length > 0) {
          throw new Error(`角色照片生成失败：${failures.join("、")}。请稍后重试，已成功的角色照片会保留。`);
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
	        const imagePrompt = shot.imagePrompt || buildShotImagePrompt(shot, latestVisualBible, project?.style);
	        const videoPrompt = shot.prompt || buildShotVideoPrompt(shot, imagePrompt);
	        const characterIds = matchCharacterIds(
	          [shot.description, shot.scene, shot.action, shot.dialogue, shot.prompt, shot.imagePrompt]
	            .filter(Boolean)
	            .join(" "),
	          await currentCharacters(),
	        );
	        const [existing] = await this.db
	          .select()
	          .from(schema.shots)
	          .where(and(eq(schema.shots.projectId, projectId), eq(schema.shots.order, shot.order)))
	          .limit(1);

	        if (existing) {
	          const [updated] = await this.db
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
	            this.wsGateway.sendToProject(projectId, "shot_updated", { shot: toShotPayload(updated) });
	          }

	          return updated || existing;
	        }

	        const [record] = await this.db
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
          this.wsGateway.sendToProject(projectId, "shot_created", {
            shot: {
              id: record.id,
              project_id: projectId,
              order: record.order,
              description: record.description,
              camera: record.camera,
              scene: record.scene,
              action: record.action,
              dialogue: record.dialogue,
              image_url: record.imageUrl,
              video_url: record.videoUrl,
              duration: record.duration,
              prompt: record.prompt,
              image_prompt: record.imagePrompt,
              approval_state: "draft",
              approval_version: record.approvalVersion || 0,
            },
          });
        }
	        return record || { id: 0 };
	      },

	      generateShotFrames: async () => {
	        console.log(`[processor] Generating shot frames for project ${projectId}`);
	        const shots = await this.db
	          .select()
	          .from(schema.shots)
	          .where(eq(schema.shots.projectId, projectId))
	          .orderBy(asc(schema.shots.order));

	        const failures: number[] = [];
	        for (const shot of shots) {
	          if (shot.imageUrl) continue;
	          const imagePrompt = shot.imagePrompt || buildShotImagePrompt(shot, latestVisualBible, project?.style);
	          try {
	            const imageUrl = await this.imageService.generateImage(imagePrompt);
	            const [updated] = await this.db
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
	              this.wsGateway.sendToProject(projectId, "shot_updated", { shot: toShotPayload(updated) });
	            }
	          } catch (err) {
	            console.warn(`[processor] Shot frame generation failed for #${shot.order}:`, err);
	            failures.push(shot.order);
	          }
	        }
        if (failures.length > 0) {
          throw new Error(`分镜帧生成失败：镜头 ${failures.join("、")}。请稍后重试，已成功的分镜帧会保留。`);
        }

        // 镜头图刚刚定稿，立刻基于当前参考图跑一次一致性校验。
        // 这段不能抛错：人脸服务未就绪或图片下载失败都不该拖垮生成流水线。
        const consistency = await this.autoCheckConsistency(projectId);

        // 检出漂移后接着自动修：按绑定的角色参考图重画一次，再复检。
        // 预算、图像服务可用性、单个镜头失败都在方法内兜住，不影响后续视频阶段。
        if (consistency) {
          await this.autoRepairDriftedShots(projectId, consistency);
        }

        // 人脸合格不等于画面合格：手画歪、画风跑偏、构图切头，只有把图喂给
        // 视觉模型才看得出来。放在修复之后，审的就是最终要拿去生成视频的那版。
        await this.critiqueKeyframes(projectId);
      },

	      generateShotVideos: async () => {
	        console.log(`[processor] Generating shot videos for project ${projectId}`);
	        const shots = await this.db
	          .select()
	          .from(schema.shots)
	          .where(eq(schema.shots.projectId, projectId))
	          .orderBy(asc(schema.shots.order));

	        const failures: number[] = [];
	        for (const shot of shots) {
	          if (shot.videoUrl && isPlayableVideoUrl(shot.videoUrl)) continue;
	          const prompt = shot.prompt || buildShotVideoPrompt(shot, shot.imagePrompt || shot.description);
	          try {
	            const videoUrl = await this.videoService.generateVideo(prompt, {
	              imageUrl: shot.imageUrl,
	              duration: shot.duration,
	            });
	            const [updated] = await this.db
	              .update(schema.shots)
	              .set({
	                prompt,
	                videoUrl,
	                updatedAt: new Date(),
	              })
	              .where(eq(schema.shots.id, shot.id))
	              .returning();

	            if (updated) {
	              this.wsGateway.sendToProject(projectId, "shot_updated", { shot: toShotPayload(updated) });
	            }
	          } catch (err) {
	            console.warn(`[processor] Shot video generation failed for #${shot.order}:`, err);
	            failures.push(shot.order);
	            await this.db
	              .update(schema.shots)
	              .set({ videoUrl: null, updatedAt: new Date() })
	              .where(eq(schema.shots.id, shot.id));
	          }
	        }
	        if (failures.length > 0) {
	          throw new Error(`镜头视频生成失败：镜头 ${failures.join("、")}。请检查视频额度或稍后重试，已成功的视频会保留。`);
	        }
	      },

	      composeProjectVideo: async () => {
	        console.log(`[processor] Composing final output for project ${projectId}`);
	        const shots = await this.db
	          .select()
	          .from(schema.shots)
	          .where(eq(schema.shots.projectId, projectId))
	          .orderBy(asc(schema.shots.order));
	        const missing = shots.filter((shot) => !shot.videoUrl || !isPlayableVideoUrl(shot.videoUrl));
	        if (missing.length > 0) {
	          throw new Error(`还有 ${missing.length} 个镜头视频未完成，无法合成最终输出。`);
	        }
        const clipUrls = shots.map((shot) => shot.videoUrl).filter((url): url is string => Boolean(url));
        // 角色描述用于推断音色（少女/老妇/少年），没有则退回按名字判定
        const characters = await this.db
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
            ? await this.videoService.composeVideo(projectId, clipUrls, {
                dialogues: shots.map((shot) => shot.dialogue),
                characterDescriptions,
              })
            : null;

	        await this.db
	          .update(schema.projects)
	          .set({
	            videoUrl,
	            status: videoUrl ? "completed" : "draft",
	            updatedAt: new Date(),
	          })
	          .where(eq(schema.projects.id, projectId));

	        this.wsGateway.sendToProject(projectId, "project_updated", {
	          video_url: videoUrl,
	          status: videoUrl ? "completed" : "draft",
	        });
	      },

	    };

    const initialState = buildInitialState(job.data);

    try {
      // 只靠 ALS 传递上下文：同一 worker 并发跑多个 job 时各自独立，不共享可变全局。
      await runWithNodeContext(ctx, async () => {
      console.log(`[processor] Invoking graph with initial state...`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let graphInput: any = initialState;
      let isComplete = false;
      let stepCount = 0;

      while (!isComplete && stepCount < 50) {
        stepCount++;
        console.log(`[processor] Step ${stepCount}: invoking graph...`);

        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await compiled.invoke(graphInput as any, config);

          // Check for interrupts using LangGraph.js v1.x API
          if (isInterrupted(result)) {
            const interruptData = result[INTERRUPT] as Array<{ value: unknown }>;
            const interruptValue = interruptData?.[0]?.value as Record<string, unknown> | undefined;
            const gate = (interruptValue?.gate as string) || "unknown";
            const question = (interruptValue?.question as string) || "Continue?";

            console.log(`[processor] ⏸ Interrupted at gate="${gate}" question="${question}"`);

            // Persist the gate so the frontend can restore the confirm UI after a refresh
            await this.db
              .update(schema.agentRuns)
              .set({ awaitingGate: gate, updatedAt: new Date() })
              .where(eq(schema.agentRuns.id, runId));

            // Get the current stage from state for the WS event
            const currentStageValue = (result as Record<string, unknown>).currentStage || "plan_outline";

            this.wsGateway.sendToProject(projectId, "run_awaiting_confirm", {
              run_id: runId,
              project_id: projectId,
              agent: agentForGate(gate),
              gate,
              current_stage: currentStageValue,
              question,
              auto_mode: job.data.autoMode || false,
              ...(gate === "outline_approval" && latestOutline
                ? {
                    story_outline: latestOutline,
                    visual_bible: latestVisualBible,
                  }
                : {}),
            });

            // In auto mode, auto-resume after a short delay
            const autoMode = job.data.autoMode || false;
            let confirmed: boolean;

            if (autoMode) {
              console.log(`[processor] Auto mode — auto-confirming after 1s delay`);
              await new Promise((r) => setTimeout(r, 1000));
              confirmed = true;
            } else {
              console.log(`[processor] Manual mode — waiting for confirm (30 min timeout)...`);
              confirmed = await this.waitForConfirm(projectId, runId, 30 * 60 * 1000);
            }

            if (confirmed) {
              console.log(`[processor] ✓ Resuming graph...`);
              if (gate === "outline_approval") {
                await this.db
                  .update(schema.projects)
                  .set({ outlineApproved: true, updatedAt: new Date() })
                  .where(eq(schema.projects.id, projectId));
                this.wsGateway.sendToProject(projectId, "outline_updated", {
                  project_id: projectId,
                  story_outline: latestOutline,
                  visual_bible: latestVisualBible,
                  outline_approved: true,
                });
              }
              this.wsGateway.sendToProject(projectId, "run_confirmed", {
                run_id: runId,
                project_id: projectId,
              });
              await this.db
                .update(schema.agentRuns)
                .set({ awaitingGate: null, updatedAt: new Date() })
                .where(eq(schema.agentRuns.id, runId));
              graphInput = new Command({ resume: true });
            } else {
              console.log(`[processor] ✗ Cancelled by user or timeout`);
              await this.db
                .update(schema.agentRuns)
                .set({ status: "cancelled", awaitingGate: null, updatedAt: new Date() })
                .where(eq(schema.agentRuns.id, runId));
              this.wsGateway.sendToProject(projectId, "run_cancelled", {
                run_id: runId,
                project_id: projectId,
              });
              isComplete = true;
            }
          } else {
            // No interrupt — graph completed successfully
            isComplete = true;
            console.log(`[processor] ✓ Graph completed successfully after ${stepCount} steps`);

            await this.db
              .update(schema.agentRuns)
              .set({ status: "succeeded", progress: 1.0, awaitingGate: null, updatedAt: new Date() })
              .where(eq(schema.agentRuns.id, runId));

            this.wsGateway.sendToProject(projectId, "run_completed", {
              run_id: runId,
              project_id: projectId,
              message: "全部完成：最终视频已合成",
            });
          }
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[processor] ✗ Error in step ${stepCount}: ${errorMessage}`);
          if (error instanceof Error && error.stack) {
            console.error(`[processor] Stack:`, error.stack.substring(0, 500));
          }

          await this.db
            .update(schema.agentRuns)
            .set({ status: "failed", error: errorMessage, awaitingGate: null, updatedAt: new Date() })
            .where(eq(schema.agentRuns.id, runId));

          this.wsGateway.sendToProject(projectId, "run_failed", {
            run_id: runId,
            project_id: projectId,
            error: errorMessage,
          });
          throw error;
        }
      }
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[processor] Generation FAILED for run ${runId}:`, errorMessage);
      throw error;
    } finally {
      console.log(`[processor] === Generation job finished (run=${runId}) ===`);
    }
  }

  /**
   * 镜头图生成完就自动校验角色长相，并把结论写回每个 shot。
   * 这是增强而不是关卡：人脸模型没准备好、图片下载失败都不能让生成任务失败。
   *
   * 返回这一轮的上下文，交给自动修复复用 —— 再查一遍角色和镜头只是多两次往返。
   */
  private async autoCheckConsistency(projectId: number): Promise<ConsistencySnapshot | null> {
    try {
      const [characters, shots] = await Promise.all([
        this.db
          .select()
          .from(schema.characters)
          .where(eq(schema.characters.projectId, projectId))
          .orderBy(asc(schema.characters.id)),
        this.db
          .select()
          .from(schema.shots)
          .where(eq(schema.shots.projectId, projectId))
          .orderBy(asc(schema.shots.order)),
      ]);
      if (characters.length === 0 || shots.length === 0) return null;

      const run = await this.consistencyService.analyzeAndStore({
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

      this.wsGateway.sendToProject(projectId, "consistency_eval_completed", {
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
  private async autoRepairDriftedShots(projectId: number, snapshot: ConsistencySnapshot): Promise<void> {
    const config = readAutoRepairConfig((key) => this.config.get<string>(key) ?? undefined);
    if (!config.enabled || config.maxShots <= 0) return;

    if (!isImageRepairAvailable(createImageEnvReader(this.config))) {
      console.warn(`[processor] 自动修复跳过 project=${projectId}：图像 provider 不可用（fake 或缺 key）`);
      return;
    }

    // characterIds 是主路径；只有历史数据才会只剩绑定表，这里合并一次，
    // 避免自动修复对老项目「看不见参考图」而静默跳过。
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

    const byShotId = new Map(snapshot.run.stored.map((item) => [item.shotId, item.consistencyResult]));
    const orderById = new Map(snapshot.shots.map((shot) => [shot.id, shot.order]));
    const candidates = snapshot.shots.map((shot) => {
      const result = byShotId.get(shot.id) ?? null;
      const boundIds = shot.characterIds?.length ? shot.characterIds : (boundByShot.get(shot.id) ?? []);
      const { references } = collectRepairReferences(boundIds, snapshot.characters);
      return {
        shotId: shot.id,
        order: shot.order,
        verdict: result?.verdict ?? ("unverifiable" as const),
        worstDistance: worstDistanceOf(result),
        referenceCount: references.length,
      };
    });

    const plan = planAutoRepair(candidates, config.maxShots);
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
        const result = await this.shotRepair.repairWithReferences(projectId, shotId);
        // 修复服务只改库不广播，这里补一条 shot_updated，前端不用刷新就能看到新图
        const [updated] = await this.db
          .select()
          .from(schema.shots)
          .where(eq(schema.shots.id, shotId))
          .limit(1);
        if (updated) {
          this.wsGateway.sendToProject(projectId, "shot_updated", { shot: toShotPayload(updated) });
        }
        return { shotId, references: result.references, after: result.after };
      },
      log: (message) => console.log(`[processor:auto-repair] ${message}`),
    });

    this.wsGateway.sendToProject(projectId, "consistency_repair_completed", {
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
   * 关键帧视觉审查：把画面真的交给视觉模型。
   *
   * 与 autoCheckConsistency 是互补关系而不是替代：
   * 人脸比对回答「是不是同一个人」，这里回答「这张图画得对不对」——
   * 手指数量、肢体结构、画风是否跑偏、构图有没有把主体切掉、画面里有没有乱码文字。
   *
   * 和一致性检查一样是增强而非关卡：取图失败、模型返回坏 JSON、重画失败
   * 都只记日志，绝不阻断后面的生视频。
   */
  private async critiqueKeyframes(projectId: number): Promise<void> {
    try {
      const result = await this.keyframeCritic.reviewProject(projectId);
      if (!result || !result.critique) return;

      const { critique, threshold } = result;
      const passed = critique.score >= threshold;

      this.wsGateway.sendToProject(projectId, "critique_result", {
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
        const [updated] = await this.db
          .select()
          .from(schema.shots)
          .where(eq(schema.shots.id, item.shotId))
          .limit(1);
        if (updated) {
          this.wsGateway.sendToProject(projectId, "shot_updated", { shot: toShotPayload(updated) });
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

  private waitForConfirm(projectId: number, runId: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const channel = `generation:${projectId}:${runId}`;
      console.log(`[processor:confirm] Subscribing to Redis channel "${channel}"`);

      const onMessage = (msgChannel: string, message: string) => {
        if (msgChannel === channel) {
          try {
            const data = JSON.parse(message);
            console.log(`[processor:confirm] Received message on "${channel}":`, data);
            if (data.action === "confirm") {
              clearTimeout(timer);
              this.redisSub.off("message", onMessage);
              this.redisSub.unsubscribe(channel);
              resolve(true);
            } else if (data.action === "cancel") {
              clearTimeout(timer);
              this.redisSub.off("message", onMessage);
              this.redisSub.unsubscribe(channel);
              resolve(false);
            }
          } catch {
            // ignore parse errors
          }
        }
      };

      const timer = setTimeout(() => {
        console.log(`[processor:confirm] Timeout after ${timeoutMs}ms`);
        this.redisSub.off("message", onMessage);
        this.redisSub.unsubscribe(channel);
        resolve(false);
      }, timeoutMs);

      this.redisSub.subscribe(channel, (err) => {
        if (err) {
          console.error(`[processor:confirm] Subscribe error:`, err);
          clearTimeout(timer);
          resolve(false);
          return;
        }
        console.log(`[processor:confirm] Subscribed to "${channel}"`);
      });

      this.redisSub.on("message", onMessage);
    });
  }
}

/** Map an approval gate to the frontend's awaitingAgent value. */
function agentForGate(gate: string): string {
  switch (gate) {
    case "outline_approval":
      return "outline";
    case "characters_approval":
      return "characters";
    case "shots_approval":
      return "shots";
    case "shot_images_approval":
      return "frames";
    default:
      return "system";
  }
}

type CharacterRecord = typeof schema.characters.$inferSelect;
type ShotRecord = typeof schema.shots.$inferSelect;

function toCharacterPayload(record: CharacterRecord) {
  return {
    id: record.id,
    project_id: record.projectId,
    name: record.name,
    description: record.description,
    image_url: record.imageUrl,
    reference_images: record.referenceImages,
    visual_notes: record.visualNotes,
    approval_state: "draft",
    approval_version: record.approvalVersion || 0,
  };
}

function toShotPayload(record: ShotRecord) {
  return {
    id: record.id,
    project_id: record.projectId,
    order: record.order,
    description: record.description,
    camera: record.camera,
    scene: record.scene,
    action: record.action,
    dialogue: record.dialogue,
    image_url: record.imageUrl,
    video_url: record.videoUrl,
    duration: record.duration,
    prompt: record.prompt,
    image_prompt: record.imagePrompt,
    consistency_result: record.consistencyResult,
    approval_state: "draft",
    approval_version: record.approvalVersion || 0,
  };
}

function buildShotImagePrompt(
  shot: {
    order?: number;
    description?: string | null;
    camera?: string | null;
    scene?: string | null;
    action?: string | null;
    lighting?: string | null;
  },
  visualBible?: string | null,
  style?: string | null,
): string {
  return [
    `Create a storyboard key frame for shot ${shot.order || ""}.`,
    `Style: ${style || "anime comic drama"}.`,
    visualBible ? `Visual bible: ${visualBible}.` : null,
    shot.scene ? `Scene: ${shot.scene}.` : null,
    shot.description ? `Description: ${shot.description}.` : null,
    shot.action ? `Action: ${shot.action}.` : null,
    shot.camera ? `Camera: ${shot.camera}.` : null,
    shot.lighting ? `Lighting: ${shot.lighting}.` : null,
    "Single cinematic frame, consistent character designs, production-ready composition.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildShotVideoPrompt(
  shot: {
    order?: number;
    description?: string | null;
    camera?: string | null;
    action?: string | null;
    dialogue?: string | null;
    motionNote?: string | null;
  },
  imagePrompt?: string | null,
): string {
  return [
    `Generate a short comic-drama video clip for shot ${shot.order || ""}.`,
    imagePrompt ? `Key frame prompt: ${imagePrompt}.` : null,
    shot.description ? `Story action: ${shot.description}.` : null,
    shot.action ? `Movement: ${shot.action}.` : null,
    shot.motionNote ? `Motion note: ${shot.motionNote}.` : null,
    shot.camera ? `Camera: ${shot.camera}.` : null,
    shot.dialogue ? `Dialogue context: ${shot.dialogue}.` : null,
    "Keep motion gentle, coherent, and suitable for later montage composition.",
  ]
    .filter(Boolean)
    .join("\n");
}

function isPlayableVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov)(\?|#|$)/i.test(url) || url.includes(".oss-") && url.includes(".mp4");
}
