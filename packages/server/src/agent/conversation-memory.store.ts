import { eq } from "drizzle-orm";
import { schema, type Db } from "../db";
import { EMPTY_MEMORY, type MemoryState } from "./conversation-memory";

/**
 * 长期记忆的持久化接口。
 *
 * 抽成接口而不是直接依赖 Db：滚动摘要的编排逻辑（何时折叠、失败怎么办）
 * 值得单测，而 drizzle 的链式查询很难在单测里伪造。有了这层，测试可以
 * 用一个内存实现验证「增量折叠、失败回退、空输出不清空」这些行为。
 */
export interface MemoryStore {
  load(projectId: number): Promise<MemoryState>;
  save(projectId: number, state: MemoryState): Promise<void>;
}

export function createDrizzleMemoryStore(db: Db): MemoryStore {
  return {
    async load(projectId) {
      const [row] = await db
        .select({
          summary: schema.conversationMemory.summary,
          coveredThroughId: schema.conversationMemory.coveredThroughId,
          coveredTurns: schema.conversationMemory.coveredTurns,
        })
        .from(schema.conversationMemory)
        .where(eq(schema.conversationMemory.projectId, projectId));

      if (!row) return { ...EMPTY_MEMORY };
      return {
        summary: row.summary ?? "",
        coveredThroughId: row.coveredThroughId ?? 0,
        coveredTurns: row.coveredTurns ?? 0,
      };
    },

    async save(projectId, state) {
      const updatedAt = new Date();
      await db
        .insert(schema.conversationMemory)
        .values({
          projectId,
          summary: state.summary,
          coveredThroughId: state.coveredThroughId,
          coveredTurns: state.coveredTurns,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: schema.conversationMemory.projectId,
          set: {
            summary: state.summary,
            coveredThroughId: state.coveredThroughId,
            coveredTurns: state.coveredTurns,
            updatedAt,
          },
        });
    },
  };
}
