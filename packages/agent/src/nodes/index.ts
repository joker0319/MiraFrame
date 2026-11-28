import { interrupt } from "@langchain/langgraph";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Phase2StateType } from "../state.js";
import type { AgentContext } from "../agents/base.js";
import { OutlineAgent } from "../agents/outline.js";
import { PlanAgent } from "../agents/plan.js";
import { ComposeAgent } from "../agents/compose.js";
import { CriticAgent } from "../agents/critic.js";
import { ReviewRuleEngine } from "../agents/review.js";
import { DirectorAgent } from "../agents/director.js";

// Factory to create agent instances
const outlineAgent = new OutlineAgent();
const planAgent = new PlanAgent();
const composeAgent = new ComposeAgent();
const criticAgent = new CriticAgent();
const reviewEngine = new ReviewRuleEngine();
const directorAgent = new DirectorAgent();

/** 图的完整生产链路：plan 的校验基准，也是"跳过阶段"时向后查找的顺序 */
const PIPELINE = [
  "plan_outline",
  "plan_characters",
  "plan_shots",
  "critique_shots",
  "render_shot_images",
  "compose_videos",
] as const;

/** 当前 run 实际执行的阶段集合。空 plan（老数据 / 恢复态）按全链路处理。 */
function activeStages(state: Phase2StateType): string[] {
  return state.executionPlan && state.executionPlan.length ? state.executionPlan : [...PIPELINE];
}

/**
 * 沿流水线向后找第一个"在计划里"的阶段。
 * 这样 Director 跳过某阶段时，门结构不用改，只是路由跳过了被裁掉的环节。
 */
function nextEnabled(state: Phase2StateType, from: string): string {
  const enabled = new Set(activeStages(state));
  const start = PIPELINE.indexOf(from as (typeof PIPELINE)[number]);
  for (let i = start + 1; i < PIPELINE.length; i++) {
    if (enabled.has(PIPELINE[i])) return PIPELINE[i];
  }
  return "compose_videos";
}

/**
 * 节点取上下文只有一个来源：AsyncLocalStorage。
 *
 * 早先这里还有一个模块级 `_nodeCtx` 兜底，配合 `setNodeContext()` 使用。
 * 但 processor 的 BullMQ worker 是 `concurrency: 8`，全局变量会被后一个 job 覆盖，
 * 于是 A 项目的节点可能拿着 B 项目的 ctx 去写库；更糟的是取不到时返回 mock ctx，
 * `callLlm` 直接吐 `"{}"`，产物静默变空、任务还显示成功。
 * 现在宁可显式报错，也不做静默降级。
 */
const nodeContextStorage = new AsyncLocalStorage<AgentContext>();

export function runWithNodeContext<T>(ctx: AgentContext, fn: () => Promise<T>): Promise<T> {
  return nodeContextStorage.run(ctx, fn);
}

function getNodeCtx(): AgentContext {
  const ctx = nodeContextStorage.getStore();
  if (!ctx) {
    throw new Error(
      "[agent:ctx] 图节点拿不到 AgentContext：图必须在 runWithNodeContext(ctx, ...) 作用域内执行。" +
        "并发场景不提供全局兜底，以免多个 job 串号。",
    );
  }
  return ctx;
}

// ── Director node (Supervisor) ──
export async function directorNode(state: Phase2StateType): Promise<Partial<Phase2StateType>> {
  // 指定阶段启动（局部重生成 / 断点重启）与已有计划（checkpoint 恢复）时，
  // 不再重新规划 —— 保证恢复机制与人工指定的路径不被模型覆盖。
  const isTargetedStart = state.currentStage && state.currentStage !== "plan_outline";
  if (isTargetedStart || (state.executionPlan && state.executionPlan.length > 0)) {
    return {};
  }
  return directorAgent.plan(getNodeCtx(), state);
}

// ── Outline node ──
export async function planOutlineNode(state: Phase2StateType): Promise<Partial<Phase2StateType>> {
  return outlineAgent.run(getNodeCtx(), state);
}

// ── Characters node (generates descriptions + images) ──
export async function planCharactersNode(
  state: Phase2StateType,
): Promise<Partial<Phase2StateType>> {
  const ctx = getNodeCtx();
  const result = await planAgent.runCharacters(ctx, state);

  // After character descriptions are created, generate character images
  await ctx.sendMessage("正在生成角色形象图...", {
    progress: 0.35,
    isLoading: true,
    stage: "plan_characters",
  });

  try {
    await ctx.generateCharacterImage();
  } catch (err) {
    console.warn("[planCharactersNode] Character image generation failed:", err);
    throw err;
  }

  await ctx.sendMessage("角色设定完成", { progress: 0.4, stage: "plan_characters" });

  return result;
}

// ── Shots node ──
export async function planShotsNode(state: Phase2StateType): Promise<Partial<Phase2StateType>> {
  return planAgent.runShots(getNodeCtx(), state);
}

// ── Critique node（LLM 自动质检，人工审批之前的一道关）──
export async function critiqueShotsNode(state: Phase2StateType): Promise<Partial<Phase2StateType>> {
  return criticAgent.critiqueShots(getNodeCtx(), state);
}

// ── Render shot images node (preview only, no interrupt) ──
export async function renderShotImagesNode(): Promise<Partial<Phase2StateType>> {
  const ctx = getNodeCtx();
  await ctx.sendMessage("开始生成分镜帧和镜头视频...", {
    progress: 0.65,
    isLoading: true,
    stage: "render_shot_images",
  });
  await ctx.sendThinking("decision", "根据分镜脚本生成首帧画面，并由首帧生成镜头视频...");

  await ctx.generateShotFrames();
  await ctx.generateShotVideos();

  await ctx.sendMessage("镜头视频生成完成", {
    progress: 0.8,
    summary: "所有镜头视频片段已生成",
    stage: "render_shot_images",
  });

  return {
    currentStage: "render_shot_images",
    nextStage: "compose_videos",
    stageHistory: ["render_shot_images"],
  };
}

// ── Compose videos node ──
export async function composeVideosNode(state: Phase2StateType): Promise<Partial<Phase2StateType>> {
  return composeAgent.runVideos(getNodeCtx(), state);
}

// ── Approval nodes (interrupt for human-in-the-loop) ──
function isApprovedResume(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.confirm === true || record.approved === true || record.action === "confirm";
}

export function outlineApprovalNode(state: Phase2StateType): Partial<Phase2StateType> {
  const resumeValue = interrupt({
    question: "确认故事大纲？",
    gate: "outline_approval",
  });
  return {
    approvalHistory: {
      ...(state.approvalHistory || {}),
      outline: isApprovedResume(resumeValue) ? "approved" : "rejected",
    },
  };
}

export function charactersApprovalNode(state: Phase2StateType): Partial<Phase2StateType> {
  const resumeValue = interrupt({
    question: "确认角色设定？",
    gate: "characters_approval",
  });
  return {
    approvalHistory: {
      ...(state.approvalHistory || {}),
      characters: isApprovedResume(resumeValue) ? "approved" : "rejected",
    },
  };
}

export function shotsApprovalNode(state: Phase2StateType): Partial<Phase2StateType> {
  const resumeValue = interrupt({
    question: "确认分镜脚本？",
    gate: "shots_approval",
  });
  return {
    approvalHistory: {
      ...(state.approvalHistory || {}),
      shots: isApprovedResume(resumeValue) ? "approved" : "rejected",
    },
  };
}

export function shotImagesApprovalNode(state: Phase2StateType): Partial<Phase2StateType> {
  const resumeValue = interrupt({
    question: "确认镜头画面？",
    gate: "shot_images_approval",
  });
  return {
    approvalHistory: {
      ...(state.approvalHistory || {}),
      frames: isApprovedResume(resumeValue) ? "approved" : "rejected",
    },
  };
}

// ── Review node ──
export async function reviewNode(state: Phase2StateType): Promise<Partial<Phase2StateType>> {
  return reviewEngine.run(getNodeCtx(), state);
}

// ── Routing functions ──
type RouteKey = string;

export function routeFromStart(state: Phase2StateType): RouteKey {
  return state.currentStage || "plan_outline";
}

/**
 * Director 之后的路由：从模型生成的执行计划里取第一个启用的阶段。
 * 这样"先走哪一步"由模型决定，而不是写死 plan_outline。
 * 恢复 / 指定阶段场景（executionPlan 为空）退回 currentStage，保证 checkpoint 续跑不变。
 */
export function routeAfterDirector(state: Phase2StateType): RouteKey {
  if (!state.executionPlan || state.executionPlan.length === 0) {
    return state.currentStage || "plan_outline";
  }
  const enabled = new Set(activeStages(state));
  return PIPELINE.find((stage) => enabled.has(stage)) || "plan_outline";
}

export function routeAfterOutlineApproval(state: Phase2StateType): RouteKey {
  // If rejected, regenerate outline; if approved, move to the next stage the Director kept
  return state.approvalHistory?.outline === "approved"
    ? nextEnabled(state, "plan_outline")
    : "plan_outline";
}

export function routeAfterCharactersApproval(state: Phase2StateType): RouteKey {
  // 角色阶段被保留时才会走到此门，之后固定进分镜（分镜是必需阶段）
  return state.approvalHistory?.characters === "approved" ? "plan_shots" : "plan_characters";
}

export function routeAfterShotsApproval(state: Phase2StateType): RouteKey {
  return state.approvalHistory?.shots === "approved" ? "render_shot_images" : "plan_shots";
}

/**
 * 自动审查之后的路由。
 * 决策本身已由 CriticAgent 写进 nextStage（模型评估 → 状态 → 路由执行），
 * 这里只负责把状态翻译成图上的目标节点，保持路由函数"纯函数"的简单性。
 */
export function routeAfterCritique(state: Phase2StateType): RouteKey {
  return state.nextStage === "plan_shots" ? "plan_shots" : "shots_approval";
}

export function routeAfterShotImagesApproval(state: Phase2StateType): RouteKey {
  return state.approvalHistory?.frames === "approved" ? "compose_videos" : "render_shot_images";
}

/** 导出供测试：Director 跳过某阶段后，下一跳是否正确 */
export function __nextEnabledForTest(state: Phase2StateType, from: string): string {
  return nextEnabled(state, from);
}

export function routeAfterReview(state: Phase2StateType): RouteKey {
  return state.routeStage || "plan_outline";
}
