/**
 * 跨层共用的基础枚举与标量。
 *
 * 这里刻意只放**协议里真实存在**的值：数据库主键是 serial（整数），
 * 时间统一以 ISO 字符串出现在 JSON 里，所以不要在这里引入 UUID、Date。
 */

export type ReviewState = "draft" | "approved" | "superseded";
export type ProjectStatus = "draft" | "generating" | "completed" | "failed";
export type VersionEntityType = "character" | "shot";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type ConfigValue = string | number | boolean | null;

/** 思考事件的四种阶段，前后端共用同一套字面量。 */
export type AgentThinkingPhase = "reasoning" | "decision" | "planning" | "reviewing";
