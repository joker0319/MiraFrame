import { z } from "zod";
import { parseCorsOrigins } from "./cors";

/**
 * 启动期配置诊断。
 *
 * 刻意不做 fail-fast：项目支持 fake provider，且允许通过设置面板在运行时补齐
 * 配置，启动时硬性抛错会破坏这两种能力。这里只做「校验 + 告警」——把明显的
 * 配置错误在启动日志里说清楚，而不是等到生成到一半才报 401。
 */
export interface StartupCheckResult {
  warnings: string[];
  summary: string[];
}

interface NumericCheck {
  key: string;
  min: number;
  max: number;
  fallback: number | string;
  integer?: boolean;
  hint?: string;
}

const NUMERIC_CHECKS: NumericCheck[] = [
  { key: "CRITIC_SCORE_THRESHOLD", min: 0, max: 10, fallback: 7, hint: "Critic 通过阈值" },
  { key: "CRITIC_MAX_ROUNDS", min: 1, max: 10, fallback: 2, integer: true, hint: "Critic 最多打回轮次" },
  { key: "TEXT_MAX_RETRIES", min: 0, max: 20, fallback: 6, integer: true },
  { key: "TEXT_RETRY_BASE_MS", min: 0, max: 600_000, fallback: 1000, integer: true },
  { key: "VIDEO_MAX_RETRIES", min: 0, max: 20, fallback: 8, integer: true },
  { key: "VIDEO_RETRY_BASE_MS", min: 0, max: 600_000, fallback: 5000, integer: true },
  { key: "FACE_OK_DISTANCE", min: 0, max: 2, fallback: 0.45 },
  { key: "FACE_DRIFT_DISTANCE", min: 0, max: 2, fallback: 0.6 },
  { key: "TTS_RATE", min: 60, max: 600, fallback: 210, integer: true },
  { key: "TTS_BGM_VOLUME", min: 0, max: 1, fallback: 0.08 },
];

const PROVIDERS = ["TEXT", "IMAGE", "VIDEO"] as const;
const ALLOWED_PROVIDERS = new Set(["openai", "fake"]);

export function checkStartupConfig(
  env: Record<string, string | undefined> = process.env,
): StartupCheckResult {
  const warnings: string[] = [];
  const summary: string[] = [];

  // 1. 数值型配置：非法值告警，并说明代码会退回默认值
  for (const check of NUMERIC_CHECKS) {
    const raw = env[check.key];
    if (raw === undefined || raw.trim() === "") continue;
    const base = z.coerce.number().min(check.min).max(check.max);
    const schema = check.integer ? base.int() : base;
    const result = schema.safeParse(raw);
    if (!result.success) {
      warnings.push(
        `${check.key}=${raw} 非法（要求 ${check.min}~${check.max}${check.integer ? " 的整数" : ""}），将退回默认值 ${check.fallback}${check.hint ? `（${check.hint}）` : ""}。`,
      );
    }
  }

  // 2. provider 完整性：非 fake 必须有 key；provider 值必须是已知枚举
  for (const prefix of PROVIDERS) {
    const providerRaw = env[`${prefix}_PROVIDER`];
    const provider = (providerRaw || "fake").trim();
    const key = env[`${prefix}_API_KEY`];
    summary.push(`${prefix}: provider=${provider}, apiKey=${key ? "已配置" : "未配置"}`);
    if (!ALLOWED_PROVIDERS.has(provider)) {
      warnings.push(`${prefix}_PROVIDER=${provider} 不是已知 provider（openai / fake），生成时可能走到错误的分支。`);
    } else if (provider !== "fake" && !key) {
      warnings.push(`${prefix}_PROVIDER=${provider} 但未配置 ${prefix}_API_KEY，生成会失败；可在设置面板里补配。`);
    }
  }

  // 3. 一致性阈值必须 OK < DRIFT，否则判定逻辑无意义
  const okRaw = Number(env.FACE_OK_DISTANCE || 0.45);
  const driftRaw = Number(env.FACE_DRIFT_DISTANCE || 0.6);
  if (Number.isFinite(okRaw) && Number.isFinite(driftRaw) && okRaw >= driftRaw) {
    warnings.push(`FACE_OK_DISTANCE=${okRaw} 必须小于 FACE_DRIFT_DISTANCE=${driftRaw}，否则一致性判定失效。`);
  }

  // 4. 安全相关：未设 ADMIN_TOKEN 或 CORS 全开时明确告警
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.trim() === "") {
    warnings.push("ADMIN_TOKEN 未配置：运行时配置接口处于本地开发模式（无鉴权）。部署到共享环境前请务必设置。");
  }
  if (parseCorsOrigins(env.CORS_ORIGINS).includes("*")) {
    warnings.push("CORS_ORIGINS 允许任意来源（*）。仅建议在完全隔离的本地环境使用。");
  }

  return { warnings, summary };
}
