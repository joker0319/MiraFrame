import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_MEMORY,
  MAX_SUMMARY_CHARS,
  applyMemoryPlan,
  buildSummaryPrompt,
  groupConversationTurns,
  planMemoryUpdate,
  readMemoryConfig,
  renderMemoryBlock,
  serializeTurnsForSummary,
  type ConversationLike,
  type MemoryState,
} from "../agent/conversation-memory.js";
import { ConversationMemoryService } from "../agent/conversation-memory.service.js";
import type { MemoryStore } from "../agent/conversation-memory.store.js";
import { buildConversationHistory } from "../agent/agent-run-state.js";

/**
 * 滚动摘要的验收。
 *
 * 这里要守住的不是「摘要写得好不好」（那是模型的事），而是四条工程语义：
 * 1. 只折叠滑出窗口的旧轮次，且每轮只折叠一次（coveredThroughId 不倒退）；
 * 2. 内容太少就不调模型（省钱、省延迟）；
 * 3. 摘要失败/空输出时宁可沿用旧记忆，也不清空、不阻断生成；
 * 4. 已折叠的原文不再重复注入 prompt，摘要与原文冲突时以原文为准。
 */

let nextId = 1;

function user(content: string): ConversationLike {
  return { id: nextId++, agent: "user", role: "user", content, summary: null };
}

function reply(summary: string, content = "系统播报正文不应进入摘要"): ConversationLike {
  return { id: nextId++, agent: "system", role: "assistant", content, summary };
}

/** 造 n 轮对话，每轮 = 用户一句 + 系统一条摘要 */
function makeTurns(n: number, prefix = "第"): ConversationLike[] {
  const out: ConversationLike[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(user(`${prefix}${i}轮：把色调改得更冷，保留结尾`));
    out.push(reply(`第${i}轮已处理`));
  }
  return out;
}

beforeEach(() => {
  // 每个用例从 id=1 重新编号，断言里的 coveredThroughId 才有固定含义
  nextId = 1;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("groupConversationTurns", () => {
  it("以用户发言为轮次起点，并把后续系统消息挂在同一轮", () => {
    nextId = 1;
    const turns = groupConversationTurns([user("A"), reply("回应A"), reply("回应A2"), user("B")]);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.replies).toHaveLength(2);
    expect(turns[1]!.index).toBe(2);
  });

  it("首条用户消息之前的系统消息被忽略，不产生空轮次", () => {
    nextId = 1;
    const turns = groupConversationTurns([reply("启动"), user("A")]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.user.content).toBe("A");
  });

  it("lastMessageId 取该轮最后一条消息的 id", () => {
    const turns = groupConversationTurns([
      { id: 10, agent: "user", role: "user", content: "A" },
      { id: 11, agent: "system", role: "assistant", content: "x" },
      { id: 12, agent: "system", role: "assistant", content: "y" },
    ]);
    expect(turns[0]!.lastMessageId).toBe(12);
  });
});

describe("planMemoryUpdate", () => {
  it("轮次数没超出保留窗口时不折叠", () => {
    nextId = 1;
    expect(planMemoryUpdate(makeTurns(3), EMPTY_MEMORY, { keepTurns: 5, minChars: 0 })).toBeNull();
  });

  it("有旧轮次但新增内容没到阈值时先攒着", () => {
    nextId = 1;
    const plan = planMemoryUpdate(makeTurns(6), EMPTY_MEMORY, { keepTurns: 3, minChars: 10_000 });
    expect(plan).toBeNull();
  });

  it("超出窗口且够长时给出折叠计划，覆盖位置取该批最后一轮的 id", () => {
    nextId = 1;
    const messages = makeTurns(6);
    const plan = planMemoryUpdate(messages, EMPTY_MEMORY, { keepTurns: 3, minChars: 0 });

    expect(plan).not.toBeNull();
    expect(plan!.turns.map((turn) => turn.index)).toEqual([1, 2, 3]);
    expect(plan!.coveredTurns).toBe(3);
    const thirdTurnLastId = messages[5]!.id!;
    expect(plan!.coveredThroughId).toBe(thirdTurnLastId);
  });

  it("已覆盖过的轮次不重复折叠", () => {
    nextId = 1;
    const messages = makeTurns(6);
    const first = planMemoryUpdate(messages, EMPTY_MEMORY, { keepTurns: 3, minChars: 0 })!;
    const covered: MemoryState = { summary: "旧摘要", coveredThroughId: first.coveredThroughId, coveredTurns: 3 };

    // 没有新增消息 → 没有可折叠内容
    expect(planMemoryUpdate(messages, covered, { keepTurns: 3, minChars: 0 })).toBeNull();

    // 又来两轮之后，只折叠新滑出的那些
    const more = [...messages, ...makeTurns(2, "新")];
    const plan = planMemoryUpdate(more, covered, { keepTurns: 3, minChars: 0 })!;
    expect(plan.turns.map((turn) => turn.index)).toEqual([4, 5]);
    expect(plan.coveredTurns).toBe(5);
  });

  it("excludeLatestUser 时当前轮不参与折叠（它已写在 projectContext 里）", () => {
    nextId = 1;
    const messages = makeTurns(3);
    // 保留窗口 2 轮：不排除时第 1 轮可折叠；排除当前轮后只剩 2 轮入选，无可折叠
    expect(planMemoryUpdate(messages, EMPTY_MEMORY, { keepTurns: 2, minChars: 0 })).not.toBeNull();
    expect(
      planMemoryUpdate(messages, EMPTY_MEMORY, { keepTurns: 2, minChars: 0, excludeLatestUser: true }),
    ).toBeNull();
  });
});

describe("serializeTurnsForSummary", () => {
  it("保留轮次号，回应用摘要而不是正文，且每轮只取最后两条", () => {
    nextId = 1;
    const turns = groupConversationTurns([
      user("第一版要冷色调"),
      reply("播报一", "正文一"),
      reply("播报二", "正文二"),
      reply("播报三", "正文三"),
    ]);
    const text = serializeTurnsForSummary(turns);
    expect(text).toContain("【第 1 轮】用户：第一版要冷色调");
    expect(text).toContain("系统：播报二");
    expect(text).toContain("系统：播报三");
    expect(text).not.toContain("播报一");
    expect(text).not.toContain("正文");
  });

  it("用户消息过长时截断，避免摘要请求本身爆 token", () => {
    const long = "很长的反馈".repeat(200);
    const text = serializeTurnsForSummary(groupConversationTurns([{ id: 1, agent: "user", role: "user", content: long }]));
    expect(text.length).toBeLessThan(450);
    expect(text).toContain("…");
  });
});

describe("buildSummaryPrompt", () => {
  it("首次生成时标注「无」，并要求输出完整摘要而不是增量", () => {
    const prompt = buildSummaryPrompt("", "【第 1 轮】用户：冷色调");
    expect(prompt.user).toContain("（无，这是第一次生成摘要）");
    expect(prompt.user).toContain("【第 1 轮】用户：冷色调");
    expect(prompt.user).toContain("不要只写新增部分");
    expect(prompt.system).toContain("第 2 轮");
  });

  it("已有摘要会被一起交给模型做合并", () => {
    const prompt = buildSummaryPrompt("第 1 轮：定稿冷色调", "【第 2 轮】用户：改暖一点");
    expect(prompt.user).toContain("第 1 轮：定稿冷色调");
    expect(prompt.user).toContain("【第 2 轮】用户：改暖一点");
  });
});

describe("applyMemoryPlan", () => {
  const plan = { turns: [], coveredThroughId: 42, coveredTurns: 3 };

  it("空输出返回 null —— 宁可保留旧摘要，也不要被一次坏调用清空", () => {
    expect(applyMemoryPlan(EMPTY_MEMORY, plan, "   \n ")).toBeNull();
  });

  it("超长输出被截到上限，避免摘要本身变成新的 token 黑洞", () => {
    const next = applyMemoryPlan(EMPTY_MEMORY, plan, "字".repeat(MAX_SUMMARY_CHARS + 500))!;
    expect(next.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + 1);
  });

  it("coveredThroughId 只前进不后退（并发/重放时不会重复折叠）", () => {
    const memory: MemoryState = { summary: "旧", coveredThroughId: 99, coveredTurns: 7 };
    const next = applyMemoryPlan(memory, plan, "新摘要")!;
    expect(next.coveredThroughId).toBe(99);
  });
});

describe("renderMemoryBlock", () => {
  it("空摘要不占位，避免 prompt 里出现空标题", () => {
    expect(renderMemoryBlock("  ")).toBe("");
  });

  it("非空摘要带上「冲突时以原文为准」的优先级说明", () => {
    const block = renderMemoryBlock("第 1 轮：冷色调");
    expect(block).toContain("长期记忆");
    expect(block).toContain("第 1 轮：冷色调");
    expect(block).toContain("以原文为准");
  });
});

describe("readMemoryConfig", () => {
  it("默认开启，保留 5 轮原文，600 字以下不调模型", () => {
    expect(readMemoryConfig({})).toEqual({ enabled: true, keepTurns: 5, minChars: 600 });
  });

  it("MIRAFRAME_MEMORY_SUMMARY=0 可整体关闭", () => {
    expect(readMemoryConfig({ MIRAFRAME_MEMORY_SUMMARY: "0" }).enabled).toBe(false);
  });

  it("非法值回落默认，并把参数夹在合理区间", () => {
    expect(readMemoryConfig({ MIRAFRAME_MEMORY_KEEP_TURNS: "abc" }).keepTurns).toBe(5);
    expect(readMemoryConfig({ MIRAFRAME_MEMORY_KEEP_TURNS: "0" }).keepTurns).toBe(1);
    expect(readMemoryConfig({ MIRAFRAME_MEMORY_KEEP_TURNS: "999" }).keepTurns).toBe(20);
  });
});

function fakeStore(initial: MemoryState = EMPTY_MEMORY) {
  let state = { ...initial };
  const saved: MemoryState[] = [];
  const store: MemoryStore = {
    load: async () => ({ ...state }),
    save: async (_projectId, next) => {
      state = { ...next };
      saved.push({ ...next });
    },
  };
  return {
    store,
    saved,
    current: () => state,
    breakLoad: () => {
      store.load = async () => {
        throw new Error('relation "conversation_memory" does not exist');
      };
    },
  };
}

describe("ConversationMemoryService", () => {
  it("关闭时既不读库也不调模型", async () => {
    vi.stubEnv("MIRAFRAME_MEMORY_SUMMARY", "0");
    const fake = fakeStore();
    const summarize = vi.fn(async () => "不该被调用");
    const service = new ConversationMemoryService(fake.store, summarize);

    const result = await service.ensure(1, makeTurns(10));

    expect(result.updated).toBe(false);
    expect(result.summary).toBe("");
    expect(summarize).not.toHaveBeenCalled();
    expect(fake.saved).toHaveLength(0);
  });

  it("没有新滑出的轮次时直接跳过，不产生额外模型调用", async () => {
    vi.stubEnv("MIRAFRAME_MEMORY_SUMMARY", "1");
    const fake = fakeStore();
    const summarize = vi.fn(async () => "摘要");
    const service = new ConversationMemoryService(fake.store, summarize);

    await service.ensure(1, makeTurns(3));

    expect(summarize).not.toHaveBeenCalled();
  });

  it("折叠成功后落库，并把摘要喂给模型的是「旧摘要 + 新轮次」", async () => {
    vi.stubEnv("MIRAFRAME_MEMORY_SUMMARY", "1");
    vi.stubEnv("MIRAFRAME_MEMORY_KEEP_TURNS", "2");
    vi.stubEnv("MIRAFRAME_MEMORY_MIN_CHARS", "0");
    const fake = fakeStore({ summary: "第 1 轮：定稿冷色调", coveredThroughId: 2, coveredTurns: 1 });
    const summarize = vi.fn(async (_prompt: { system: string; user: string }) => "第 1 轮：定稿冷色调；第 2 轮：追加雨夜镜头，保留结尾");
    const service = new ConversationMemoryService(fake.store, summarize);

    const result = await service.ensure(7, makeTurns(4));

    expect(result.updated).toBe(true);
    // 记忆已覆盖到 message#2（即第 1 轮），本次只折叠第 2 轮
    expect(result.coveredTurns).toBe(2);
    expect(fake.saved).toHaveLength(1);
    const prompt = summarize.mock.calls[0]![0];
    expect(prompt.user).toContain("第 1 轮：定稿冷色调");
    expect(prompt.user).toContain("【第 2 轮】");
    expect(prompt.system).toContain("记忆压缩器");
  });

  it("模型调用失败时沿用旧记忆，不抛错、不阻断生成", async () => {
    vi.stubEnv("MIRAFRAME_MEMORY_SUMMARY", "1");
    vi.stubEnv("MIRAFRAME_MEMORY_KEEP_TURNS", "2");
    vi.stubEnv("MIRAFRAME_MEMORY_MIN_CHARS", "0");
    const fake = fakeStore({ summary: "旧摘要", coveredThroughId: 2, coveredTurns: 1 });
    const service = new ConversationMemoryService(fake.store, async () => {
      throw new Error("429 rate limited");
    });

    const result = await service.ensure(7, makeTurns(4));

    expect(result.updated).toBe(false);
    expect(result.summary).toBe("旧摘要");
    expect(fake.saved).toHaveLength(0);
  });

  it("模型返回空摘要时不清空旧记忆", async () => {
    vi.stubEnv("MIRAFRAME_MEMORY_SUMMARY", "1");
    vi.stubEnv("MIRAFRAME_MEMORY_KEEP_TURNS", "2");
    vi.stubEnv("MIRAFRAME_MEMORY_MIN_CHARS", "0");
    const fake = fakeStore({ summary: "旧摘要", coveredThroughId: 2, coveredTurns: 1 });
    const service = new ConversationMemoryService(fake.store, async () => "   ");

    const result = await service.ensure(7, makeTurns(4));

    expect(result.summary).toBe("旧摘要");
    expect(result.updated).toBe(false);
    expect(fake.saved).toHaveLength(0);
  });

  it("记忆表还没建（迁移没跑）时静默降级为空记忆", async () => {
    vi.stubEnv("MIRAFRAME_MEMORY_SUMMARY", "1");
    const fake = fakeStore();
    fake.breakLoad();
    const service = new ConversationMemoryService(fake.store, async () => "摘要");

    const result = await service.ensure(7, makeTurns(10));

    expect(result).toEqual({ ...EMPTY_MEMORY, updated: false });
  });

  it("excludeLatestUser 透传：当前轮反馈不会被提前折叠进摘要", async () => {
    vi.stubEnv("MIRAFRAME_MEMORY_SUMMARY", "1");
    vi.stubEnv("MIRAFRAME_MEMORY_KEEP_TURNS", "2");
    vi.stubEnv("MIRAFRAME_MEMORY_MIN_CHARS", "0");
    const fake = fakeStore();
    const summarize = vi.fn(async () => "摘要");
    const service = new ConversationMemoryService(fake.store, summarize);

    const result = await service.ensure(7, makeTurns(2), { excludeLatestUser: true });

    expect(result.updated).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
  });
});

describe("buildConversationHistory × 滚动摘要", () => {
  it("已折叠的轮次不再重复注入原文，摘要块排在原文之前", () => {
    nextId = 1;
    const messages = makeTurns(4);
    const thirdTurnLastId = messages[5]!.id!;

    const history = buildConversationHistory(messages, {
      memorySummary: "第 1-3 轮：定稿冷色调，保留结尾",
      coveredThroughId: thirdTurnLastId,
    });

    expect(history).toContain("长期记忆");
    expect(history).toContain("第 1-3 轮：定稿冷色调");
    expect(history.indexOf("长期记忆")).toBeLessThan(history.indexOf("历史对话"));
    // 第 4 轮仍是原文，前三轮不重复
    expect(history).toContain("第 4 轮");
    expect(history).not.toContain("第 1 轮");
  });

  it("没有摘要时保持原行为（最近 N 轮原文 + 截断保护）", () => {
    nextId = 1;
    const history = buildConversationHistory(makeTurns(4), { maxRounds: 2 });
    expect(history).toContain("第 3 轮");
    expect(history).toContain("第 4 轮");
    expect(history).not.toContain("长期记忆");
  });

  it("摘要块自身超长时不把原文整体挤掉，仍保留最近一轮", () => {
    nextId = 1;
    const history = buildConversationHistory(makeTurns(3), {
      memorySummary: "旧".repeat(600),
      coveredThroughId: 0,
      maxChars: 600,
    });
    expect(history).toContain("长期记忆");
    expect(history).toContain("第 3 轮");
  });
});
