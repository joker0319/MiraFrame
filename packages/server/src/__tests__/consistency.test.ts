import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  euclideanDistance,
  evaluateShot,
  summarize,
  type CharacterReference,
  type ShotInput,
} from "../services/consistency";

/** 构造一个 128 维单位向量；用 seed 保证可复现，不同 seed 之间距离足够大 */
function vec(seed: number, dim = 128): number[] {
  const v = Array.from({ length: dim }, (_, i) => Math.sin(seed * 13.37 + i * 0.71));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/** 在基准向量上加一点扰动，模拟「同一个人但角度/光线不同」 */
function jitter(base: number[], amount: number): number[] {
  return base.map((x, i) => x + Math.sin(i * 1.7) * amount);
}

const FU = vec(1);
const YAN = vec(2);
const DU = vec(3);

const refs: CharacterReference[] = [
  { characterId: 35, name: "沈鸢", descriptors: [FU] },
  { characterId: 36, name: "阿砚", descriptors: [YAN] },
  { characterId: 37, name: "度魂使", descriptors: [DU] },
];

function shot(overrides: Partial<ShotInput>): ShotInput {
  return { shotId: 1, order: 1, expectedCharacterIds: [35], faces: [], ...overrides };
}

describe("euclideanDistance", () => {
  it("同向量距离为 0", () => {
    expect(euclideanDistance([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it("维度不一致返回 Infinity 而不是 NaN", () => {
    expect(euclideanDistance([1, 2], [1, 2, 3])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("evaluateShot", () => {
  it("同一人近距离 → consistent / ok", () => {
    const r = evaluateShot(shot({ faces: [{ descriptor: jitter(FU, 0.01), score: 0.9 }] }), refs);
    expect(r.expected[0].status).toBe("consistent");
    expect(r.verdict).toBe("ok");
    expect(r.message).toContain("与参考图一致");
  });

  it("距离落在灰区 → review，措辞是「建议人工确认」而不是「失败」", () => {
    // 找到让距离落在 0.45~0.6 之间的扰动
    let desc = jitter(FU, 0.05);
    for (let a = 0.02; a < 0.4; a += 0.01) {
      desc = jitter(FU, a);
      const d = euclideanDistance(desc, FU);
      if (d > DEFAULT_THRESHOLDS.ok + 0.02 && d < DEFAULT_THRESHOLDS.drift - 0.02) break;
    }
    const r = evaluateShot(shot({ faces: [{ descriptor: desc, score: 0.8 }] }), refs);
    expect(r.expected[0].status).toBe("review");
    expect(r.verdict).toBe("review");
    expect(r.message).toContain("人工确认");
  });

  it("距离超出 drift → drift，且优先于其他问题报告", () => {
    const r = evaluateShot(shot({ faces: [{ descriptor: YAN, score: 0.9 }] }), refs);
    expect(r.expected[0].status).toBe("drift");
    expect(r.verdict).toBe("drift");
    expect(r.message).toContain("重生成");
  });

  it("预期两个角色只检出一张脸 → 另一个标记 missing", () => {
    const r = evaluateShot(
      shot({ expectedCharacterIds: [35, 36], faces: [{ descriptor: jitter(FU, 0.01), score: 0.9 }] }),
      refs,
    );
    const yan = r.expected.find((e) => e.characterId === 36)!;
    expect(yan.status).toBe("missing");
    expect(r.verdict).toBe("review");
    expect(r.message).toContain("没检出");
  });

  it("双人同框时按最近优先指派，不会两个角色抢同一张脸", () => {
    const r = evaluateShot(
      shot({
        expectedCharacterIds: [35, 36],
        faces: [
          { descriptor: jitter(FU, 0.01), score: 0.9, box: { x: 0, y: 0, width: 200, height: 200 } },
          { descriptor: jitter(YAN, 0.01), score: 0.88, box: { x: 300, y: 0, width: 150, height: 150 } },
        ],
      }),
      refs,
    );
    expect(r.expected.every((e) => e.status === "consistent")).toBe(true);
    expect(r.extraFaces).toHaveLength(0);
    expect(r.verdict).toBe("ok");
  });

  it("参考图检不出人脸 → no_reference，唯一角色时整镜 unverifiable（不诬告）", () => {
    const ghost: CharacterReference = { characterId: 36, name: "阿砚", descriptors: [] };
    const r = evaluateShot(
      shot({ expectedCharacterIds: [36], faces: [{ descriptor: FU, score: 0.9 }] }),
      [ghost],
    );
    expect(r.expected[0].status).toBe("no_reference");
    expect(r.verdict).toBe("unverifiable");
    expect(r.message).toContain("无法自动校验");
  });

  it("有可校验角色时，无参考图的角色不影响整体结论", () => {
    const ghost: CharacterReference = { characterId: 36, name: "阿砚", descriptors: [] };
    const r = evaluateShot(
      shot({
        expectedCharacterIds: [35, 36],
        faces: [{ descriptor: jitter(FU, 0.01), score: 0.9 }],
      }),
      [refs[0], ghost],
    );
    expect(r.expected.find((e) => e.characterId === 35)!.status).toBe("consistent");
    expect(r.expected.find((e) => e.characterId === 36)!.status).toBe("no_reference");
    expect(r.verdict).toBe("ok");
  });

  it("多出来的陌生人脸 → unknown，结论降为 review", () => {
    const stranger = vec(99);
    const r = evaluateShot(
      shot({
        faces: [
          { descriptor: jitter(FU, 0.01), score: 0.9 },
          { descriptor: stranger, score: 0.7 },
        ],
      }),
      refs,
    );
    expect(r.extraFaces).toHaveLength(1);
    expect(r.extraFaces[0].kind).toBe("unknown");
    expect(r.verdict).toBe("review");
  });

  it("多出来的脸属于另一个已登记角色 → other_character，不算未知", () => {
    const r = evaluateShot(
      shot({
        faces: [
          { descriptor: jitter(FU, 0.01), score: 0.9 },
          { descriptor: jitter(DU, 0.01), score: 0.85 },
        ],
      }),
      refs,
    );
    expect(r.extraFaces[0].kind).toBe("other_character");
    expect(r.extraFaces[0].nearestName).toBe("度魂使");
  });

  it("第二张脸也像本镜已指派的角色 → lookalike，措辞不能写成「出现了另一个角色」", () => {
    const r = evaluateShot(
      shot({
        expectedCharacterIds: [35, 36],
        faces: [
          { descriptor: jitter(FU, 0.01), score: 0.9 },
          { descriptor: jitter(FU, 0.05), score: 0.6 },
        ],
      }),
      refs,
    );
    expect(r.extraFaces[0].kind).toBe("lookalike");
    expect(r.message).toContain("也接近 沈鸢");
    expect(r.message).not.toContain("未预期的角色");
    expect(r.verdict).toBe("review");
  });

  it("一个角色有多张参考图时取最近的那张", () => {
    const multi: CharacterReference = {
      characterId: 35,
      name: "沈鸢",
      descriptors: [vec(50), jitter(FU, 0.01)],
    };
    const r = evaluateShot(shot({ faces: [{ descriptor: jitter(FU, 0.02), score: 0.9 }] }), [multi]);
    expect(r.expected[0].status).toBe("consistent");
  });

  it("镜头没有任何预期角色 → unverifiable，而不是 ok", () => {
    const r = evaluateShot(shot({ expectedCharacterIds: [], faces: [] }), refs);
    expect(r.verdict).toBe("unverifiable");
  });

  it("镜头没人脸且角色有参考图 → missing", () => {
    const r = evaluateShot(shot({ faces: [] }), refs);
    expect(r.expected[0].status).toBe("missing");
    expect(r.verdict).toBe("review");
  });
});

describe("summarize", () => {
  it("按结论计数", () => {
    const a = evaluateShot(shot({ faces: [{ descriptor: jitter(FU, 0.01), score: 0.9 }] }), refs);
    const b = evaluateShot(shot({ shotId: 2, order: 2, faces: [{ descriptor: YAN, score: 0.9 }] }), refs);
    expect(summarize([a, b])).toEqual({ ok: 1, review: 0, drift: 1, unverifiable: 0 });
  });
});
