import { interrupt } from "@langchain/langgraph";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Phase2StateType } from "../state.js";
import type { AgentContext } from "../agents/base.js";
import { OutlineAgent } from "../agents/outline.js";
import { PlanAgent } from "../agents/plan.js";
import { ComposeAgent } from "../agents/compose.js";
import { CriticAgent } from "../agents/critic.js";
import { ReviewRuleEngine } from "../agents/review.js";

// Factory to create agent instances
const outlineAgent = new OutlineAgent();
const planAgent = new PlanAgent();
const composeAgent = new ComposeAgent();
const criticAgent = new CriticAgent();
const reviewEngine = new ReviewRuleEngine();

// Module-scoped context — set by the Nest.js processor before graph execution.
let _nodeCtx: AgentContext | null = null;
const nodeContextStorage = new AsyncLocalStorage<AgentContext>();

export function runWithNodeContext<T>(ctx: AgentContext, fn: () => Promise<T>): Promise<T> {
  return nodeContextStorage.run(ctx, fn);
}

/** Call from the Nest.js AgentProcessor before invoking the graph. */
export function setNodeContext(ctx: AgentContext): void {
  _nodeCtx = ctx;
  console.log(`[agent:ctx] Context set — project=${ctx.projectId} run=${ctx.runId}`);
}

/** Call after graph execution to clean up. */
export function clearNodeContext(): void {
  _nodeCtx = null;
}

function getNodeCtx(): AgentContext {
  const storedCtx = nodeContextStorage.getStore();
  if (storedCtx) return storedCtx;
  if (_nodeCtx) return _nodeCtx;
  console.warn("[agent:ctx] WARNING — using fallback mock context. Graph output will be empty!");
  return {
    projectId: 0,
    runId: 0,
    threadId: "",
    sendMessage: async () => { void 0; },
    sendThinking: async () => { void 0; },
    callLlm: async () => {
      console.warn("[agent:ctx] MOCK callLlm called — returning {}");
      return "{}";
    },
    saveOutline: async () => { void 0; },
    createCharacter: async () => ({ id: 0 }),
    createShot: async () => ({ id: 0 }),
    generateCharacterImage: async () => { void 0; },
    generateShotFrames: async () => { void 0; },
    generateShotVideos: async () => { void 0; },
    composeProjectVideo: async () => { void 0; },
  };
}

// ── Outline node ──
export async function planOutlineNode(state: Phase2StateType): Promise<Partial<Phase2StateType>> {
  return outlineAgent.run(getNodeCtx(), state);
}

// ── Characters node (generates descriptions + images) ──
export async function planCharactersNode(state: Phase2StateType): Promise<Partial<Phase2StateType>> {
  const ctx = getNodeCtx();
  const result = await planAgent.runCharacters(ctx, state);

  // After character descriptions are created, generate character images
  await ctx.sendMessage("正在生成角色形象图...", { progress: 0.35, isLoading: true, stage: "plan_characters" });

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
export async function renderShotImagesNode(state: Phase2StateType): Promise<Partial<Phase2StateType>> {
  const ctx = getNodeCtx();
  await ctx.sendMessage("开始生成分镜帧和镜头视频...", { progress: 0.65, isLoading: true, stage: "render_shot_images" });
  await ctx.sendThinking("decision", "根据分镜脚本生成首帧画面，并由首帧生成镜头视频...");

  await ctx.generateShotFrames();
  await ctx.generateShotVideos();

  await ctx.sendMessage("镜头视频生成完成", { progress: 0.8, summary: "所有镜头视频片段已生成", stage: "render_shot_images" });

  return {
    currentStage: "render_shot_images",
    nextStage: "compose_videos",
    stageHistory: ["render_shot_images"],
    reviewRequested: false,
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
  // 🔬 临时探针：观察大纲门（新起 run 模式）会不会重跑
  console.log(">>> [门] outline_approval 进入");
  const resumeValue = interrupt({
    question: "确认故事大纲？",
    gate: "outline_approval",
  });
  console.log(">>> [门] outline_approval 拿到 resume =", JSON.stringify(resumeValue));
  return {
    approvalHistory: {
      ...(state.approvalHistory || {}),
      outline: isApprovedResume(resumeValue) ? "approved" : "rejected",
    },
  };
}

export function charactersApprovalNode(state: Phase2StateType): Partial<Phase2StateType> {
  // 🔬 临时探针：观察角色门（resume 模式）会不会重跑
  console.log(">>> [门] characters_approval 进入");
  const resumeValue = interrupt({
    question: "确认角色设定？",
    gate: "characters_approval",
  });
  console.log(">>> [门] characters_approval 拿到 resume =", JSON.stringify(resumeValue));
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

export function routeAfterOutlineApproval(state: Phase2StateType): RouteKey {
  if (state.reviewRequested) return "review";
  // If rejected, regenerate outline; if approved, move to characters
  return state.approvalHistory?.outline === "approved" ? "plan_characters" : "plan_outline";
}

export function routeAfterCharactersApproval(state: Phase2StateType): RouteKey {
  if (state.reviewRequested) return "review";
  // Characters always approved → move to shots
  return state.approvalHistory?.characters === "approved" ? "plan_shots" : "plan_characters";
}

export function routeAfterShotsApproval(state: Phase2StateType): RouteKey {
  if (state.reviewRequested) return "review";
  return state.approvalHistory?.shots === "approved" ? "render_shot_images" : "plan_shots";
}

/**
 * 自动审查之后的路由。
 * 决策本身已由 CriticAgent 写进 nextStage（模型评估 → 状态 → 路由执行），
 * 这里只负责把状态翻译成图上的目标节点，保持路由函数"纯函数"的简单性。
 */
export function routeAfterCritique(state: Phase2StateType): RouteKey {
  if (state.reviewRequested) return "review";
  return state.nextStage === "plan_shots" ? "plan_shots" : "shots_approval";
}

export function routeAfterShotImagesApproval(state: Phase2StateType): RouteKey {
  if (state.reviewRequested) return "review";
  return state.approvalHistory?.frames === "approved" ? "compose_videos" : "render_shot_images";
}

export function routeAfterReview(state: Phase2StateType): RouteKey {
  return state.routeStage || "plan_outline";
}
