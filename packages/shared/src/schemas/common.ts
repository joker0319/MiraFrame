import { z } from "zod";

/** 数据库主键是 serial；拒绝 0/负数/小数，避免把字符串 id 蒙混进来。 */
export const IdSchema: z.ZodTypeAny = z.number().int().positive();

/**
 * 对外时间统一是 ISO 字符串。允许带时区偏移，DTO 目前统一输出 Z。
 * 不接受空串：空串通常意味着前端/序列化层漏了字段，应该在边界暴露。
 */
export const IsoDateSchema: z.ZodTypeAny = z.string().datetime({ offset: true });

export const ReviewStateSchema: z.ZodTypeAny = z.enum(["draft", "approved", "superseded"]);
export const ProjectStatusSchema: z.ZodTypeAny = z.enum([
  "draft",
  "generating",
  "completed",
  "failed",
]);
export const VersionEntityTypeSchema: z.ZodTypeAny = z.enum(["character", "shot"]);
export const RunStatusSchema: z.ZodTypeAny = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const AgentThinkingPhaseSchema: z.ZodTypeAny = z.enum([
  "reasoning",
  "decision",
  "planning",
  "reviewing",
]);

export const ConfigValueSchema: z.ZodTypeAny = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
