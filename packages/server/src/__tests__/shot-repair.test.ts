import { describe, expect, it, vi } from "vitest";
import { buildAgnesImageBody } from "../services/image.service";
import { buildRepairPrompt, ShotRepairService } from "../services/shot-repair.service";

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.orderBy = async () => rows;
  chain.limit = async () => rows;
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

describe("buildAgnesImageBody", () => {
  it("文生图不带 extra_body，保持原请求体", () => {
    expect(buildAgnesImageBody("agnes-image-2.5-flash", "a cat", "1024x1024")).toEqual({
      model: "agnes-image-2.5-flash",
      prompt: "a cat",
      n: 1,
      size: "1024x1024",
    });
  });

  it("图生图把参考图放进 extra_body.image，response_format 不在顶层", () => {
    const body = buildAgnesImageBody("agnes-image-2.5-flash", "keep the face", "1K", [
      "https://example.com/a.png",
      "https://example.com/b.png",
    ]);
    expect(body.extra_body).toEqual({
      image: ["https://example.com/a.png", "https://example.com/b.png"],
      response_format: "url",
    });
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("image");
  });
});

describe("buildRepairPrompt", () => {
  it("逐张标明参考图属于哪个角色，并要求保留原分镜与画风", () => {
    const prompt = buildRepairPrompt("Create a storyboard key frame for shot 3.", ["沈鸢", "沈鸢", "阿砚"]);
    expect(prompt).toContain("Create a storyboard key frame for shot 3.");
    expect(prompt).toContain("第 1 张：沈鸢");
    expect(prompt).toContain("第 3 张：阿砚");
    expect(prompt).toContain("不要增加分镜里没有出现的角色");
  });
});

describe("ShotRepairService.repairWithReferences", () => {
  it("收集绑定角色的参考图，重画镜头并只回写这一张的一致性", async () => {
    const shot = {
      id: 101,
      order: 3,
      imagePrompt: "原提示词",
      prompt: null,
      imageUrl: "https://example.com/old.png",
      videoUrl: "https://example.com/old.mp4",
      characterIds: [35, 36],
      consistencyResult: { verdict: "drift" },
    };
    const characters = [
      { id: 35, name: "沈鸢", imageUrl: "https://example.com/shen.png", referenceImages: ["https://example.com/shen2.png"] },
      { id: 36, name: "阿砚", imageUrl: null, referenceImages: [] },
      { id: 37, name: "度魂使", imageUrl: "https://example.com/other.png", referenceImages: [] },
    ];
    const selectResults = [ [shot], characters ];
    const updates: Array<{ id: number; value: Record<string, unknown> }> = [];
    const db = {
      select: vi.fn(() => {
        const rows = selectResults.shift() ?? [];
        return selectChain(rows);
      }),
      update: () => ({
        set: (value: Record<string, unknown>) => ({
          where: async () => {
            updates.push({ id: 101, value });
          },
        }),
      }),
    };
    const stored = { shotId: 101, order: 3, verdict: "ok", expected: [], extraFaces: [], message: "一致", checkedAt: "now" };
    const image = { generateImage: vi.fn(async () => "https://example.com/new.png") };
    const consistency = { analyzeShotAndStore: vi.fn(async () => stored) };

    const service = new ShotRepairService(db as never, image as never, consistency as never);
    const result = await service.repairWithReferences(23, 101);

    expect(result).toEqual({
      shotId: 101,
      imageUrl: "https://example.com/new.png",
      references: 2,
      before: { verdict: "drift" },
      after: stored,
    });
    expect(image.generateImage).toHaveBeenCalledTimes(1);
    const [prompt, options] = (image.generateImage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { referenceImages: string[] }];
    expect(prompt).toContain("第 1 张：沈鸢");
    expect(options.referenceImages).toEqual(["https://example.com/shen.png", "https://example.com/shen2.png"]);
    expect(updates[0].value).toMatchObject({ imageUrl: "https://example.com/new.png", videoUrl: null, consistencyResult: null });
    expect(consistency.analyzeShotAndStore).toHaveBeenCalledTimes(1);
  });

  it("角色没有参考图时直接报错，不调用图像接口", async () => {
    const shot = { id: 102, order: 4, imagePrompt: "提示词", characterIds: [99], consistencyResult: null };
    const selectResults: unknown[][] = [[shot], []];
    const db = {
      select: vi.fn(() => selectChain(selectResults.shift() ?? [])),
      update: vi.fn(),
    };
    const image = { generateImage: vi.fn() };
    const consistency = { analyzeShotAndStore: vi.fn() };
    const service = new ShotRepairService(db as never, image as never, consistency as never);

    await expect(service.repairWithReferences(23, 102)).rejects.toThrow("参考图");
    expect(image.generateImage).not.toHaveBeenCalled();
  });
});
