import type { ZodTypeAny } from "zod";

/**
 * 出站运行时校验。类型层已经约束了一次，这里再兜住“运行时多/少字段”。
 * 开发/测试直接抛，逼着在 CI 里修；生产只记日志，不能让一个字段把生成任务打挂。
 */
export function assertContract<T>(schema: ZodTypeAny, value: T, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    console.error(`[contract] ${label} 不符合 shared 契约: ${issues}`);
    if (process.env.NODE_ENV !== "production") {
      throw new Error(`${label} 不符合 shared 契约: ${issues}`);
    }
  }
  return value;
}
