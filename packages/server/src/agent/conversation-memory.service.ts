import { Injectable } from "@nestjs/common";
import {
  EMPTY_MEMORY,
  applyMemoryPlan,
  buildSummaryPrompt,
  planMemoryUpdate,
  readMemoryConfig,
  serializeTurnsForSummary,
  type ConversationLike,
  type MemoryState,
} from "./conversation-memory";
import type { MemoryStore } from "./conversation-memory.store";

export interface ConversationMemoryResult extends MemoryState {
  /** 本次是否真的折叠了新材料（用于日志与测试断言） */
  updated: boolean;
}

export type MemorySummarizer = (prompt: { system: string; user: string }) => Promise<string>;

/**
 * 多轮记忆的滚动摘要编排。
 *
 * 每次生成任务开始时调用一次 `ensure()`：
 * 1. 读该项目的长期记忆；
 * 2. 判断有没有「滑出保留窗口且尚未折叠」的旧轮次；
 * 3. 有就调一次模型，把旧轮次合并进摘要并落库；
 * 4. 没有新东西就完全跳过 LLM 调用。
 *
 * 三条失败语义（都比「抛出去」更合理）：
 * - 记忆表还没建（迁移没跑）→ 当空记忆，静默降级，不影响生成；
 * - 模型调用失败 → 沿用旧摘要，历史上限逻辑兜底；
 * - 模型返回空 → 不覆盖旧摘要，避免一次坏输出清空长期记忆。
 */
@Injectable()
export class ConversationMemoryService {
  constructor(
    private readonly store: MemoryStore,
    private readonly summarize: MemorySummarizer,
  ) {}

  async ensure(
    projectId: number,
    messages: ConversationLike[],
    options: { excludeLatestUser?: boolean } = {},
  ): Promise<ConversationMemoryResult> {
    const config = readMemoryConfig();
    if (!config.enabled) return { ...EMPTY_MEMORY, updated: false };

    let memory: MemoryState;
    try {
      memory = await this.store.load(projectId);
    } catch (error) {
      // 迁移没跑、表不存在等：记忆是增强能力，不能让生成任务挂在这里
      console.warn(
        `[memory] 读取长期记忆失败（是否忘了执行 db:migrate？），本次不使用摘要：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { ...EMPTY_MEMORY, updated: false };
    }

    const plan = planMemoryUpdate(messages, memory, {
      keepTurns: config.keepTurns,
      minChars: config.minChars,
      ...(options.excludeLatestUser ? { excludeLatestUser: true } : {}),
    });
    if (!plan) return { ...memory, updated: false };

    try {
      const prompt = buildSummaryPrompt(memory.summary, serializeTurnsForSummary(plan.turns));
      const raw = await this.summarize(prompt);
      const next = applyMemoryPlan(memory, plan, raw);
      if (!next) {
        console.warn("[memory] 模型返回空摘要，保留旧记忆不覆盖");
        return { ...memory, updated: false };
      }

      await this.store.save(projectId, next);
      console.log(
        `[memory] 折叠 ${plan.turns.length} 轮（截至 message#${plan.coveredThroughId}）→ 摘要 ${next.summary.length} 字，累计覆盖 ${next.coveredTurns} 轮`,
      );
      return { ...next, updated: true };
    } catch (error) {
      console.warn(`[memory] 摘要生成失败，沿用旧记忆：${error instanceof Error ? error.message : String(error)}`);
      return { ...memory, updated: false };
    }
  }
}
