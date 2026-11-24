/**
 * 多轮记忆的滚动摘要（rolling summary）。
 *
 * 解决的问题：此前历史上下文是「把最近 N 轮原文拼进 prompt」，一旦超出窗口
 * 就被一刀截断，最早几轮的偏好与决定彻底丢失 —— 用户说「改回第一版」时，
 * 模型已经不知道第一版是什么。
 *
 * 做法：把滑出窗口的旧轮次增量折叠成一段摘要（每轮只折叠一次，用
 * coveredThroughId 记住覆盖位置），最近几轮仍保留原文。摘要与原文分两个
 * block 注入，并明确「冲突时以原文为准」。
 *
 * 本文件只放纯函数：不碰数据库、不碰 LLM，便于单测覆盖边界。
 */

export interface ConversationLike {
  /** 数据库主键；内存构造的测试数据可省略 */
  id?: number;
  agent: string;
  role: string;
  content: string;
  summary?: string | null;
  createdAt?: Date;
}

export interface ConversationTurn<T extends ConversationLike = ConversationLike> {
  /** 原始轮次号（从 1 开始），保留给模型理解「第一版 / 第三轮」这类指代 */
  index: number;
  user: T;
  replies: T[];
  /** 该轮最后一条消息的 id，用于标记摘要覆盖位置 */
  lastMessageId: number;
}

/** 一个项目的长期记忆状态（与 conversation_memory 表一一对应） */
export interface MemoryState {
  summary: string;
  /** 摘要已覆盖到哪条消息 id（含） */
  coveredThroughId: number;
  /** 已折叠的轮次数，便于观测「记忆压了多少」 */
  coveredTurns: number;
}

export const EMPTY_MEMORY: MemoryState = { summary: "", coveredThroughId: 0, coveredTurns: 0 };

/** 摘要正文上限：模型被要求 ≤320 字，这里留冗余防止跑飞 */
export const MAX_SUMMARY_CHARS = 800;

export interface MemoryPlan {
  /** 本次要折叠的旧轮次（时间顺序） */
  turns: ConversationTurn[];
  /** 折叠完成后摘要应覆盖到的消息 id */
  coveredThroughId: number;
  /** 折叠完成后累计覆盖轮次数 */
  coveredTurns: number;
}

export interface MemoryPlanOptions {
  /** 最近多少轮保留原文（不折叠） */
  keepTurns: number;
  /** 待折叠内容少于该字数就不值得调一次模型 */
  minChars: number;
  /** 当前轮反馈已经写在 projectContext 里，参与轮次计算时要排除 */
  excludeLatestUser?: boolean;
}

/** 把消息流按「用户发言 = 一轮的开始」分组 */
export function groupConversationTurns<T extends ConversationLike>(messages: T[]): ConversationTurn<T>[] {
  const turns: ConversationTurn<T>[] = [];
  for (const message of messages) {
    if (message.role === "user" && message.agent === "user") {
      turns.push({ index: turns.length + 1, user: message, replies: [], lastMessageId: message.id ?? 0 });
    } else if (turns.length > 0) {
      const turn = turns[turns.length - 1];
      turn.replies.push(message);
      if (message.id != null && message.id > turn.lastMessageId) turn.lastMessageId = message.id;
    }
  }
  return turns;
}

/**
 * 判断这一轮要不要更新摘要、更新到哪。
 *
 * 三个前置条件缺一不可：
 * 1. 存在滑出保留窗口的旧轮次；
 * 2. 这些轮次还没被摘要覆盖过（coveredThroughId 之后的部分）；
 * 3. 新增内容够多（低于 minChars 就攒着，下次一起折叠）。
 *
 * 返回 null 表示「不需要动」，调用方可以直接跳过 LLM 调用。
 */
export function planMemoryUpdate(
  messages: ConversationLike[],
  memory: MemoryState,
  options: MemoryPlanOptions,
): MemoryPlan | null {
  const turns = groupConversationTurns(messages);
  if (turns.length === 0) return null;

  // 当前轮反馈已由 projectContext 承载，不参与「保留窗口」和「待折叠」的计算
  const visible = options.excludeLatestUser && turns.length > 1 ? turns.slice(0, -1) : turns;

  const keep = Math.max(1, options.keepTurns);
  const older = visible.slice(0, Math.max(0, visible.length - keep));
  if (older.length === 0) return null;

  const pending = older.filter((turn) => turn.lastMessageId > memory.coveredThroughId);
  if (pending.length === 0) return null;

  const chars = pending.reduce(
    (total, turn) =>
      total +
      turn.user.content.length +
      turn.replies.reduce((sum, reply) => sum + (reply.summary?.trim() || reply.content).length, 0),
    0,
  );
  if (chars < options.minChars) return null;

  return {
    turns: pending,
    coveredThroughId: Math.max(...pending.map((turn) => turn.lastMessageId)),
    coveredTurns: memory.coveredTurns + pending.length,
  };
}

/** 把待折叠轮次序列化成便于模型压缩的文本（每轮限长，避免摘要请求本身爆 token） */
export function serializeTurnsForSummary(turns: ConversationTurn[]): string {
  return turns
    .map((turn) => {
      const lines = [`【第 ${turn.index} 轮】用户：${truncate(turn.user.content, 400)}`];
      const replies = turn.replies
        .filter((reply) => (reply.summary?.trim() || reply.content).trim())
        .slice(-2);
      for (const reply of replies) {
        lines.push(`  系统：${truncate(reply.summary?.trim() || reply.content, 160)}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export const MEMORY_SYSTEM_PROMPT = `你是漫剧生成项目的对话记忆压缩器，负责把更早的对话压成一段可长期复用的摘要。

只保留对未来生成有用的信息：
- 用户明确提出的修改要求与偏好（色调、节奏、角色设定、镜头数量、叙事视角等）
- 已被否决或已被替换的方案，以及被否决的原因
- 已确认的版本与关键决定（例如「第 3 轮定稿冷色调大纲」）
- 指代关系（用户说的「第一版」具体指哪一版）

硬性要求：
1. 保留具体名词：角色名、镜头号、风格名、数值。不要抽象成「某些角色」「相关参数」。
2. 按轮次标注来源，形如「第 2 轮：用户要求……」，便于回溯。
3. 不编造未出现过的信息，不写评价性语言，不写建议。
4. 中文，控制在 320 字以内；信息多时优先保留最近、最具体的决定。
5. 只输出摘要正文，不要标题、不要前言、不要代码块。`;

export interface SummaryPrompt {
  system: string;
  user: string;
}

/** 摘要请求：把「已有摘要」和「新增旧轮次」一起给模型，要它输出合并后的完整摘要 */
export function buildSummaryPrompt(existingSummary: string, turnsText: string): SummaryPrompt {
  return {
    system: MEMORY_SYSTEM_PROMPT,
    user: [
      "【已有摘要】",
      existingSummary.trim() || "（无，这是第一次生成摘要）",
      "",
      "【需要合并进摘要的更早轮次】",
      turnsText,
      "",
      "请输出合并后的完整摘要（包含已有摘要中的信息，不要只写新增部分）。",
    ].join("\n"),
  };
}

/**
 * 把模型输出落成新的记忆状态。
 * 空输出时返回 null —— 宁可保留旧摘要，也不要被一次失败调用清空长期记忆。
 */
export function applyMemoryPlan(memory: MemoryState, plan: MemoryPlan, rawSummary: string): MemoryState | null {
  const summary = rawSummary.trim().replace(/\r\n/g, "\n");
  if (!summary) return null;
  const clipped = summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}…` : summary;
  return {
    summary: clipped,
    coveredThroughId: Math.max(memory.coveredThroughId, plan.coveredThroughId),
    coveredTurns: plan.coveredTurns,
  };
}

/** 注入 prompt 的长期记忆 block；空摘要返回空串（不占位、不产生噪音） */
export function renderMemoryBlock(summary: string): string {
  const text = summary.trim();
  if (!text) return "";
  return [
    "## 长期记忆（更早轮次的滚动摘要）",
    text,
    "（上面是更早对话的压缩结果，最近几轮原文见下；两者冲突时以原文为准。）",
  ].join("\n");
}

export interface MemoryConfig {
  enabled: boolean;
  keepTurns: number;
  minChars: number;
}

/** 读环境变量；每次调用都读，测试里改 env 立即生效 */
export function readMemoryConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  return {
    enabled: env.MIRAFRAME_MEMORY_SUMMARY !== "0",
    keepTurns: clampInt(env.MIRAFRAME_MEMORY_KEEP_TURNS, 5, 1, 20),
    minChars: clampInt(env.MIRAFRAME_MEMORY_MIN_CHARS, 600, 0, 100_000),
  };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function truncate(value: string, limit: number): string {
  const text = value.trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
