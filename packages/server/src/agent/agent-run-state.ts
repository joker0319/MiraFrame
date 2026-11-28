import type { Phase2StateType } from "@miraframe/agent";
import type { GenerationInput } from "./agent.service";
import {
  groupConversationTurns,
  renderMemoryBlock,
  type ConversationLike,
  type ConversationTurn,
} from "./conversation-memory";

export interface AgentProjectSnapshot {
  title: string | null;
  story: string | null;
  style: string | null;
  targetShotCount: number | null;
  storyOutline: Record<string, unknown> | null;
  visualBible: string | null;
}

export type ConversationMessage = ConversationLike;

const HISTORY_FOOTNOTE =
  "注意：用户可能用否定式或指代性表达（如「改回第一版」「保留结尾」「不要那个角色」），请结合上面的历史判断具体指向，不要只看当前这一条反馈。";

/**
 * 把 message 表的消息流构建成「用户反馈 → 系统回应摘要」的轮次上下文。
 *
 * 为什么要做这件事：processor 过去只写 messages 不读，用户第二轮说
 * "把主角改回第一版但保留结尾"时，模型只看得到这一句话，不知道"第一版"是什么。
 *
 * 三个工程取舍：
 * 1. 系统消息只取 summary，不取正文 —— 避免把整段大纲/分镜塞进 prompt 爆 token。
 * 2. 当前轮反馈已经出现在 projectContext 里，构建历史时排除，避免重复。
 * 3. 轮次编号保留原始序号，让模型能理解"第一版/第三轮"这类指代。
 *
 * 超窗后的处理（滚动摘要）：`coveredThroughId` 之前的轮次已被 `conversation-memory`
 * 折叠成 `memorySummary`，这里就不再重复注入原文；若摘要不可用（首次生成失败等），
 * 则退化为原来的「保留最近 N 轮 + 硬截断」行为。
 */
export function buildConversationHistory(
  messages: ConversationMessage[],
  options: {
    maxRounds?: number;
    maxChars?: number;
    excludeLatestUser?: boolean;
    /** 更早轮次的滚动摘要 */
    memorySummary?: string;
    /** 摘要已覆盖到哪条消息 id（含），这些消息不再重复注入 */
    coveredThroughId?: number;
  } = {},
): string {
  const maxRounds = options.maxRounds ?? 5;
  const maxChars = options.maxChars ?? 2400;

  const turns = groupConversationTurns(messages);
  const visible = options.excludeLatestUser && turns.length > 1 ? turns.slice(0, -1) : turns;
  const uncovered = options.coveredThroughId
    ? visible.filter((turn) => turn.lastMessageId > options.coveredThroughId!)
    : visible;
  const recent = uncovered.slice(-maxRounds);

  const memoryBlock = renderMemoryBlock(options.memorySummary ?? "");
  if (recent.length === 0) return memoryBlock;

  const title = "## 历史对话（按时间顺序）\n";
  const segments = recent.map(renderTurn);

  // 超长时从最旧的整块开始丢（下一轮它们就会被折叠进摘要），最后才硬截断，
  // 保证最近一轮永远不会因为前面轮次太长而被切掉。
  const fixedLength = (memoryBlock ? memoryBlock.length + 2 : 0) + title.length + HISTORY_FOOTNOTE.length + 2;
  while (segments.length > 1 && fixedLength + segments.join("\n\n").length > maxChars) {
    segments.shift();
  }

  let body = segments.join("\n\n");
  const budget = maxChars - fixedLength;
  let truncated = false;
  if (body.length > budget) {
    body = truncate(body, Math.max(80, budget - 10));
    truncated = true;
  }

  const parts: string[] = [];
  if (memoryBlock) parts.push(memoryBlock);
  parts.push(`${title}${body}${truncated ? "\n…（历史已截断）" : ""}`);
  parts.push(HISTORY_FOOTNOTE);
  return parts.join("\n\n");
}

function renderTurn(turn: ConversationTurn): string {
  const lines = [`第 ${turn.index} 轮`, `用户：${truncate(turn.user.content, 400)}`];
  const reply = [...turn.replies].reverse().find((item) => item.summary && item.summary.trim());
  if (reply?.summary) lines.push(`系统回应摘要：${truncate(reply.summary, 200)}`);
  return lines.join("\n");
}

function truncate(value: string, limit: number): string {
  const text = value.trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export function buildProjectContext(
  projectId: number,
  project: AgentProjectSnapshot | undefined,
  input: GenerationInput,
): string {
  return [
    `Project title: ${project?.title || `Project ${projectId}`}`,
    `Visual style: ${project?.style || "anime"}`,
    `Target shot count: ${project?.targetShotCount || 4}`,
    project?.visualBible ? `Visual bible:\n${project.visualBible}` : null,
    project?.storyOutline ? `Approved outline JSON:\n${JSON.stringify(project.storyOutline)}` : null,
    input.feedback
      ? [
          "Current user revision request:",
          `Target entity: ${input.entityType || "project"}${input.entityId ? ` #${input.entityId}` : ""}`,
          `Feedback type: ${input.feedbackType || "general"}`,
          `Revision mode: ${input.revisionMode || "stage"}`,
          input.feedback,
        ].join("\n")
      : null,
    "Story brief:",
    project?.story || "No story brief provided.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildInitialState(input: GenerationInput): Phase2StateType {
  const initialStage = (input.targetStage as Phase2StateType["currentStage"] | undefined) || "plan_outline";

  return {
    projectId: String(input.projectId),
    runId: String(input.runId),
    threadId: input.threadId,
    currentStage: initialStage,
    nextStage: null,
    stageHistory: [],
    approvalHistory: buildInitialApprovalHistory(initialStage),
    critiqueScores: {},
    critiqueRound: 0,
    // 自动审查的输入：由 PlanAgent 在 plan_shots 阶段写入，CriticAgent 读取
    artifactText: "",
    artifactLineage: {},
    // 执行计划由 Director 节点在 graph 入口生成，此处留空
    executionPlan: [],
    planRationale: "",
    routeStage: null,
    routeMode: input.mode,
    feedback: input.feedback || null,
    feedbackType: input.feedbackType || null,
    entityType: input.entityType || null,
    entityId: input.entityId || null,
    revisionMode: input.revisionMode || null,
  };
}

function buildInitialApprovalHistory(stage: Phase2StateType["currentStage"]): Record<string, string> {
  const approvalHistory: Record<string, string> = {};
  if (
    stage === "plan_characters" ||
    stage === "plan_shots" ||
    stage === "render_shot_images" ||
    stage === "compose_videos"
  ) {
    approvalHistory.outline = "approved";
  }
  if (stage === "plan_shots" || stage === "render_shot_images" || stage === "compose_videos") {
    approvalHistory.characters = "approved";
  }
  if (stage === "render_shot_images" || stage === "compose_videos") {
    approvalHistory.shots = "approved";
  }
  return approvalHistory;
}
