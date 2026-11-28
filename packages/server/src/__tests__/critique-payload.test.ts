import { describe, expect, it } from "vitest";
import type { CritiqueResultEventData } from "@miraframe/shared";
import type { CritiqueReport } from "@miraframe/agent";
import { toCritiqueResultPayload } from "../agent/critique-payload";

const REPORT: CritiqueReport = {
  stage: "critique_shots",
  entityType: "shots",
  score: 6.5,
  threshold: 7,
  passed: false,
  round: 1,
  maxRounds: 2,
  dimensions: { narrative: 7, continuity: 6, camera: 6.5, generatable: 6 },
  issues: ["第 3 镜与第 1 镜场景矛盾"],
  suggestions: ["统一临安城的天气描写"],
  willRegenerate: true,
};

describe("toCritiqueResultPayload", () => {
  it("把 camelCase 评审结论转成 WS 的 snake_case 载荷", () => {
    const payload = toCritiqueResultPayload(REPORT);

    expect(payload).toMatchObject({
      stage: "critique_shots",
      entity_type: "shots",
      score: 6.5,
      threshold: 7,
      passed: false,
      round: 1,
      max_rounds: 2,
      will_regenerate: true,
    });
    expect(payload).not.toHaveProperty("entityType");
    expect(payload).not.toHaveProperty("maxRounds");
    expect(payload).not.toHaveProperty("willRegenerate");
  });

  it("载荷结构由 shared 的 CritiqueResultEventData 在编译期约束", () => {
    // 这里不跑运行时 schema：payload 的返回类型就是 shared 契约，
    // 字段拼错/漏字段会直接让 tsc 失败。
    const payload: CritiqueResultEventData = toCritiqueResultPayload(REPORT);
    expect(payload.entity_type).toBe("shots");
  });

  it("有 entityId 时才带 entity_id，避免发 null 让前端多写一层判空", () => {
    expect(toCritiqueResultPayload(REPORT)).not.toHaveProperty("entity_id");
    expect(toCritiqueResultPayload({ ...REPORT, entityId: 12 })).toHaveProperty("entity_id", 12);
  });

  it("通过时 willRegenerate=false，前端据此显示「已通过」而不是「将重写」", () => {
    const payload: CritiqueResultEventData = toCritiqueResultPayload({
      ...REPORT,
      score: 8.4,
      passed: true,
      willRegenerate: false,
    });

    expect(payload.passed).toBe(true);
    expect(payload.will_regenerate).toBe(false);
  });
});
