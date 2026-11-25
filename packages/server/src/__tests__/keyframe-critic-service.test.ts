import { describe, expect, it, vi } from "vitest";
import { createCanvas } from "canvas";
import { KeyframeCriticService } from "../services/keyframe-critic.service";

/**
 * 这层测编排：取图、分批、调模型、解析、按预算重画。
 * 判定规则在 keyframe-critic.test.ts，协议格式在 text-vision.test.ts。
 */

/** 真实的小 PNG：让压缩与 base64 走真实路径，而不是 mock 掉编码 */
function pngDataUrl(color = "#334455"): string {
  const canvas = createCanvas(32, 32);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 32, 32);
  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}

const IMAGE = pngDataUrl();

function makeConfig(values: Record<string, string | undefined> = {}) {
  return { get: (key: string) => values[key] } as never;
}

/** 链式查询替身：任意终止方法都能 await，按调用顺序取下一组行 */
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

function shotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    projectId: 7,
    order: 1,
    description: "雨夜巷口",
    prompt: "雨夜巷口，少女撑伞",
    imagePrompt: "雨夜巷口，少女撑伞，水墨风",
    imageUrl: IMAGE,
    characterIds: [5],
    ...overrides,
  };
}

/** 一次 reviewProject 的查询顺序：project → shots → characters → bindings */
function rows(options: { shots?: unknown[]; characters?: unknown[]; bindings?: unknown[] } = {}) {
  return [
    [{ id: 7, title: "雨夜灯笼", style: "国漫" }],
    options.shots ?? [shotRow()],
    options.characters ?? [
      { id: 5, name: "沈鸢", imageUrl: "https://cdn/shen.png", referenceImages: null },
    ],
    options.bindings ?? [{ shotId: 11, characterId: 5 }],
  ];
}

function critiqueJson(shots: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    overall_score: 9.9,
    dimensions: { consistency: 7, quality: 6, style: 7, composition: 6 },
    shots,
    issues: [],
    suggestions: [],
    needs_regenerate: false,
    ...extra,
  });
}

function build(options: {
  db: unknown;
  text: unknown;
  repair?: unknown;
  values?: Record<string, string | undefined>;
}) {
  return new KeyframeCriticService(
    options.db as never,
    makeConfig(options.values) as never,
    options.text as never,
    (options.repair ?? {}) as never,
  );
}

describe("KeyframeCriticService.reviewProject", () => {
  it("开关关闭时直接返回，不查库也不调模型", async () => {
    const select = vi.fn();
    const text = { generateVision: vi.fn() };
    const service = build({
      db: { select } as never,
      text,
      values: { MIRAFRAME_KEYFRAME_CRITIC: "0" },
    });

    await expect(service.reviewProject(7)).resolves.toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(text.generateVision).not.toHaveBeenCalled();
  });

  it("全是占位图时跳过：审灰色方块没有信息量", async () => {
    const text = { generateVision: vi.fn() };
    const service = build({
      db: makeDb(rows({ shots: [shotRow({ imageUrl: "data:image/svg+xml;base64,AAAA" })] })),
      text,
    });

    await expect(service.reviewProject(7)).resolves.toBeNull();
    expect(text.generateVision).not.toHaveBeenCalled();
  });

  it("一次调用审多张图，提示词里写明镜头对应关系", async () => {
    const text = {
      generateVision: vi.fn().mockResolvedValue(critiqueJson([{ order: 1, score: 8 }])),
    };
    const service = build({
      db: makeDb(
        rows({
          shots: [
            shotRow({ id: 11, order: 1 }),
            shotRow({ id: 12, order: 2, description: "灯亮" }),
          ],
          bindings: [
            { shotId: 11, characterId: 5 },
            { shotId: 12, characterId: 5 },
          ],
        }),
      ),
      text,
    });

    const result = await service.reviewProject(7);

    expect(text.generateVision).toHaveBeenCalledTimes(1);
    const [prompt, images] = text.generateVision.mock.calls[0] as [string, string[]];
    expect(images).toHaveLength(2);
    expect(images[0].startsWith("data:image/jpeg;base64,")).toBe(true); // 压过再发
    expect(prompt).toContain("图 1 = 镜头 #1");
    expect(prompt).toContain("图 2 = 镜头 #2");
    expect(prompt).toContain("目标画风：国漫");
    expect(result?.critique?.score).toBe(8);
    expect(result?.batches).toBe(1);
  });

  it("超过单次上限时自动分批，分数按镜头重新平均", async () => {
    const text = {
      generateVision: vi
        .fn()
        .mockResolvedValueOnce(
          critiqueJson([
            { order: 1, score: 9 },
            { order: 2, score: 9 },
          ]),
        )
        .mockResolvedValueOnce(critiqueJson([{ order: 3, score: 3 }])),
    };
    const service = build({
      db: makeDb(
        rows({
          shots: [1, 2, 3].map((order) => shotRow({ id: 10 + order, order })),
          bindings: [1, 2, 3].map((order) => ({ shotId: 10 + order, characterId: 5 })),
        }),
      ),
      text,
      values: { MIRAFRAME_KEYFRAME_CRITIC_MAX_IMAGES: "2" },
    });

    const result = await service.reviewProject(7);

    expect(text.generateVision).toHaveBeenCalledTimes(2);
    expect((text.generateVision.mock.calls[1][1] as string[]).length).toBe(1);
    expect(result?.critique?.score).toBe(7);
    expect(result?.batches).toBe(2);
  });

  it("单张取图失败只剔除该镜头，其余照常审", async () => {
    const text = {
      generateVision: vi.fn().mockResolvedValue(critiqueJson([{ order: 2, score: 7 }])),
    };
    const service = build({
      db: makeDb(
        rows({
          shots: [
            shotRow({ id: 11, order: 1, imageUrl: "https://unreachable.example/a.png" }),
            shotRow({ id: 12, order: 2 }),
          ],
          bindings: [
            { shotId: 11, characterId: 5 },
            { shotId: 12, characterId: 5 },
          ],
        }),
      ),
      text,
    });

    // 真实 fetch 会失败；这里换成直接抛错，避免测试等网络超时
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    try {
      const result = await service.reviewProject(7);
      expect(result?.unavailable).toEqual([
        { shotId: 11, order: 1, error: expect.stringContaining("ECONNREFUSED") },
      ]);
      expect(result?.reviewed).toEqual([{ shotId: 12, order: 2 }]);
      expect(text.generateVision).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("模型返回坏 JSON 时不抛错，只是这一轮没有结论", async () => {
    const text = { generateVision: vi.fn().mockResolvedValue("我不想返回 JSON") };
    const service = build({ db: makeDb(rows()), text });

    await expect(service.reviewProject(7)).resolves.toBeNull();
  });

  it("模型调用整体失败时返回 null，由流水线兜住", async () => {
    const text = {
      generateVision: vi.fn().mockRejectedValue(new Error("所有视觉 provider 均失败")),
    };
    const service = build({ db: makeDb(rows()), text });

    await expect(service.reviewProject(7)).resolves.toBeNull();
  });

  it("问题清单合并分镜头问题并带镜头号，漏评单独补一条", async () => {
    const text = {
      generateVision: vi.fn().mockResolvedValue(
        critiqueJson([{ order: 1, score: 5, issues: ["手指畸形"], suggestions: ["让手垂下"] }], {
          issues: ["整体偏暗"],
        }),
      ),
    };
    const service = build({
      db: makeDb(
        rows({
          shots: [shotRow({ id: 11, order: 1 }), shotRow({ id: 12, order: 2 })],
          bindings: [
            { shotId: 11, characterId: 5 },
            { shotId: 12, characterId: 5 },
          ],
        }),
      ),
      text,
    });

    const result = await service.reviewProject(7);
    const issues = result?.critique?.issues ?? [];
    expect(issues).toContain("整体偏暗");
    expect(issues).toContain("镜头 #1：手指畸形");
    expect(issues.some((item) => item.includes("#2"))).toBe(true);
  });
});

describe("KeyframeCriticService 重画", () => {
  const failing = [
    {
      order: 1,
      score: 4,
      issues: ["手指畸形"],
      suggestions: ["让手自然垂下"],
      needs_regenerate: true,
    },
  ];

  it("分数低于阈值且模型要求重画时，按参考图重画并带上修正要求", async () => {
    const text = {
      generateVision: vi.fn().mockResolvedValue(critiqueJson(failing, { needs_regenerate: true })),
    };
    const repair = {
      repairWithReferences: vi
        .fn()
        .mockResolvedValue({ shotId: 11, imageUrl: "https://cdn/new.png", references: 1 }),
    };
    const service = build({ db: makeDb(rows()), text, repair });

    const result = await service.reviewProject(7);

    expect(repair.repairWithReferences).toHaveBeenCalledTimes(1);
    const [projectId, shotId, options] = repair.repairWithReferences.mock.calls[0] as [
      number,
      number,
      { extraPrompt?: string },
    ];
    expect(projectId).toBe(7);
    expect(shotId).toBe(11);
    expect(options.extraPrompt).toContain("让手自然垂下");
    expect(result?.regenerated).toEqual([
      { shotId: 11, order: 1, imageUrl: "https://cdn/new.png" },
    ]);
  });

  it("模型只是挑刺但没要求重画时不动图", async () => {
    const text = {
      generateVision: vi
        .fn()
        .mockResolvedValue(
          critiqueJson([
            {
              order: 1,
              score: 4,
              issues: ["略暗"],
              suggestions: ["提亮"],
              needs_regenerate: false,
            },
          ]),
        ),
    };
    const repair = { repairWithReferences: vi.fn() };
    const service = build({ db: makeDb(rows()), text, repair });

    const result = await service.reviewProject(7);

    expect(repair.repairWithReferences).not.toHaveBeenCalled();
    expect(result?.regenerated).toHaveLength(0);
  });

  it("重画预算为 0 时只出结论不动手", async () => {
    const text = {
      generateVision: vi.fn().mockResolvedValue(critiqueJson(failing, { needs_regenerate: true })),
    };
    const repair = { repairWithReferences: vi.fn() };
    const service = build({
      db: makeDb(rows()),
      text,
      repair,
      values: { MIRAFRAME_KEYFRAME_REGEN_MAX_SHOTS: "0" },
    });

    await service.reviewProject(7);
    expect(repair.repairWithReferences).not.toHaveBeenCalled();
  });

  it("没有参考图的镜头跳过重画并记录原因", async () => {
    const text = {
      generateVision: vi.fn().mockResolvedValue(critiqueJson(failing, { needs_regenerate: true })),
    };
    const repair = { repairWithReferences: vi.fn() };
    const service = build({
      db: makeDb(
        rows({ characters: [{ id: 5, name: "沈鸢", imageUrl: null, referenceImages: null }] }),
      ),
      text,
      repair,
    });

    const result = await service.reviewProject(7);

    expect(repair.repairWithReferences).not.toHaveBeenCalled();
    expect(result?.regenSkipped).toEqual([{ shotId: 11, order: 1, reason: "no_references" }]);
  });

  it("重画失败只记录，不影响已经拿到的审查结论", async () => {
    const text = {
      generateVision: vi.fn().mockResolvedValue(critiqueJson(failing, { needs_regenerate: true })),
    };
    const repair = {
      repairWithReferences: vi.fn().mockRejectedValue(new Error("图像服务未配置（返回了占位图）")),
    };
    const service = build({ db: makeDb(rows()), text, repair });

    const result = await service.reviewProject(7);

    expect(result?.critique?.score).toBe(4);
    expect(result?.regenFailed).toEqual([
      { shotId: 11, order: 1, error: "图像服务未配置（返回了占位图）" },
    ]);
  });

  it("重画开关关闭时即使模型要求也不动图", async () => {
    const text = {
      generateVision: vi.fn().mockResolvedValue(critiqueJson(failing, { needs_regenerate: true })),
    };
    const repair = { repairWithReferences: vi.fn() };
    const service = build({
      db: makeDb(rows()),
      text,
      repair,
      values: { MIRAFRAME_KEYFRAME_REGEN: "0" },
    });

    await service.reviewProject(7);
    expect(repair.repairWithReferences).not.toHaveBeenCalled();
  });
});
