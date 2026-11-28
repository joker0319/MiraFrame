import type Redis from "ioredis";

/**
 * 等人工确认：订阅 `generation:<project>:<run>`，收到 confirm/cancel 或超时后返回。
 *
 * 抽成纯函数后，AgentProcessor 不再关心 Redis 订阅生命周期，
 * 也避免把「图执行」和「通道细节」继续堆在同一个 1000 行文件里。
 */
export function waitForConfirm(
  redisSub: Redis,
  projectId: number,
  runId: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = `generation:${projectId}:${runId}`;
    console.log(`[processor:confirm] Subscribing to Redis channel "${channel}"`);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      redisSub.off("message", onMessage);
      redisSub.unsubscribe(channel);
    };

    const onMessage = (msgChannel: string, message: string) => {
      if (msgChannel !== channel) return;
      try {
        const data = JSON.parse(message);
        console.log(`[processor:confirm] Received message on "${channel}":`, data);
        if (data.action === "confirm") {
          cleanup();
          resolve(true);
        } else if (data.action === "cancel") {
          cleanup();
          resolve(false);
        }
      } catch {
        // 忽略坏消息，继续等
      }
    };

    timer = setTimeout(() => {
      console.log(`[processor:confirm] Timeout after ${timeoutMs}ms`);
      cleanup();
      resolve(false);
    }, timeoutMs);

    redisSub.subscribe(channel, (err) => {
      if (err) {
        console.error(`[processor:confirm] Subscribe error:`, err);
        cleanup();
        resolve(false);
        return;
      }
      console.log(`[processor:confirm] Subscribed to "${channel}"`);
    });

    redisSub.on("message", onMessage);
  });
}
