import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsistencyService } from "../services/consistency.service";

/** 128 维单位向量，固定 seed 保证与角色参考一致 */
function vec(seed: number, dim = 128): number[] {
  const v = Array.from({ length: dim }, (_, i) => Math.sin(seed * 13.37 + i * 0.71));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function makeDb() {
  const updates: Array<{ id: number; value: Record<string, unknown> }> = [];
  let whereId = 0;
  const db = {
    update: () => ({
      set: (value: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ id: whereId, value });
          return [];
        },
      }),
    }),
    setWhereId: (id: number) => { whereId = id; },
  };
  return { db, updates };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConsistencyService.analyzeAndStore", () => {
  it("把每个镜头的判定写到 shot 上，并带上检查时间", async () => {
    const { db, updates } = makeDb();
    const face = {
      isReady: () => true,
      getError: () => null,
      detect: vi.fn(async () => [
        { descriptor: vec(1), score: 0.95, box: { x: 0, y: 0, width: 40, height: 40 } },
      ]),
    };
    const config = { get: () => undefined };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.alloc(2048, 1))));

    const service = new ConsistencyService(face as never, config as never, db as never);

    // 两次更新分别对应两个镜头；db mock 用 setWhereId 切换 where 条件
    const runPromise = service.analyzeAndStore({
      projectId: 23,
      characters: [{ id: 35, name: "沈鸢", imageUrl: "https://example.com/ref.png", referenceImages: null }],
      shots: [
        { id: 101, order: 1, imageUrl: "https://example.com/s1.png", characterIds: [35] },
        { id: 102, order: 2, imageUrl: "https://example.com/s2.png", characterIds: [35] },
      ],
    });

    // 等异步分析推进到写库阶段后，让 mock 的 where 命中不同 id
    db.setWhereId(101);
    await new Promise((resolve) => setImmediate(resolve));
    db.setWhereId(102);

    const run = await runPromise;
    expect(run.report.shots).toHaveLength(2);
    expect(run.report.summary.ok).toBe(2);
    expect(run.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(run.stored[0].consistencyResult.checkedAt).toBe(run.checkedAt);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0].value).toHaveProperty("consistencyResult");
  });
});
