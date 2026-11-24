import { describe, expect, it, vi } from "vitest";
import { AgentProcessor } from "../agent/agent.processor";
import type { StoredShotConsistency } from "../services/consistency";

/**
 * 这层测的是编排：谁该被修、图像服务能不能修、修完广播什么。
 * 判定规则本身在 auto-repair.test.ts 里，这里只依赖它的输出形状。
 */

function stored(overrides: Partial<StoredShotConsistency> = {}): StoredShotConsistency {
  return {
    shotId: 11,
    order: 1,
    expected: [{ characterId: 5, name: "沈鸢", status: "drift", distance: 0.82 }],
    extraFaces: [],
    verdict: "drift",
    message: "",
    checkedAt: "2026-11-25T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(
  entries: Array<{
    shotId: number;
    order: number;
    characterIds?: number[];
    verdict?: StoredShotConsistency["verdict"];
  }>,
) {
  return {
    run: {
      report: {
        thresholds: { ok: 0.45, drift: 0.6, matchLimit: 0.85 },
        characters: [],
        shots: [],
        summary: { ok: 0, review: 0, drift: 0, unverifiable: 0 },
      },
      checkedAt: "2026-11-25T00:00:00.000Z",
      stored: entries.map((entry) => ({
        shotId: entry.shotId,
        consistencyResult: stored({
          shotId: entry.shotId,
          order: entry.order,
          verdict: entry.verdict ?? "drift",
        }),
      })),
    },
    shots: entries.map((entry) => ({
      id: entry.shotId,
      order: entry.order,
      imageUrl: `https://cdn/shot-${entry.shotId}.png`,
      characterIds: entry.characterIds ?? [5],
    })),
    characters: [{ id: 5, name: "沈鸢", imageUrl: "https://cdn/shen.png", referenceImages: null }],
  };
}

/** 链式查询的替身：用 thenable 让任意终止方法都能被 await。 */
function makeDb(responses: unknown[][]) {
  let cursor = 0;
  const builder: Record<string, unknown> = {
    from: () => builder,
    innerJoin: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(responses[cursor++] ?? []).then(resolve, reject),
  };
  return { select: () => builder } as never;
}

function shotRow(id: number, order: number) {
  return {
    id,
    projectId: 7,
    order,
    description: "雨夜巷口",
    camera: "近景",
    scene: "巷口",
    action: "回头",
    dialogue: null,
    imageUrl: `https://cdn/fixed-${id}.png`,
    videoUrl: null,
    duration: 5,
    prompt: "p",
    imagePrompt: "ip",
    consistencyResult: stored({ shotId: id, order, verdict: "ok" }),
    approvalVersion: 0,
  };
}

function build(options: {
  values: Record<string, string>;
  db: unknown;
  repair: unknown;
  ws: unknown;
}) {
  return new AgentProcessor(
    {} as never,
    {} as never,
    options.db as never,
    options.ws as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    options.repair as never,
    { get: (key: string) => options.values[key] } as never,
    {} as never,
  );
}

const LIVE_IMAGE = {
  IMAGE_PROVIDER: "agnes",
  IMAGE_BASE_URL: "https://agnes.example/v1",
  IMAGE_MODEL: "agnes-image",
  IMAGE_API_KEY: "sk-test",
};

async function run(processor: AgentProcessor, snap: unknown) {
  await (
    processor as unknown as {
      autoRepairDriftedShots: (projectId: number, snapshot: unknown) => Promise<void>;
    }
  ).autoRepairDriftedShots(7, snap);
}

describe("AgentProcessor 自动修复编排", () => {
  it("fake provider 直接跳过：不能把真图换成占位图", async () => {
    const repair = { repairWithReferences: vi.fn() };
    const ws = { sendToProject: vi.fn() };
    const processor = build({
      values: { IMAGE_PROVIDER: "fake" },
      db: makeDb([]),
      repair,
      ws,
    });

    await run(processor, snapshot([{ shotId: 11, order: 1 }]));

    expect(repair.repairWithReferences).not.toHaveBeenCalled();
    expect(ws.sendToProject).not.toHaveBeenCalled();
  });

  it("缺 key 同样跳过（generateImage 会静默返回占位图）", async () => {
    const repair = { repairWithReferences: vi.fn() };
    const ws = { sendToProject: vi.fn() };
    const processor = build({
      values: { ...LIVE_IMAGE, IMAGE_API_KEY: "" },
      db: makeDb([]),
      repair,
      ws,
    });

    await run(processor, snapshot([{ shotId: 11, order: 1 }]));

    expect(repair.repairWithReferences).not.toHaveBeenCalled();
  });

  it("配置关掉就不修", async () => {
    const repair = { repairWithReferences: vi.fn() };
    const ws = { sendToProject: vi.fn() };
    const processor = build({
      values: { ...LIVE_IMAGE, MIRAFRAME_AUTO_REPAIR: "0" },
      db: makeDb([]),
      repair,
      ws,
    });

    await run(processor, snapshot([{ shotId: 11, order: 1 }]));

    expect(repair.repairWithReferences).not.toHaveBeenCalled();
  });

  it("检出漂移就重画，并把新图和回执广播出去", async () => {
    const repair = {
      repairWithReferences: vi.fn(async () => ({
        shotId: 11,
        imageUrl: "https://cdn/fixed-11.png",
        references: 2,
        before: stored(),
        after: stored({ verdict: "ok" }),
      })),
    };
    const ws = { sendToProject: vi.fn() };
    const processor = build({
      values: LIVE_IMAGE,
      db: makeDb([[], [shotRow(11, 1)]]),
      repair,
      ws,
    });

    await run(processor, snapshot([{ shotId: 11, order: 1 }]));

    expect(repair.repairWithReferences).toHaveBeenCalledTimes(1);
    expect(repair.repairWithReferences).toHaveBeenCalledWith(7, 11);

    const [, firstEvent, firstPayload] = ws.sendToProject.mock.calls[0];
    expect(firstEvent).toBe("shot_updated");
    expect(firstPayload).toMatchObject({ shot: { id: 11, image_url: "https://cdn/fixed-11.png" } });

    const [, secondEvent, secondPayload] = ws.sendToProject.mock.calls[1];
    expect(secondEvent).toBe("consistency_repair_completed");
    expect(secondPayload).toMatchObject({
      project_id: 7,
      source: "auto",
      repaired: [{ shot_id: 11, order: 1, references: 2, verdict: "ok", resolved: true }],
      failed: [],
    });
  });

  it("预算为 1 时只修漂得最厉害的那个，另一个记 over_budget", async () => {
    const repair = {
      repairWithReferences: vi.fn(async () => ({
        shotId: 12,
        imageUrl: "https://cdn/fixed-12.png",
        references: 2,
        before: null,
        after: stored({ shotId: 12, order: 2, verdict: "ok" }),
      })),
    };
    const ws = { sendToProject: vi.fn() };
    const snap = snapshot([
      { shotId: 11, order: 1 },
      { shotId: 12, order: 2 },
    ]);
    // 让 12 号漂得更厉害
    snap.run.stored[0].consistencyResult.expected = [
      { characterId: 5, name: "沈鸢", status: "drift", distance: 0.65 },
    ];
    snap.run.stored[1].consistencyResult.expected = [
      { characterId: 5, name: "沈鸢", status: "drift", distance: 0.95 },
    ];

    const processor = build({
      values: { ...LIVE_IMAGE, MIRAFRAME_AUTO_REPAIR_MAX_SHOTS: "1" },
      db: makeDb([[], [shotRow(12, 2)]]),
      repair,
      ws,
    });

    await run(processor, snap);

    expect(repair.repairWithReferences).toHaveBeenCalledTimes(1);
    expect(repair.repairWithReferences).toHaveBeenCalledWith(7, 12);
    const [, , payload] = ws.sendToProject.mock.calls[1];
    expect(payload).toMatchObject({
      skipped: [{ shot_id: 11, reason: "over_budget" }],
    });
  });

  it("没有漂移镜头时不重画也不发回执", async () => {
    const repair = { repairWithReferences: vi.fn() };
    const ws = { sendToProject: vi.fn() };
    const processor = build({
      values: LIVE_IMAGE,
      db: makeDb([[]]),
      repair,
      ws,
    });

    await run(processor, snapshot([{ shotId: 11, order: 1, verdict: "ok" }]));

    expect(repair.repairWithReferences).not.toHaveBeenCalled();
    expect(ws.sendToProject).not.toHaveBeenCalled();
  });

  it("修复失败只记录不改图：原 shot 保持不变", async () => {
    const repair = {
      repairWithReferences: vi.fn(async () => {
        throw new Error("角色还没有参考图");
      }),
    };
    const ws = { sendToProject: vi.fn() };
    const processor = build({
      values: LIVE_IMAGE,
      db: makeDb([[]]),
      repair,
      ws,
    });

    await run(processor, snapshot([{ shotId: 11, order: 1 }]));

    expect(ws.sendToProject).toHaveBeenCalledTimes(1);
    const [, event, payload] = ws.sendToProject.mock.calls[0];
    expect(event).toBe("consistency_repair_completed");
    expect(payload).toMatchObject({
      repaired: [],
      failed: [{ shot_id: 11, error: "角色还没有参考图" }],
    });
  });
});
