/**
 * 角色一致性判定 —— 纯计算，不碰网络/文件/数据库。
 *
 * 输入是「每个角色的人脸特征」和「每个镜头的人脸特征」，输出是可供 UI 直接渲染的
 * 校验报告。之所以拆成纯函数，是因为真正的难点不在跑模型，而在判定规则：
 * 多角色同框时谁是谁、参考图本身检不出脸时该报什么、距离处在灰区该怎么措辞。
 */

export interface FaceDescriptorInput {
  descriptor: number[];
  score: number;
  box?: { x: number; y: number; width: number; height: number };
}

export interface CharacterReference {
  characterId: number;
  name: string;
  /** 参考图里检出的人脸特征；同一角色有多张参考图时会有多个 */
  descriptors: number[][];
}

export interface ShotInput {
  shotId: number;
  order: number;
  expectedCharacterIds: number[];
  faces: FaceDescriptorInput[];
}

export interface ConsistencyThresholds {
  /** 距离 ≤ ok：判定为同一人 */
  ok: number;
  /** 距离 > drift：判定为外貌漂移 */
  drift: number;
  /** 允许把某张脸指派给预期角色的最宽距离，超过就当作「没出现」而不是「漂移」 */
  matchLimit: number;
}

export const DEFAULT_THRESHOLDS: ConsistencyThresholds = {
  ok: 0.45,
  drift: 0.6,
  matchLimit: 0.85,
};

export type ExpectedStatus = "consistent" | "review" | "drift" | "missing" | "no_reference";
export type ShotVerdict = "ok" | "review" | "drift" | "unverifiable";

export interface ExpectedCharacterResult {
  characterId: number;
  name: string;
  status: ExpectedStatus;
  /** 该角色在镜头里离参考特征最近的距离 */
  distance: number | null;
}

export interface ExtraFaceResult {
  box?: { x: number; y: number; width: number; height: number };
  score: number;
  /** 最近的已知角色；没有可信匹配时为 null */
  nearestCharacterId: number | null;
  nearestName: string | null;
  distance: number | null;
  /**
   * other_character：画面里出现了别的已登记角色
   * lookalike：这张脸最像的角色本镜已指派过一次 —— 多半是重复检出或长相相近的旁人
   * unknown：和所有已知角色都不像
   */
  kind: "other_character" | "lookalike" | "unknown";
}

export interface ShotResult {
  shotId: number;
  order: number;
  expected: ExpectedCharacterResult[];
  extraFaces: ExtraFaceResult[];
  verdict: ShotVerdict;
  /** 一句人话结论，直接显示在 UI 上 */
  message: string;
}

export interface ConsistencyReport {
  thresholds: ConsistencyThresholds;
  characters: Array<{
    characterId: number;
    name: string;
    referenceFaces: number;
  }>;
  shots: ShotResult[];
  summary: { ok: number; review: number; drift: number; unverifiable: number };
}

export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** 一张脸到某个角色的距离：与参考特征是「取最近」而非取平均，避免多参考图互相稀释 */
function distanceToCharacter(descriptor: number[], reference: CharacterReference): number {
  let best = Number.POSITIVE_INFINITY;
  for (const ref of reference.descriptors) {
    const d = euclideanDistance(descriptor, ref);
    if (d < best) best = d;
  }
  return best;
}

function classify(distance: number, t: ConsistencyThresholds): ExpectedStatus {
  if (distance <= t.ok) return "consistent";
  if (distance > t.drift) return "drift";
  return "review";
}

/**
 * 逐镜头判定。核心难点是「多角色同框时谁是谁」—— 用全局最近优先的贪心指派，
 * 保证一张脸只能对应一个角色，避免两个角色都被判成「和主角相似」。
 */
export function evaluateShot(
  shot: ShotInput,
  references: CharacterReference[],
  thresholds: ConsistencyThresholds = DEFAULT_THRESHOLDS,
): ShotResult {
  const usable = references.filter((r) => r.descriptors.length > 0);
  const byId = new Map(references.map((r) => [r.characterId, r]));

  const expectedRefs = shot.expectedCharacterIds
    .map((id) => byId.get(id))
    .filter((r): r is CharacterReference => Boolean(r));

  const faces = shot.faces;
  // 候选对：预期角色 × 人脸，按距离升序
  const pairs: Array<{ faceIdx: number; char: CharacterReference; distance: number }> = [];
  for (const char of usable) {
    if (!shot.expectedCharacterIds.includes(char.characterId)) continue;
    for (let i = 0; i < faces.length; i++) {
      pairs.push({ faceIdx: i, char, distance: distanceToCharacter(faces[i].descriptor, char) });
    }
  }
  pairs.sort((a, b) => a.distance - b.distance);

  const faceTaken = new Set<number>();
  const assigned = new Map<number, { faceIdx: number; distance: number }>();
  for (const p of pairs) {
    if (faceTaken.has(p.faceIdx)) continue;
    if (assigned.has(p.char.characterId)) continue;
    if (p.distance > thresholds.matchLimit) continue;
    assigned.set(p.char.characterId, { faceIdx: p.faceIdx, distance: p.distance });
    faceTaken.add(p.faceIdx);
  }

  const expected: ExpectedCharacterResult[] = shot.expectedCharacterIds.map((id) => {
    const ref = byId.get(id);
    const hit = assigned.get(id);
    if (!ref) {
      return { characterId: id, name: `#${id}`, status: "no_reference", distance: null };
    }
    if (ref.descriptors.length === 0) {
      return { characterId: id, name: ref.name, status: "no_reference", distance: null };
    }
    if (!hit) {
      return { characterId: id, name: ref.name, status: "missing", distance: null };
    }
    return {
      characterId: id,
      name: ref.name,
      status: classify(hit.distance, thresholds),
      distance: +hit.distance.toFixed(4),
    };
  });

  // 剩下的脸：可能是「本该出现但没登记的角色」，也可能是路人，还可能是同一人被检出两次
  const extraFaces: ExtraFaceResult[] = [];
  for (let i = 0; i < faces.length; i++) {
    if (faceTaken.has(i)) continue;
    const face = faces[i];
    let nearest: { char: CharacterReference; distance: number } | null = null;
    for (const char of usable) {
      const d = distanceToCharacter(face.descriptor, char);
      if (!nearest || d < nearest.distance) nearest = { char, distance: d };
    }
    const known = nearest && nearest.distance <= thresholds.drift ? nearest : null;
    const kind: ExtraFaceResult["kind"] = !known
      ? "unknown"
      : assigned.has(known.char.characterId)
        ? "lookalike"
        : "other_character";
    extraFaces.push({
      box: face.box,
      score: +face.score.toFixed(3),
      nearestCharacterId: known ? known.char.characterId : null,
      nearestName: known ? known.char.name : null,
      distance: nearest ? +nearest.distance.toFixed(4) : null,
      kind,
    });
  }

  const verdict = decideVerdict(expected, extraFaces);
  return {
    shotId: shot.shotId,
    order: shot.order,
    expected,
    extraFaces,
    verdict,
    message: buildMessage(verdict, expected, extraFaces, expectedRefs.length),
  };
}

function decideVerdict(expected: ExpectedCharacterResult[], extraFaces: ExtraFaceResult[]): ShotVerdict {
  const checkable = expected.filter((e) => e.status !== "no_reference");
  if (checkable.length === 0) return "unverifiable";
  if (checkable.some((e) => e.status === "drift")) return "drift";
  const hasIssue =
    checkable.some((e) => e.status === "review" || e.status === "missing") ||
    extraFaces.some((f) => f.kind === "unknown" || f.kind === "other_character" || f.kind === "lookalike");
  return hasIssue ? "review" : "ok";
}

function buildMessage(
  verdict: ShotVerdict,
  expected: ExpectedCharacterResult[],
  extraFaces: ExtraFaceResult[],
  checkableCount: number,
): string {
  if (verdict === "unverifiable") {
    const names = expected.map((e) => e.name).join("、") || "该镜头角色";
    return `${names} 的参考图里检不出人脸，无法自动校验`;
  }

  const parts: string[] = [];
  const drift = expected.filter((e) => e.status === "drift").map((e) => e.name);
  const missing = expected.filter((e) => e.status === "missing").map((e) => e.name);
  const review = expected.filter((e) => e.status === "review").map((e) => e.name);
  const lookalikes = extraFaces.filter((f) => f.kind === "lookalike");
  const others = extraFaces.filter((f) => f.kind === "other_character");
  const unknowns = extraFaces.filter((f) => f.kind === "unknown");

  if (drift.length) parts.push(`${drift.join("、")} 与参考图差异明显，建议重生成`);
  if (missing.length) parts.push(`应出现但没检出：${missing.join("、")}`);
  if (review.length) parts.push(`${review.join("、")} 与参考图接近但不完全一致，建议人工确认`);
  for (const f of others) parts.push(`画面里出现了未预期的角色 ${f.nearestName}`);
  if (lookalikes.length) {
    const who = [...new Set(lookalikes.map((f) => f.nearestName).filter(Boolean))].join("、");
    parts.push(`另有 ${lookalikes.length} 张脸也接近 ${who}（重复检出或长相相近的旁人）`);
  }

  // 「检不出脸」不等于「长得不像」：这类角色不参与判定，但遇到陌生脸时要提示可能是它
  const undetectable = expected.filter((e) => e.status === "no_reference").map((e) => e.name);
  if (unknowns.length) {
    parts.push(
      undetectable.length
        ? `检出 ${unknowns.length} 张未登记人脸（可能是无法校验的 ${undetectable.join("、")}）`
        : `检出 ${unknowns.length} 张未登记人脸`,
    );
  }

  const matched = expected.filter((e) => e.status === "consistent").map((e) => e.name);
  if (parts.length === 0) {
    parts.push(matched.length ? `${matched.join("、")} 与参考图一致` : `${checkableCount} 个角色全部匹配`);
  }

  return parts.join("；");
}

export function summarize(shots: ShotResult[]): ConsistencyReport["summary"] {
  return shots.reduce(
    (acc, s) => {
      acc[s.verdict] += 1;
      return acc;
    },
    { ok: 0, review: 0, drift: 0, unverifiable: 0 },
  );
}
