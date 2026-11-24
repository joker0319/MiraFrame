/**
 * CORS 来源解析 —— REST 与 WebSocket 共用同一套规则。
 *
 * 默认只放开本地开发常用来源，避免「enableCors() 无参 = 任意来源」的裸奔状态。
 * 需要放开时显式配置 CORS_ORIGINS=*（启动期会给出告警）。
 */
export const DEFAULT_CORS_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:15173",
  "http://127.0.0.1:15173",
];

export function parseCorsOrigins(raw?: string | null): string[] {
  if (!raw || !raw.trim()) return [...DEFAULT_CORS_ORIGINS];

  const trimmed = raw.trim();
  if (trimmed === "*") return ["*"];

  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((v) => typeof v === "string" && v.length > 0)) {
        return parsed as string[];
      }
      return [...DEFAULT_CORS_ORIGINS];
    } catch {
      // 以 [ 开头说明本意是 JSON 数组，写错了就退回默认，不要当成逗号分隔值
      return [...DEFAULT_CORS_ORIGINS];
    }
  }

  const list = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : [...DEFAULT_CORS_ORIGINS];
}
