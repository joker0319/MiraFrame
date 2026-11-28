import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { REDIS_SUBSCRIBER } from "../redis";
import { DRIZZLE, type Db } from "../db";
import { WsGateway } from "../ws";
import {
  ImageService,
  TextService,
  VideoService,
  ConsistencyService,
  ShotRepairService,
  KeyframeCriticService,
} from "../services";
import { buildPhase2Graph, createCheckpointer, runWithNodeContext } from "@miraframe/agent";
import type { StoryOutline } from "@miraframe/shared";
import { Command, INTERRUPT, isInterrupted } from "@langchain/langgraph";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { schema } from "../db";
import type { GenerationInput } from "./agent.service";
import {
  buildInitialState,
  buildProjectContext,
  buildConversationHistory,
} from "./agent-run-state";
import type { LineageCharacter } from "./lineage";
import { ConversationMemoryService } from "./conversation-memory.service";
import { createPostProcessing } from "./processor/post-processing";
import { createAgentContext } from "./processor/agent-context";
import { waitForConfirm } from "./processor/gate";

@Processor("generation", { concurrency: 8 })
@Injectable()
export class AgentProcessor extends WorkerHost {
  constructor(
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
      .select({ status: schema.agentRuns.status, progress: schema.agentRuns.progress })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, runId));
    if (run && run.status !== "running" && run.status !== "queued") {
      console.log(`[processor] Skipping run=${runId}; status=${run.status}`);
      return;
    }

    /**
     * 取消不再是「只在门口等消息」。
     *
     * 之前 cancelGeneration 只是往 Redis 发一条消息，只有正卡在 waitForConfirm
     * 的 job 收得到；正在跑 LLM / 逐个出视频的 job 完全听不见，最后还会把
     * cancelled 覆盖成 succeeded。这里在节点边界和逐镜循环里查一次库，
     * 把「取消」变成可抢占的协作式中断。
     */
    const readRunStatus = async (): Promise<string | null> => {
      const [row] = await this.db
        .select({ status: schema.agentRuns.status })
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, runId));
      return row?.status ?? null;
    };
    const assertRunActive = async (): Promise<void> => {
      const status = await readRunStatus();
      if (status && status !== "running" && status !== "queued") {
        throw new RunCancelledError(`run ${runId} 已处于 ${status}，停止执行`);
      }
    };

    const post = createPostProcessing({
      db: this.db,
      wsGateway: this.wsGateway,
      config: this.config,
      consistencyService: this.consistencyService,
      shotRepair: this.shotRepair,
      keyframeCritic: this.keyframeCritic,
    });

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
    // 必须是「最近 120 条」，不是「最早 120 条」。
    // 之前按 asc + limit 取，项目消息一多就永远只看到最初几轮：
    // 新反馈进不了历史，滚动摘要也停在早期，用户说的「改回第一版」重新变成无指代。
    const recentHistoryRows = await this.db
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
      .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
      .limit(120);
    // 倒序只是取窗口的手段；摘要与 prompt 都要求时间正序。
    const historyRows = recentHistoryRows.reverse();
    const memory = await this.memoryService.ensure(projectId, historyRows, {
      excludeLatestUser: Boolean(job.data.feedback),
    });
    const conversationHistory = buildConversationHistory(historyRows, {
      excludeLatestUser: Boolean(job.data.feedback),
      memorySummary: memory.summary,
      coveredThroughId: memory.coveredThroughId,
    });
    const contextBlock = conversationHistory
      ? `${projectContext}\n\n${conversationHistory}`
      : projectContext;
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

    const { ctx, currentOutline, currentVisualBible } = createAgentContext({
      projectId,
      runId,
      threadId,
      db: this.db,
      wsGateway: this.wsGateway,
      textService: this.textService,
      imageService: this.imageService,
      videoService: this.videoService,
      project,
      contextBlock,
      initialOutline: (project?.storyOutline as StoryOutline | null) || null,
      initialVisualBible: project?.visualBible || null,
      initialProgress: run?.progress ?? 0,
      currentCharacters,
      assertRunActive,
      post,
    });

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
            // 取消可能发生在上一轮节点执行期间；别等到下一个门才发现
            await assertRunActive();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await compiled.invoke(graphInput as any, config);

            // 节点可能跑了很久（出图/出视频），返回后再确认一次，
            // 避免取消后仍然写 awaiting_gate、继续等 30 分钟。
            await assertRunActive();

            // Check for interrupts using LangGraph.js v1.x API
            if (isInterrupted(result)) {
              const interruptData = result[INTERRUPT] as Array<{ value: unknown }>;
              const interruptValue = interruptData?.[0]?.value as
                | Record<string, unknown>
                | undefined;
              const gate = (interruptValue?.gate as string) || "unknown";
              const question = (interruptValue?.question as string) || "Continue?";

              console.log(`[processor] ⏸ Interrupted at gate="${gate}" question="${question}"`);

              // Persist the gate so the frontend can restore the confirm UI after a refresh
              await this.db
                .update(schema.agentRuns)
                .set({ awaitingGate: gate, updatedAt: new Date() })
                .where(eq(schema.agentRuns.id, runId));

              // Get the current stage from state for the WS event
              const currentStageValue = String(
                (result as Record<string, unknown>).currentStage || "plan_outline",
              );

              this.wsGateway.sendToProject(projectId, "run_awaiting_confirm", {
                run_id: runId,
                project_id: projectId,
                agent: agentForGate(gate),
                gate,
                current_stage: currentStageValue,
                question,
                auto_mode: job.data.autoMode || false,
                ...(gate === "outline_approval" && currentOutline()
                  ? {
                      story_outline: currentOutline() ?? undefined,
                      visual_bible: currentVisualBible(),
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
                confirmed = await waitForConfirm(this.redisSub, projectId, runId, 30 * 60 * 1000);
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
                    story_outline: currentOutline(),
                    visual_bible: currentVisualBible(),
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

              // 条件更新：只有仍然 active 的 run 才能变成 succeeded。
              // 否则可能出现「用户已经取消，worker 跑完后又把状态改回成功」。
              const finished = await this.db
                .update(schema.agentRuns)
                .set({
                  status: "succeeded",
                  progress: 1.0,
                  awaitingGate: null,
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(schema.agentRuns.id, runId),
                    inArray(schema.agentRuns.status, ["queued", "running"]),
                  ),
                )
                .returning({ id: schema.agentRuns.id });

              if (finished.length === 0) {
                console.log(`[processor] Run ${runId} 已被取消，丢弃本次完成事件`);
                isComplete = true;
                return;
              }

              this.wsGateway.sendToProject(projectId, "run_completed", {
                run_id: runId,
                project_id: projectId,
                message: "全部完成：最终视频已合成",
              });
            }
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const currentStatus = await readRunStatus().catch(() => null);

            // 协作式取消不是失败：状态已经是 cancelled 时只收尾，别发 run_failed，
            // 也别把 cancelled 覆盖成 failed。
            if (error instanceof RunCancelledError || currentStatus === "cancelled") {
              console.log(`[processor] Run ${runId} 已取消，停止当前 job`);
              await this.db
                .update(schema.agentRuns)
                .set({ status: "cancelled", awaitingGate: null, updatedAt: new Date() })
                .where(
                  and(
                    eq(schema.agentRuns.id, runId),
                    inArray(schema.agentRuns.status, ["queued", "running"]),
                  ),
                );
              return;
            }

            console.error(`[processor] ✗ Error in step ${stepCount}: ${errorMessage}`);
            if (error instanceof Error && error.stack) {
              console.error(`[processor] Stack:`, error.stack.substring(0, 500));
            }

            await this.db
              .update(schema.agentRuns)
              .set({
                status: "failed",
                error: errorMessage,
                awaitingGate: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(schema.agentRuns.id, runId),
                  inArray(schema.agentRuns.status, ["queued", "running"]),
                ),
              );

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
}

/**
 * 协作式取消信号。用独立类型而不是普通 Error，是为了让 catch 能区分
 * 「用户取消」和「真的失败了」——两者对 DB 状态和 WS 事件的处理完全不同。
 */
class RunCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCancelledError";
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
