/**
 * 角色一致性校验的接口契约。
 *
 * 这组字段是 camelCase，因为它直接对应 `services/consistency.ts` 的纯计算结果，
 * 不是数据库行。保持原样可以避免在服务端做一层无意义的 key 转换。
 */

export type ConsistencyExpectedStatus =
  | "consistent"
  | "review"
  | "drift"
  | "missing"
  | "no_reference";
export type ConsistencyShotVerdict = "ok" | "review" | "drift" | "unverifiable";

export interface ConsistencyCharacterRefRead {
  characterId: number;
  name: string;
  /** 参考图里检出的可用人脸数；为 0 表示这个人无法自动校验 */
  referenceFaces: number;
}

export interface ConsistencyExpectedRead {
  characterId: number;
  name: string;
  status: ConsistencyExpectedStatus;
  /** 与参考特征的欧氏距离 */
  distance: number | null;
}

export interface ConsistencyExtraFaceRead {
  box?: { x: number; y: number; width: number; height: number };
  score: number;
  nearestCharacterId: number | null;
  nearestName: string | null;
  distance: number | null;
  kind: "other_character" | "lookalike" | "unknown";
}

export interface ConsistencyShotRead {
  shotId: number;
  order: number;
  expected: ConsistencyExpectedRead[];
  extraFaces: ConsistencyExtraFaceRead[];
  verdict: ConsistencyShotVerdict;
  message: string;
}

/** 自动校验后写回 shot.consistency_result 的快照。 */
export interface ShotConsistencyResult extends ConsistencyShotRead {
  checkedAt: string;
}

export interface ConsistencyReportRead {
  projectId: number;
  checkedAt?: string;
  thresholds: { ok: number; drift: number; matchLimit: number };
  characters: ConsistencyCharacterRefRead[];
  shots: ConsistencyShotRead[];
  summary: { ok: number; review: number; drift: number; unverifiable: number };
}

export interface ShotRepairResult {
  shotId: number;
  imageUrl: string;
  /** 实际参与图生图的参考图数量 */
  references: number;
  before: (ConsistencyShotRead & { checkedAt?: string }) | null;
  after: (ConsistencyShotRead & { checkedAt?: string }) | null;
}
