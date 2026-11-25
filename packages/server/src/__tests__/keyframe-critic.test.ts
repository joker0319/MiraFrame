import { describe, expect, it } from "vitest";
import {
  buildRegenGuidance,
  buildVisionPrompt,
  isPlaceholderImage,
  mergeBatchCritiques,
  parseVisionCritique,
  planKeyframeRegen,
  planVisionBatches,
  readKeyframeCriticConfig,
  resolveVisionModel,
  summarizeCritique,
  type VisionCritique,
  type VisionShotInput,
} from "../services/keyframe-critic";

function env(values: Record<string, string | undefined>) {
  return (key: string) => values[key];
}

function shot(overrides: Partial<VisionShotInput> = {}): VisionShotInput {
  return { shotId: 1, order: 1, description: "雨夜巷口", characterNames: ["沈鸢"], ...overrides };
}

function critique(overrides: Partial<VisionCritique> = {}): VisionCritique {
  return {
    score: 5,
    dimensions: { consistency: 5, quality: 5, style: 5, composition: 5 },
    shots: [
      {
        order: 1,
        score: 5,
        dimensions: {},
        issues: ["手指数量不对"],
        suggestions: ["让手自然垂下"],
        needsRegenerate: true,
      },
    ],
    issues: [],
    suggestions: [],
    needsRegenerate: true,
    ...overrides,
  };
}

describe("readKeyframeCriticConfig", () => {
  it("默认开启，阈值 6.5，单次 4 张、单轮 8 镜、重画预算 1", () => {
    const config = readKeyframeCriticConfig(env({}));
    expect(config).toEqual({
      enabled: true,
      threshold: 6.5,
      maxImagesPerCall: 4,
      maxShots: 8,
      regenerate: true,
      maxRegenerations: 1,
    });
  });

  it("环境变量可覆盖，且不信任越界值", () => {
    const config = readKeyframeCriticConfig(
      env({
        MIRAFRAME_KEYFRAME_CRITIC: "0",
        MIRAFRAME_KEYFRAME_CRITIC_THRESHOLD: "8",
        MIRAFRAME_KEYFRAME_CRITIC_MAX_IMAGES: "99",
        MIRAFRAME_KEYFRAME_REGEN_MAX_SHOTS: "-3",
      }),
    );
    expect(config.enabled).toBe(false);
    expect(config.threshold).toBe(8);
    expect(config.maxImagesPerCall).toBe(8); // 硬上限
    expect(config.maxRegenerations).toBe(1); // 负数回落默认值
  });

  it("阈值超过 10 回落默认，不接受 0-10 之外的值", () => {
    expect(
      readKeyframeCriticConfig(env({ MIRAFRAME_KEYFRAME_CRITIC_THRESHOLD: "11" })).threshold,
    ).toBe(6.5);
  });

  it("VISION_MODEL 只覆盖模型名，没配就沿用文本链的模型", () => {
    expect(resolveVisionModel(env({ VISION_MODEL: " qwen-vl-max " }))).toBe("qwen-vl-max");
    expect(resolveVisionModel(env({}))).toBeUndefined();
  });
});

describe("isPlaceholderImage", () => {
  it("SVG 占位图与空值都算不可审", () => {
    expect(isPlaceholderImage("data:image/svg+xml;base64,AAAA")).toBe(true);
    expect(isPlaceholderImage(null)).toBe(true);
    expect(isPlaceholderImage("https://cdn/a.png")).toBe(false);
    // 真实供应商也会返回 base64，这种是真图，要审
    expect(isPlaceholderImage("data:image/png;base64,AAAA")).toBe(false);
  });
});

describe("planVisionBatches", () => {
  it("按上限切批并保留顺序", () => {
    const shots = [1, 2, 3, 4, 5].map((order) => shot({ shotId: order, order }));
    const batches = planVisionBatches(shots, 2);
    expect(batches.map((batch) => batch.shots.map((item) => item.order))).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
    expect(batches.map((batch) => batch.index)).toEqual([1, 2, 3]);
  });

  it("上限非法时至少保证一批一张，不会死循环", () => {
    expect(planVisionBatches([shot()], 0)).toHaveLength(1);
  });
});

describe("buildVisionPrompt", () => {
  it("把「图 N = 镜头 #order」写死，并把角色与画面要求带上", () => {
    const prompt = buildVisionPrompt(
      {
        index: 1,
        shots: [shot({ order: 3, characterNames: ["沈鸢", "阿岚"], description: "回头" })],
      },
      { style: "国漫", projectTitle: "雨夜灯笼" },
    );
    expect(prompt).toContain("图 1 = 镜头 #3");
    expect(prompt).toContain("出场角色：沈鸢、阿岚");
    expect(prompt).toContain("目标画风：国漫");
    expect(prompt).toContain("项目：雨夜灯笼");
    // 关键约束必须在提示词里，否则模型会自己数图
    expect(prompt).toContain("needs_regenerate");
  });

  it("没有角色与描述时也不留空括号", () => {
    const prompt = buildVisionPrompt({
      index: 1,
      shots: [shot({ characterNames: [], description: null })],
    });
    expect(prompt).toContain("图 1 = 镜头 #1");
    expect(prompt).not.toContain("出场角色：；");
  });
});

describe("parseVisionCritique", () => {
  const valid = JSON.stringify({
    overall_score: 9.9,
    dimensions: { consistency: 6, quality: 5, style: 7, composition: 4 },
    shots: [
      {
        order: 1,
        score: 6,
        dimensions: { quality: 6 },
        issues: ["构图偏"],
        suggestions: ["拉远"],
        needs_regenerate: false,
      },
      {
        order: 2,
        score: 4,
        dimensions: { quality: 4 },
        issues: [],
        suggestions: ["重画"],
        needs_regenerate: true,
      },
    ],
    issues: ["整体偏暗"],
    suggestions: ["提高曝光"],
    needs_regenerate: true,
  });

  it("总分取镜头均值而不是模型自报值", () => {
    const { critique: result } = parseVisionCritique(valid, [1, 2]);
    // (6 + 4) / 2 = 5，模型嘴上说 9.9
    expect(result.score).toBe(5);
    expect(result.issues).toEqual(["整体偏暗"]);
    expect(result.needsRegenerate).toBe(true);
  });

  it("能剥 ```json 围栏和前后解释文字", () => {
    const wrapped = `好的，以下是评审结果：\n\`\`\`json\n${valid}\n\`\`\`\n希望有帮助。`;
    expect(parseVisionCritique(wrapped, [1, 2]).critique.shots).toHaveLength(2);
  });

  it("漏评的镜头记进 missingOrders，不补满分", () => {
    const { critique: result, missingOrders } = parseVisionCritique(valid, [1, 2, 3]);
    expect(missingOrders).toEqual([3]);
    expect(result.shots.map((item) => item.order)).toEqual([1, 2]);
  });

  it("多给的镜头（串批）不参与统计", () => {
    const { critique: result } = parseVisionCritique(valid, [1]);
    expect(result.shots).toHaveLength(1);
    expect(result.score).toBe(6);
  });

  it("needs_regenerate 只认 true：字符串 'true'、1 都不算", () => {
    const raw = JSON.stringify({
      shots: [
        { order: 1, score: 5, needs_regenerate: "true" },
        { order: 2, score: 5, needs_regenerate: 1 },
      ],
    });
    const { critique: result } = parseVisionCritique(raw, [1, 2]);
    expect(result.shots.every((item) => item.needsRegenerate === false)).toBe(true);
  });

  it("分数被夹到 0-10，非法分数丢弃该镜头", () => {
    const raw = JSON.stringify({
      shots: [
        { order: 1, score: 15 },
        { order: 2, score: -2 },
        { order: 3, score: "不是数字" },
      ],
    });
    const { critique: result, missingOrders } = parseVisionCritique(raw, [1, 2, 3]);
    expect(result.shots.map((item) => item.score)).toEqual([10, 0]);
    expect(missingOrders).toEqual([3]);
  });

  it("没有 JSON 时抛错，交给调用方降级", () => {
    expect(() => parseVisionCritique("模型今天不想说话", [1])).toThrow(/没有 JSON/);
  });

  it("维度按镜头平均；镜头没给维度时退回整体维度", () => {
    const withDims = parseVisionCritique(valid, [1, 2]).critique;
    expect(withDims.dimensions).toEqual({ quality: 5 });

    const noShotDims = parseVisionCritique(
      JSON.stringify({ dimensions: { consistency: 7 }, shots: [{ order: 1, score: 7 }] }),
      [1],
    ).critique;
    expect(noShotDims.dimensions).toEqual({ consistency: 7 });
  });
});

describe("mergeBatchCritiques", () => {
  it("按镜头重新平均，不被小批次带偏", () => {
    const first = parseVisionCritique(
      JSON.stringify({
        shots: [
          { order: 1, score: 9 },
          { order: 2, score: 9 },
        ],
      }),
      [1, 2],
    );
    const second = parseVisionCritique(JSON.stringify({ shots: [{ order: 3, score: 3 }] }), [3]);
    const merged = mergeBatchCritiques([first, second]);
    // 三镜均值 7，而不是两批均值 (9+3)/2 = 6
    expect(merged.critique.score).toBe(7);
    expect(merged.critique.shots).toHaveLength(3);
  });

  it("漏评与问题清单跨批合并", () => {
    const first = parseVisionCritique(
      JSON.stringify({ shots: [{ order: 1, score: 8, issues: ["a"] }] }),
      [1, 2],
    );
    const second = parseVisionCritique(
      JSON.stringify({ shots: [{ order: 3, score: 5, issues: ["b"] }] }),
      [3],
    );
    const merged = mergeBatchCritiques([first, second]);
    expect(merged.missingOrders).toEqual([2]);
    expect(merged.critique.shots.flatMap((item) => item.issues)).toEqual(["a", "b"]);
  });

  it("单批时原样返回", () => {
    const only = parseVisionCritique(JSON.stringify({ shots: [{ order: 1, score: 8 }] }), [1]);
    expect(mergeBatchCritiques([only])).toBe(only);
  });
});

describe("planKeyframeRegen", () => {
  const config = { ...readKeyframeCriticConfig(env({})), maxRegenerations: 2 };

  function candidateShot(
    overrides: Partial<{
      shotId: number;
      order: number;
      basePrompt: string;
      referenceCount: number;
    }> = {},
  ) {
    return { ...shot(), basePrompt: "雨夜巷口，少女撑伞", referenceCount: 2, ...overrides };
  }

  it("必须同时满足「明确要重画」和「分数低于阈值」", () => {
    const plan = planKeyframeRegen(
      [candidateShot({ order: 1 })],
      critique({
        shots: [
          {
            order: 1,
            score: 6,
            dimensions: {},
            issues: [],
            suggestions: [],
            needsRegenerate: false,
          },
        ],
      }),
      config,
    );
    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe("passed");

    const highScore = planKeyframeRegen(
      [candidateShot({ order: 1 })],
      critique({
        shots: [
          {
            order: 1,
            score: 8.5,
            dimensions: {},
            issues: [],
            suggestions: [],
            needsRegenerate: true,
          },
        ],
      }),
      config,
    );
    expect(highScore.selected).toHaveLength(0);
  });

  it("没有参考图不重画（没有保脸的约束，重画只会换一张脸）", () => {
    const plan = planKeyframeRegen([candidateShot({ referenceCount: 0 })], critique(), config);
    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe("no_references");
  });

  it("没有基础提示词不重画", () => {
    const plan = planKeyframeRegen([candidateShot({ basePrompt: "  " })], critique(), config);
    expect(plan.skipped[0].reason).toBe("no_prompt");
  });

  it("按分数从低到高取，超出预算的标 over_budget", () => {
    const shots = [
      candidateShot({ shotId: 1, order: 1 }),
      candidateShot({ shotId: 2, order: 2 }),
      candidateShot({ shotId: 3, order: 3 }),
    ];
    const result = critique({
      shots: [
        { order: 1, score: 5, dimensions: {}, issues: [], suggestions: [], needsRegenerate: true },
        { order: 2, score: 3, dimensions: {}, issues: [], suggestions: [], needsRegenerate: true },
        { order: 3, score: 4, dimensions: {}, issues: [], suggestions: [], needsRegenerate: true },
      ],
    });
    const plan = planKeyframeRegen(shots, result, { ...config, maxRegenerations: 2 });
    expect(plan.selected.map((item) => item.order)).toEqual([2, 3]);
    expect(
      plan.skipped.filter((item) => item.reason === "over_budget").map((item) => item.order),
    ).toEqual([1]);
  });

  it("预算为 0 时一个都不修", () => {
    const plan = planKeyframeRegen([candidateShot()], critique(), {
      ...config,
      maxRegenerations: 0,
    });
    expect(plan.selected).toHaveLength(0);
  });
});

describe("buildRegenGuidance", () => {
  it("只拼 suggestions，最多 5 条", () => {
    const guidance = buildRegenGuidance(["让手自然垂下", "提高曝光", "去掉水印", "a", "b", "c"]);
    expect(guidance).toContain("让手自然垂下");
    expect(guidance).toContain("【画面修正要求】");
    expect(guidance.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(5);
  });

  it("没有建议时返回空串，调用方据此不拼段落", () => {
    expect(buildRegenGuidance([])).toBe("");
    expect(buildRegenGuidance(["  "])).toBe("");
  });
});

describe("summarizeCritique", () => {
  it("分数、判定、问题数、漏评都要说清楚", () => {
    const text = summarizeCritique(critique({ score: 7.6, issues: ["a", "b"] }), [4], 6.5);
    expect(text).toContain("7.6 分");
    expect(text).toContain("通过");
    expect(text).toContain("2 个问题");
    expect(text).toContain("#4 未返回评分");
  });

  it("未达标时写明未达标", () => {
    expect(summarizeCritique(critique({ score: 4 }), [], 6.5)).toContain("未达标");
  });
});
