import { resolveProviderChain, type ProviderEnvReader } from "./provider-routing";
import type { ShotVerdict, StoredShotConsistency } from "./consistency";

/**
 * 一致性校验的自动修复：把「检出漂移」和「按参考图重画」接成一条闭环。
 *
 * 这里只放策略与编排，不碰数据库和 HTTP：
 * - 修哪些镜头（只修 drift，不修灰区 review）
 * - 一轮最多修几个（预算是硬约束，图生图是按张计费的）
 * - 修完怎么判定「真的修好了」
 *
 * 真正的重画仍然交给 ShotRepairService，保持单一职责，也方便手动路径复用。
 */

export interface AutoRepairConfig {
  enabled: boolean;
  /** 单轮最多重画几个镜头 */
  maxShots: number;
}

export type AutoRepairSkipReason = "not_drift" | "no_references" | "over_budget";

export interface DriftCandidate {
  shotId: number;
  order: number;
  verdict: ShotVerdict;
  /** 该镜头里漂得最厉害的那个角色的脸距；无法量化时为 null */
  worstDistance: number | null;
  /** 能拿去当参考图的数量（为 0 时重画没有意义） */
  referenceCount: number;
}

export interface AutoRepairSkipSnapshot {
  shotId: number;
  reason: AutoRepairSkipReason;
}

export interface AutoRepairPlan {
  selected: DriftCandidate[];
  skipped: AutoRepairSkipSnapshot[];
}

export interface AutoRepairRepaired {
  shotId: number;
  references: number;
  /** 重画后复检的判定；复检失败时为 null */
  verdict: ShotVerdict | null;
  /** 复检回到 ok/review；「无法校验」不算修好，因为那等于没有证据 */
  resolved: boolean;
}

export interface AutoRepairOutcome {
  repaired: AutoRepairRepaired[];
  failed: Array<{ shotId: number; error: string }>;
  skipped: AutoRepairSkipSnapshot[];
}

const DEFAULT_MAX_SHOTS = 2;
const HARD_MAX_SHOTS = 10;
const OFF_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * 默认开启：闭环不配就该能跑通。
 * 用 MIRAFRAME_AUTO_REPAIR=0 关掉，或用 MAX_SHOTS=0 把预算压到零。
 */
export function readAutoRepairConfig(get: (key: string) => string | undefined): AutoRepairConfig {
  const raw = (get("MIRAFRAME_AUTO_REPAIR") ?? "").trim().toLowerCase();
  const enabled = raw === "" ? true : !OFF_VALUES.has(raw);
  return { enabled, maxShots: readMaxShots(get("MIRAFRAME_AUTO_REPAIR_MAX_SHOTS")) };
}

function readMaxShots(raw: string | undefined): number {
  const text = (raw ?? "").trim();
  if (!text) return DEFAULT_MAX_SHOTS;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_SHOTS;
  return Math.min(Math.floor(value), HARD_MAX_SHOTS);
}

/**
 * 图生图能不能真的出图。
 *
 * 这是整个自动修复最危险的边界：fake provider 和「没配 key」都会**静默返回占位图**，
 * 不在这里拦住，就会把一张真图换成灰底占位图，还顺手清掉视频。
 */
export function isImageRepairAvailable(get: ProviderEnvReader): boolean {
  return resolveProviderChain("image", get).some(
    (candidate) => candidate.provider !== "fake" && Boolean(candidate.apiKey),
  );
}

/** 从存下来的校验结果里取「漂得最厉害的那个角色」的距离，用于排序。 */
export function worstDistanceOf(result: StoredShotConsistency | null | undefined): number | null {
  if (!result) return null;
  let worst: number | null = null;
  for (const item of result.expected) {
    if (typeof item.distance !== "number" || !Number.isFinite(item.distance)) continue;
    if (worst === null || item.distance > worst) worst = item.distance;
  }
  return worst;
}

/**
 * 选出这一轮要修哪些镜头。
 *
 * 排序按「漂得最厉害」优先，预算用完就不再修 —— 钱要花在最难看的那几张上。
 * 每个镜头只会出现一次，所以不存在同一张图被反复重画。
 */
export function planAutoRepair(candidates: DriftCandidate[], maxShots: number): AutoRepairPlan {
  const skipped: AutoRepairSkipSnapshot[] = [];
  const eligible: DriftCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.verdict !== "drift") {
      skipped.push({ shotId: candidate.shotId, reason: "not_drift" });
      continue;
    }
    if (candidate.referenceCount <= 0) {
      skipped.push({ shotId: candidate.shotId, reason: "no_references" });
      continue;
    }
    eligible.push(candidate);
  }

  eligible.sort((a, b) => severity(b) - severity(a) || a.order - b.order);

  const budget = Number.isFinite(maxShots) ? Math.max(0, Math.floor(maxShots)) : 0;
  const selected = eligible.slice(0, budget);
  for (const candidate of eligible.slice(budget)) {
    skipped.push({ shotId: candidate.shotId, reason: "over_budget" });
  }

  return { selected, skipped };
}

/** 距离越大漂得越厉害；没有距离的排最后，但不至于被丢掉。 */
function severity(candidate: DriftCandidate): number {
  return candidate.worstDistance ?? -1;
}

/**
 * 按计划逐个重画。
 *
 * 串行而不是并发：图生图本身是重请求，并发只会把 provider 的限流撞出来，
 * 而且编排层要的是「修了几张、哪张没救回来」，并发还要额外做结果归并。
 * 单个镜头失败不影响后面的镜头 —— 修不好比修一半更常见。
 */
export async function runAutoRepair(input: {
  plan: AutoRepairPlan;
  repair: (
    shotId: number,
  ) => Promise<{ shotId: number; references: number; after: StoredShotConsistency | null }>;
  log?: (message: string) => void;
}): Promise<AutoRepairOutcome> {
  const repaired: AutoRepairRepaired[] = [];
  const failed: Array<{ shotId: number; error: string }> = [];

  for (const candidate of input.plan.selected) {
    try {
      const result = await input.repair(candidate.shotId);
      const verdict = result.after?.verdict ?? null;
      // ok / review 都算「不再是漂移」；unverifiable 是没检出脸，等于没有证据，
      // 这时候宣称修好了会掩盖问题，交给人工看一眼更诚实。
      const resolved = verdict === "ok" || verdict === "review";
      repaired.push({ shotId: candidate.shotId, references: result.references, verdict, resolved });
      input.log?.(
        `镜头 #${candidate.order} 已按 ${result.references} 张参考图重画，复检：${verdict ?? "失败"}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ shotId: candidate.shotId, error: message.slice(0, 200) });
      input.log?.(`镜头 #${candidate.order} 自动修复失败（保留原图）：${message.slice(0, 120)}`);
    }
  }

  return { repaired, failed, skipped: input.plan.skipped };
}
