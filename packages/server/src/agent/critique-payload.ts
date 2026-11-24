import type { CritiqueReport } from "@miraframe/agent";

/**
 * Agent 侧的 camelCase 评审结论 → WS 的 snake_case 载荷。
 *
 * 单独成文件而不是塞在 processor 里，是为了：
 * 1. 前端契约只在一处定义，测试可以直接断言字段名；
 * 2. 测试不必拉起 @nestjs/bullmq / ioredis 那一整套依赖。
 */
export function toCritiqueResultPayload(report: CritiqueReport) {
  return {
    stage: report.stage,
    entity_type: report.entityType,
    ...(report.entityId != null ? { entity_id: report.entityId } : {}),
    score: report.score,
    threshold: report.threshold,
    passed: report.passed,
    round: report.round,
    max_rounds: report.maxRounds,
    dimensions: report.dimensions,
    issues: report.issues,
    suggestions: report.suggestions,
    will_regenerate: report.willRegenerate,
  };
}
