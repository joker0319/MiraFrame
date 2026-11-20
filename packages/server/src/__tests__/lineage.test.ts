import { describe, it, expect } from "vitest";
import { matchCharacterIds, analyzeCharacterImpact, buildArtifactLineage } from "../agent/lineage.js";
import { RevisionService } from "../agent/revision.service.js";
import { schema } from "../db/index.js";

const characters = [
  { id: 1, name: "林小雨" },
  { id: 2, name: "星灯" },
];

describe("产物血缘", () => {
  it("从分镜文本识别全名与简称", () => {
    expect(matchCharacterIds("林小雨在雨夜街角撑伞", characters)).toEqual([1]);
    expect(matchCharacterIds("小雨抬头看见星灯", characters)).toEqual([1, 2]);
    expect(matchCharacterIds("空无一人的街道", characters)).toEqual([]);
    expect(matchCharacterIds("", characters)).toEqual([]);
  });

  it("只把引用变更角色的镜头标脏，其余复用", () => {
    const shots = [
      { id: 1, characterIds: [1], imageUrl: "a.png", videoUrl: "a.mp4" },
      { id: 2, characterIds: [2], imageUrl: "b.png", videoUrl: "b.mp4" },
      { id: 3, characterIds: [1, 2], imageUrl: "c.png", videoUrl: "c.mp4" },
      { id: 4, characterIds: [], imageUrl: "d.png", videoUrl: "d.mp4" },
    ];

    const impact = analyzeCharacterImpact(shots, [1]);

    expect(impact.affected).toEqual([1, 3]);
    expect(impact.reused).toEqual([2, 4]);
  });

  it("构建 state 可读的血缘映射", () => {
    const lineage = buildArtifactLineage([
      { id: 3, characterIds: [1, 2] },
      { id: 7, characterIds: [1] },
    ]);
    expect(lineage).toEqual({
      "character:1": ["shot:3", "shot:7"],
      "character:2": ["shot:3"],
    });
  });
});

describe("RevisionService 增量标脏", () => {
  it("角色变更时只清空受影响镜头的画面，保留其余产物", async () => {
    const shots = [
      { id: 1, characterIds: [1], prompt: "p1", imagePrompt: "i1", imageUrl: "a.png", videoUrl: "a.mp4" },
      { id: 2, characterIds: [2], prompt: "p2", imagePrompt: "i2", imageUrl: "b.png", videoUrl: "b.mp4" },
    ];
    const characterRows = [{ id: 1 }, { id: 2 }];
    const updates: Array<Record<string, unknown>> = [];

    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: async () => (table === schema.shots ? shots : characterRows),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return { where: async () => [] };
        },
      }),
    } as never;

    const service = new RevisionService(db);
    const impact = await service.prepareAssets({
      projectId: 1,
      entityType: "character",
      entityId: 1,
      content: "把小雨的发型改短",
      feedbackType: "style",
    });

    expect(impact).toEqual({ changedCharacters: 1, affectedShots: 1, reusedShots: 1 });
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ imageUrl: null, referenceImages: [] });
    expect(updates[1]).toMatchObject({ imageUrl: null, videoUrl: null });
  });
});
