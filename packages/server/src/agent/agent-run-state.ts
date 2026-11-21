import type { Phase2StateType } from "@miraframe/agent";
import type { GenerationInput } from "./agent.service";

export interface AgentProjectSnapshot {
  title: string | null;
  story: string | null;
  style: string | null;
  targetShotCount: number | null;
  storyOutline: Record<string, unknown> | null;
  visualBible: string | null;
}

export interface ConversationMessage {
  agent: string;
  role: string;
  content: string;
  summary: string | null;
  createdAt: Date;
}

interface ConversationTurn {
  index: number;
  user: ConversationMessage;
  replies: ConversationMessage[];
}

const HISTORY_FOOTNOTE =
  "注意：用户可能用否定式或指代性表达（如「改回第一版」「保留结尾」「不要那个角色」），请结合上面的历史判断具体指向，不要只看当前这一条反馈。";

/**
 * 把 message 表的消息流构建成"用户反馈 → 系统回应摘要"的轮次上下文。
 *
 * 为什么要做这件事：processor 过去只写 messages 不读，用户第二轮说
 * "把主角改回第一版但保留结尾"时，模型只看得到这一句话，不知道"第一版"是什么。
 *
 * 三个工程取舍：
 * 1. 系统消息只取 summary，不取正文 —— 避免把整段大纲/分镜塞进 prompt 爆 token。
 * 2. 当前轮反馈已经出现在 projectContext 里，构建历史时排除，避免重复。
 * 3. 轮次编号保留原始序号，让模型能理解"第一版/第三轮"这类指代。
 */
export function buildConversationHistory(
  messages: ConversationMessage[],
  options: { maxRounds?: number; maxChars?: number; excludeLatestUser?: boolean } = {},
): string {
  const maxRounds = options.maxRounds ?? 5;
  const maxChars = options.maxChars ?? 2400;

  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    if (message.role === "user" && message.agent === "user") {
      turns.push({ index: turns.length + 1, user: message, replies: [] });
    } else if (turns.length > 0) {
      turns[turns.length - 1].replies.push(message);
    }
  }

  if (turns.length === 0) return "";
  const selected = options.excludeLatestUser && turns.length > 1 ? turns.slice(0, -1) : turns;
  const recent = selected.slice(-maxRounds);
  if (recent.length === 0) return "";

  const blocks = recent.map((turn) => {
    const lines = [`第 ${turn.index} 轮`, `用户：${truncate(turn.user.content, 400)}`];
    const reply = [...turn.replies].reverse().find((item) => item.summary && item.summary.trim());
    if (reply?.summary) lines.push(`系统回应摘要：${truncate(reply.summary, 200)}`);
    return lines.join("\n");
  });

  const body = `## 历史对话（按时间顺序）\n${blocks.join("\n\n")}`;
  const full = `${body}\n\n${HISTORY_FOOTNOTE}`;
  if (full.length <= maxChars) return full;
  const reserve = HISTORY_FOOTNOTE.length + 24;
  return `${truncate(full, Math.max(120, maxChars - reserve))}\n…（历史已截断）\n${HISTORY_FOOTNOTE}`;
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
    reviewRequested: false,
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
