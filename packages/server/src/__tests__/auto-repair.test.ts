import { describe, expect, it, vi } from "vitest";
import {
  isImageRepairAvailable,
  planAutoRepair,
  readAutoRepairConfig,
  runAutoRepair,
  worstDistanceOf,
  type DriftCandidate,
} from "../services/auto-repair";
import { collectRepairReferences } from "../services/shot-repair.service";
import type { StoredShotConsistency } from "../services/consistency";

function env(values: Record<string, string | undefined>) {
  return (key: string) => values[key];
}

function stored(overrides: Partial<StoredShotConsistency> = {}): StoredShotConsistency {
  return {
    shotId: 1,
    order: 1,
    expected: [],
    extraFaces: [],
    verdict: "drift",
    message: "",
    checkedAt: "2026-11-25T00:00:00.000Z",
    ...overrides,
  };
}

function candidate(overrides: Partial<DriftCandidate> = {}): DriftCandidate {
  return {
    shotId: 1,
    order: 1,
    verdict: "drift",
    worstDistance: 0.7,
    referenceCount: 2,
    ...overrides,
  };
}

describe("readAutoRepairConfig", () => {
  it("默认开启，单轮预算 2", () => {
    expect(readAutoRepairConfig(env({}))).toEqual({ enabled: true, maxShots: 2 });
  });

  it("0 / false / off / no 都是关闭（大小写与空格不敏感）", () => {
    for (const value of ["0", "false", "OFF", " no ", "False"]) {
      expect(readAutoRepairConfig(env({ MIRAFRAME_AUTO_REPAIR: value })).enabled).toBe(false);
    }
  });

  it("其它值视为开启", () => {
    expect(readAutoRepairConfig(env({ MIRAFRAME_AUTO_REPAIR: "1" })).enabled).toBe(true);
    expect(readAutoRepairConfig(env({ MIRAFRAME_AUTO_REPAIR: "yes" })).enabled).toBe(true);
  });

  it("预算是 0..10 的整数，非法值回落默认", () => {
    expect(readAutoRepairConfig(env({ MIRAFRAME_AUTO_REPAIR_MAX_SHOTS: "0" })).maxShots).toBe(0);
    expect(readAutoRepairConfig(env({ MIRAFRAME_AUTO_REPAIR_MAX_SHOTS: "4" })).maxShots).toBe(4);
    expect(readAutoRepairConfig(env({ MIRAFRAME_AUTO_REPAIR_MAX_SHOTS: "99" })).maxShots).toBe(10);
    expect(readAutoRepairConfig(env({ MIRAFRAME_AUTO_REPAIR_MAX_SHOTS: "-1" })).maxShots).toBe(2);
    expect(readAutoRepairConfig(env({ MIRAFRAME_AUTO_REPAIR_MAX_SHOTS: "abc" })).maxShots).toBe(2);
    expect(readAutoRepairConfig(env({ MIRAFRAME_AUTO_REPAIR_MAX_SHOTS: "2.9" })).maxShots).toBe(2);
    expect(readAutoRepairConfig(env({ MIRAFRAME_AUTO_REPAIR_MAX_SHOTS: "  " })).maxShots).toBe(2);
  });
});

describe("isImageRepairAvailable", () => {
  it("fake provider 不能用来修图（会静默返回占位图）", () => {
    expect(isImageRepairAvailable(env({ IMAGE_PROVIDER: "fake" }))).toBe(false);
    expect(isImageRepairAvailable(env({ IMAGE_PROVIDER: "fake", IMAGE_API_KEY: "k" }))).toBe(false);
  });

  it("真实 provider 有 key 才算可用", () => {
    const base = {
      IMAGE_PROVIDER: "agnes",
      IMAGE_BASE_URL: "https://agnes.example/v1",
      IMAGE_MODEL: "m",
    };
    expect(isImageRepairAvailable(env(base))).toBe(false);
    expect(isImageRepairAvailable(env({ ...base, IMAGE_API_KEY: "sk-test" }))).toBe(true);
  });

  it("多 provider 链里只要有一家能用就行", () => {
    const values = {
      IMAGE_PROVIDERS: "fake, agnes",
      IMAGE_BASE_URL: "https://agnes.example/v1",
      IMAGE_AGNES_API_KEY: "sk-test",
    };
    expect(isImageRepairAvailable(env(values))).toBe(true);
  });

  it("未配置任何 provider 时按 fake 处理", () => {
    expect(isImageRepairAvailable(env({}))).toBe(false);
  });
});

describe("worstDistanceOf", () => {
  it("没有结果或没有距离时返回 null", () => {
    expect(worstDistanceOf(null)).toBeNull();
    expect(worstDistanceOf(stored({ expected: [] }))).toBeNull();
    expect(
      worstDistanceOf(
        stored({
          expected: [{ characterId: 1, name: "A", status: "no_reference", distance: null }],
        }),
      ),
    ).toBeNull();
  });

  it("取多角色里最大的距离", () => {
    const result = stored({
      expected: [
        { characterId: 1, name: "A", status: "consistent", distance: 0.31 },
        { characterId: 2, name: "B", status: "drift", distance: 0.78 },
        { characterId: 3, name: "C", status: "review", distance: 0.55 },
      ],
    });
    expect(worstDistanceOf(result)).toBe(0.78);
  });

  it("忽略非有限值，不让 NaN 污染排序", () => {
    const result = stored({
      expected: [
        { characterId: 1, name: "A", status: "drift", distance: Number.NaN },
        { characterId: 2, name: "B", status: "drift", distance: 0.66 },
      ],
    });
    expect(worstDistanceOf(result)).toBe(0.66);
  });
});

describe("planAutoRepair", () => {
  it("只修漂移，灰区与一致都不动（灰区重画大概率白花钱）", () => {
    const plan = planAutoRepair(
      [
        candidate({ shotId: 1, order: 1, verdict: "drift" }),
        candidate({ shotId: 2, order: 2, verdict: "review" }),
        candidate({ shotId: 3, order: 3, verdict: "ok" }),
        candidate({ shotId: 4, order: 4, verdict: "unverifiable" }),
      ],
      5,
    );
    expect(plan.selected.map((item) => item.shotId)).toEqual([1]);
    expect(plan.skipped).toEqual([
      { shotId: 2, reason: "not_drift" },
      { shotId: 3, reason: "not_drift" },
      { shotId: 4, reason: "not_drift" },
    ]);
  });

  it("没有参考图的漂移镜头不修（修了也是空提示词）", () => {
    const plan = planAutoRepair([candidate({ shotId: 9, referenceCount: 0 })], 3);
    expect(plan.selected).toEqual([]);
    expect(plan.skipped).toEqual([{ shotId: 9, reason: "no_references" }]);
  });

  it("按漂移程度从重到轻排，距离相同按镜头顺序", () => {
    const plan = planAutoRepair(
      [
        candidate({ shotId: 1, order: 1, worstDistance: 0.61 }),
        candidate({ shotId: 2, order: 2, worstDistance: 0.92 }),
        candidate({ shotId: 3, order: 3, worstDistance: 0.61 }),
        candidate({ shotId: 4, order: 4, worstDistance: null }),
      ],
      4,
    );
    expect(plan.selected.map((item) => item.shotId)).toEqual([2, 1, 3, 4]);
  });

  it("预算用完就停，多出来的标 over_budget（钱花在最难看的那几张上）", () => {
    const plan = planAutoRepair(
      [
        candidate({ shotId: 1, order: 1, worstDistance: 0.7 }),
        candidate({ shotId: 2, order: 2, worstDistance: 0.9 }),
        candidate({ shotId: 3, order: 3, worstDistance: 0.8 }),
      ],
      2,
    );
    expect(plan.selected.map((item) => item.shotId)).toEqual([2, 3]);
    expect(plan.skipped).toEqual([{ shotId: 1, reason: "over_budget" }]);
  });

  it("预算为 0 时一个都不修", () => {
    const plan = planAutoRepair([candidate({ shotId: 1 })], 0);
    expect(plan.selected).toEqual([]);
    expect(plan.skipped).toEqual([{ shotId: 1, reason: "over_budget" }]);
  });

  it("空列表不报错", () => {
    expect(planAutoRepair([], 2)).toEqual({ selected: [], skipped: [] });
  });
});

describe("runAutoRepair", () => {
  it("逐个重画并按复检判定是否真的修好", async () => {
    const repair = vi
      .fn()
      .mockResolvedValueOnce({
        shotId: 1,
        references: 3,
        after: stored({ shotId: 1, verdict: "ok" }),
      })
      .mockResolvedValueOnce({
        shotId: 2,
        references: 2,
        after: stored({ shotId: 2, verdict: "drift" }),
      })
      .mockResolvedValueOnce({ shotId: 3, references: 1, after: null });

    const plan = planAutoRepair(
      [
        candidate({ shotId: 1, order: 1, worstDistance: 0.9 }),
        candidate({ shotId: 2, order: 2, worstDistance: 0.8 }),
        candidate({ shotId: 3, order: 3, worstDistance: 0.7 }),
      ],
      3,
    );

    const outcome = await runAutoRepair({ plan, repair });

    expect(repair.mock.calls.map(([id]) => id)).toEqual([1, 2, 3]);
    expect(outcome.repaired).toEqual([
      { shotId: 1, references: 3, verdict: "ok", resolved: true },
      { shotId: 2, references: 2, verdict: "drift", resolved: false },
      { shotId: 3, references: 1, verdict: null, resolved: false },
    ]);
    expect(outcome.failed).toEqual([]);
  });

  it("单个镜头失败不影响后面的镜头，原图由修复服务保留", async () => {
    const repair = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider 401"))
      .mockResolvedValueOnce({
        shotId: 2,
        references: 2,
        after: stored({ shotId: 2, verdict: "ok" }),
      });

    const plan = planAutoRepair(
      [candidate({ shotId: 1, order: 1 }), candidate({ shotId: 2, order: 2 })],
      2,
    );
    const outcome = await runAutoRepair({ plan, repair });

    expect(outcome.failed).toEqual([{ shotId: 1, error: "provider 401" }]);
    expect(outcome.repaired).toEqual([{ shotId: 2, references: 2, verdict: "ok", resolved: true }]);
  });

  it("「无法校验」不算修好：没检出脸就不能宣称一致", async () => {
    const repair = vi.fn().mockResolvedValue({
      shotId: 1,
      references: 2,
      after: stored({ shotId: 1, verdict: "unverifiable" }),
    });
    const outcome = await runAutoRepair({
      plan: planAutoRepair([candidate({ shotId: 1 })], 2),
      repair,
    });

    expect(outcome.repaired[0]).toMatchObject({ verdict: "unverifiable", resolved: false });
  });

  it("把跳过原因原样带回，便于日志复盘", async () => {
    const plan = planAutoRepair(
      [candidate({ shotId: 1, verdict: "review" }), candidate({ shotId: 2, referenceCount: 0 })],
      2,
    );
    const outcome = await runAutoRepair({ plan, repair: vi.fn() });

    expect(outcome.repaired).toEqual([]);
    expect(outcome.skipped).toEqual([
      { shotId: 1, reason: "not_drift" },
      { shotId: 2, reason: "no_references" },
    ]);
  });
});

describe("collectRepairReferences", () => {
  const characters = [
    {
      id: 1,
      name: "沈鸢",
      imageUrl: "https://cdn/1-main.png",
      referenceImages: ["https://cdn/1-a.png", "https://cdn/1-b.png", "https://cdn/1-c.png"],
    },
    { id: 2, name: "陆沉", imageUrl: "https://cdn/2-main.png", referenceImages: null },
    { id: 3, name: "路人", imageUrl: "https://cdn/3.png", referenceImages: [] },
  ];

  it("每个角色最多 3 张，整镜最多 4 张", () => {
    const { labels, references } = collectRepairReferences([1], characters);
    expect(references).toHaveLength(3);
    expect(labels).toEqual(["沈鸢", "沈鸢", "沈鸢"]);
  });

  it("多角色按绑定顺序拼，超出整镜上限就截断", () => {
    const { labels, references } = collectRepairReferences([1, 2, 3], characters);
    expect(references).toHaveLength(4);
    expect(labels).toEqual(["沈鸢", "沈鸢", "沈鸢", "陆沉"]);
  });

  it("主图与参考图重复时去重", () => {
    const { references } = collectRepairReferences(
      [9],
      [
        {
          id: 9,
          name: "甲",
          imageUrl: "https://cdn/x.png",
          referenceImages: ["https://cdn/x.png"],
        },
      ],
    );
    expect(references).toEqual(["https://cdn/x.png"]);
  });

  it("没有绑定角色或角色没图时返回空（上层据此跳过修复）", () => {
    expect(collectRepairReferences([], characters).references).toEqual([]);
    expect(
      collectRepairReferences([4], [{ id: 4, name: "无图", imageUrl: null, referenceImages: [] }])
        .references,
    ).toEqual([]);
  });
});
