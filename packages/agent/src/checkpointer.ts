import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

/**
 * 进程内共享一个 saver。
 * PostgresSaver 内部持有 pg.Pool，每个 job 新建会打爆连接数；
 * 而 checkpoint 本来就该跨 job / 跨进程可见，复用才是正确语义。
 */
let shared: Promise<BaseCheckpointSaver> | null = null;

/**
 * 有连接串时把 checkpoint 落到 PostgreSQL：进程重启后 BullMQ 重新拾起
 * 同一个 job，图能从最后完成的节点继续，而不是从头再跑一遍。
 * 没有连接串（单测、纯内存演示）则退回 MemorySaver。
 */
export function createCheckpointer(connectionString?: string): Promise<BaseCheckpointSaver> {
  if (!connectionString) return Promise.resolve(new MemorySaver());

  if (!shared) {
    shared = (async () => {
      const saver = PostgresSaver.fromConnString(connectionString);
      // 幂等建表：首次创建 checkpoints / checkpoint_blobs / checkpoint_writes
      await saver.setup();
      return saver;
    })().catch((err) => {
      // 建表失败不能把坏 Promise 永久缓存，否则后续 job 全部连坐
      shared = null;
      throw err;
    });
  }
  return shared;
}

/** 仅测试用：清掉进程级缓存。 */
export function resetCheckpointer(): void {
  shared = null;
}
