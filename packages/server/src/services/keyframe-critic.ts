import type { ProviderEnvReader } from "./provider-routing";

/**
 * 关键帧视觉审查（多模态 Critic）。
 *
 * 与分镜审查（CriticAgent）的分工：
 * - 分镜审查读**文本**，管叙事、镜头语言、可生成性；
 * - 这里的 Critic 真的**看图**，管画面层面的事：画风跑偏、手/手指畸形、
 *   构图缺主体、画面里出现乱码文字。
 *
 * 这一层只放策略与解析，不碰数据库、HTTP、图片解码：
 * - 一次请求塞几张图（成本与注意力精度的折中）
 * - 提示词怎么把「图 1 = 镜头 #1」的对应关系说清楚
 * - 模型返回的 JSON 怎么清洗成可判定的结构
 * - 哪些镜头值得重画（预算是硬约束，视觉模型按 token 计费）
 */

export interface KeyframeCriticConfig {
  enabled: boolean;
  /** 通过阈值：低于这个总分视为「这一批关键帧需要关注」 */
  threshold: number;
  /** 单次请求最多几张图。太多会稀释注意力，也撑爆请求体 */
  maxImagesPerCall: number;
  /** 单轮最多评审多少个镜头（防御性上限，避免长项目一次打爆额度） */
  maxShots: number;
  /** 是否根据审查结论自动重画 */
  regenerate: boolean;
  /** 单轮最多重画几个镜头 */
  maxRegenerations: number;
}

export interface VisionShotInput {
  shotId: number;
  order: number;
  /** 画面用途说明（description / imagePrompt），给模型一点语义锚点 */
  description?: string | null;
  /** 该镜头绑定的角色名，帮助模型判断「画面里该有谁」 */
  characterNames?: string[];
}

export interface VisionBatch {
  /** 本批在整轮里的序号，从 1 开始 */
  index: number;
  shots: VisionShotInput[];
}

export interface VisionCritiqueShot {
  order: number;
  score: number;
  dimensions: Record<string, number>;
  issues: string[];
  suggestions: string[];
  needsRegenerate: boolean;
}

export interface VisionCritique {
  /** 有分镜分时取各镜头均值，比模型自报的总分更稳（它经常和分项对不上） */
  score: number;
  dimensions: Record<string, number>;
  shots: VisionCritiqueShot[];
  issues: string[];
  suggestions: string[];
  needsRegenerate: boolean;
}

export interface ParsedVisionCritique {
  critique: VisionCritique;
  /** 模型漏评的镜头序号。漏评不算通过，也不该被静默当成 10 分 */
  missingOrders: number[];
}

const DEFAULT_THRESHOLD = 6.5;
const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_MAX_SHOTS = 8;
const DEFAULT_MAX_REGEN = 1;
const HARD_MAX_IMAGES = 8;
const HARD_MAX_SHOTS = 20;
const HARD_MAX_REGEN = 5;
const OFF_VALUES = new Set(["0", "false", "off", "no"]);

function readBool(raw: string | undefined, fallback: boolean): boolean {
  const text = (raw ?? "").trim().toLowerCase();
  if (!text) return fallback;
  return !OFF_VALUES.has(text);
}

function readNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const text = (raw ?? "").trim();
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value) || value < min) return fallback;
  return Math.min(value, max);
}

/** 阈值不做 clamp：配成 11 明显是笔误，静默夹到 10 会让人以为配置生效了。 */
function readThreshold(raw: string | undefined): number {
  const text = (raw ?? "").trim();
  if (!text) return DEFAULT_THRESHOLD;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > 10) return DEFAULT_THRESHOLD;
  return value;
}

export function readKeyframeCriticConfig(
  get: (key: string) => string | undefined,
): KeyframeCriticConfig {
  return {
    enabled: readBool(get("MIRAFRAME_KEYFRAME_CRITIC"), true),
    threshold: readThreshold(get("MIRAFRAME_KEYFRAME_CRITIC_THRESHOLD")),
    maxImagesPerCall: Math.floor(
      readNumber(
        get("MIRAFRAME_KEYFRAME_CRITIC_MAX_IMAGES"),
        DEFAULT_MAX_IMAGES,
        1,
        HARD_MAX_IMAGES,
      ),
    ),
    maxShots: Math.floor(
      readNumber(get("MIRAFRAME_KEYFRAME_CRITIC_MAX_SHOTS"), DEFAULT_MAX_SHOTS, 1, HARD_MAX_SHOTS),
    ),
    regenerate: readBool(get("MIRAFRAME_KEYFRAME_REGEN"), true),
    maxRegenerations: Math.floor(
      readNumber(get("MIRAFRAME_KEYFRAME_REGEN_MAX_SHOTS"), DEFAULT_MAX_REGEN, 0, HARD_MAX_REGEN),
    ),
  };
}

/**
 * 视觉模型只支持 `IMAGE_*` 这一层覆盖会更好，但真实环境里「同 key 同 baseUrl、
 * 只换模型名」是常态（qwen-plus → qwen-vl-max）。所以只允许覆盖模型名，
 * 走的是同一条已经被熔断保护过的 provider 链。
 */
export function resolveVisionModel(get: ProviderEnvReader): string | undefined {
  const value = (get("VISION_MODEL") ?? "").trim();
  return value || undefined;
}

/**
 * 占位图不是真图，送进视觉审查只会得到「灰底没有主体」这种没用的结论。
 * 图像服务缺 key 时 generateImage 会静默返回 SVG 占位图，所以这里显式拦掉。
 */
export function isPlaceholderImage(imageUrl: string | null | undefined): boolean {
  if (!imageUrl) return true;
  return imageUrl.startsWith("data:image/svg");
}

/** 按「单次最多几张图」把镜头切成批次，保持镜头顺序。 */
export function planVisionBatches(shots: VisionShotInput[], maxImages: number): VisionBatch[] {
  const limit = Math.max(1, Math.floor(maxImages));
  const batches: VisionBatch[] = [];
  for (let start = 0; start < shots.length; start += limit) {
    batches.push({ index: batches.length + 1, shots: shots.slice(start, start + limit) });
  }
  return batches;
}

/**
 * 提示词里必须把「第几张图对应哪个镜头」写死。
 * 只丢一串图给模型、让它自己数，是视觉审查最常见的错位来源。
 */
export function buildVisionPrompt(
  batch: VisionBatch,
  context?: { style?: string | null; projectTitle?: string | null },
): string {
  const lines: string[] = ["下面是一组分镜关键帧，按镜头顺序排列。请逐张评审，并给出整体结论。"];
  if (context?.projectTitle) lines.push(`项目：${context.projectTitle}`);
  if (context?.style) lines.push(`目标画风：${context.style}`);
  lines.push("", "本批图片与镜头的对应关系：");
  batch.shots.forEach((shot, index) => {
    const who = shot.characterNames?.length ? `；出场角色：${shot.characterNames.join("、")}` : "";
    const what = shot.description?.trim()
      ? `；画面要求：${shot.description.trim().slice(0, 200)}`
      : "";
    lines.push(`- 图 ${index + 1} = 镜头 #${shot.order}${who}${what}`);
  });
  lines.push(
    "",
    "重点关注（这些都是静态画面能看出来、又最容易被忽略的问题）：",
    "1. 画风是否与目标画风一致，有没有中途变成 3D 渲染/写实照片；",
    "2. 人物肢体与手指是否正常，有无多余的手指、扭曲的关节、断裂的四肢；",
    "3. 构图是否缺主体或被裁切，人物有没有半个头出画；",
    "4. 画面里是否出现了乱码文字、无意义符号、水印；",
    "5. 同一角色在不同镜头里的发型、服装、配饰是否明显不一致。",
    "",
    "严格打分：8 分以上可直接用，6-7 分小修可用，5 分以下必须重画。",
    "只有结构性问题（画风崩坏、肢体畸形、主体缺失）才把 needs_regenerate 设为 true；",
    "轻微瑕疵写在 issues 里即可，不要触发重画。",
  );
  return lines.join("\n");
}

function clampScore(value: unknown): number | null {
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) return null;
  return Math.max(0, Math.min(10, Math.round(num * 10) / 10));
}

function readDimensions(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const score = clampScore(raw);
    if (score !== null) out[key] = score;
  }
  return out;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

/** 模型经常包 ```json 围栏或在前后加解释文字 */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("视觉审查回复里没有 JSON");
  return JSON.parse(text.slice(start, end + 1));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((acc, item) => acc + item, 0);
  return Math.round((sum / values.length) * 10) / 10;
}

/**
 * 把模型返回的 JSON 清洗成可判定的结构。
 *
 * 三个刻意的选择：
 * 1. 总分优先用「各镜头均值」——模型自报的 overall_score 经常和分项自相矛盾；
 * 2. 漏评的镜头记进 missingOrders，既不补满分也不当成通过；
 * 3. needs_regenerate 只认 true，其他任何值（缺字段、"yes"、1）都算 false，
 *    因为重画是花钱的动作，没有明确指令就不该发生。
 */
export function parseVisionCritique(raw: string, expectedOrders: number[]): ParsedVisionCritique {
  const data = extractJson(raw) as Record<string, unknown>;
  const rawShots = Array.isArray(data.shots) ? data.shots : [];

  const shots: VisionCritiqueShot[] = [];
  for (const item of rawShots) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const orderRaw = row.order ?? row.shot_order ?? row.shotOrder;
    const order = typeof orderRaw === "string" ? Number(orderRaw) : orderRaw;
    if (typeof order !== "number" || !Number.isFinite(order)) continue;
    const score = clampScore(row.score ?? row.overall_score ?? row.overallScore);
    if (score === null) continue;
    shots.push({
      order: Math.round(order),
      score,
      dimensions: readDimensions(row.dimensions),
      issues: readStringList(row.issues),
      suggestions: readStringList(row.suggestions),
      needsRegenerate: row.needs_regenerate === true || row.needsRegenerate === true,
    });
  }

  const expected = new Set(expectedOrders);
  const seen = new Set(shots.filter((shot) => expected.has(shot.order)).map((shot) => shot.order));
  const missingOrders = expectedOrders.filter((order) => !seen.has(order));
  // 模型偶尔会多给镜头（串批了），这些分不该参与统计
  const validShots = shots.filter((shot) => expected.has(shot.order));

  const shotAverage = average(validShots.map((shot) => shot.score));
  const declared = clampScore(data.overall_score ?? data.overallScore ?? data.score);
  const score = shotAverage ?? declared ?? 0;

  const dimensionKeys = new Set<string>();
  for (const shot of validShots)
    Object.keys(shot.dimensions).forEach((key) => dimensionKeys.add(key));
  const dimensions: Record<string, number> = {};
  for (const key of dimensionKeys) {
    const values = validShots
      .map((shot) => shot.dimensions[key])
      .filter((value): value is number => typeof value === "number");
    const value = average(values);
    if (value !== null) dimensions[key] = value;
  }

  return {
    critique: {
      score,
      dimensions: Object.keys(dimensions).length ? dimensions : readDimensions(data.dimensions),
      shots: validShots,
      issues: readStringList(data.issues),
      suggestions: readStringList(data.suggestions),
      needsRegenerate: data.needs_regenerate === true || data.needsRegenerate === true,
    },
    missingOrders,
  };
}

export type KeyframeRegenSkipReason = "passed" | "over_budget" | "no_references" | "no_prompt";

export interface KeyframeRegenCandidate {
  shotId: number;
  order: number;
  score: number;
  /** 原图生成用的提示词，重画时作为基底 */
  basePrompt: string;
  /** 审查意见，重画时拼进提示词 —— 这是「Critic 反哺生成」的关键 */
  suggestions: string[];
  referenceCount: number;
}

export interface KeyframeRegenPlan {
  selected: KeyframeRegenCandidate[];
  skipped: Array<{ shotId: number; order: number; reason: KeyframeRegenSkipReason }>;
}

/**
 * 挑出值得重画的镜头。
 *
 * 两个条件必须同时满足：模型明确说 `needs_regenerate`，且分数确实低于阈值。
 * 单一条件都会出问题——只看标记会把 8 分的图重画掉，
 * 只看分数会在模型认为「小修可用」时白花一次生成。
 */
export function planKeyframeRegen(
  shots: Array<VisionShotInput & { basePrompt: string; referenceCount: number }>,
  critique: VisionCritique,
  config: KeyframeCriticConfig,
): KeyframeRegenPlan {
  const byOrder = new Map(critique.shots.map((shot) => [shot.order, shot]));
  const candidates: KeyframeRegenCandidate[] = [];
  const skipped: KeyframeRegenPlan["skipped"] = [];

  for (const shot of shots) {
    const verdict = byOrder.get(shot.order);
    if (!verdict || !verdict.needsRegenerate || verdict.score >= config.threshold) {
      skipped.push({ shotId: shot.shotId, order: shot.order, reason: "passed" });
      continue;
    }
    if (!shot.basePrompt.trim()) {
      skipped.push({ shotId: shot.shotId, order: shot.order, reason: "no_prompt" });
      continue;
    }
    if (shot.referenceCount === 0) {
      skipped.push({ shotId: shot.shotId, order: shot.order, reason: "no_references" });
      continue;
    }
    candidates.push({
      shotId: shot.shotId,
      order: shot.order,
      score: verdict.score,
      basePrompt: shot.basePrompt,
      suggestions: verdict.suggestions,
      referenceCount: shot.referenceCount,
    });
  }

  // 分低的先修；同分按镜头顺序，保证日志可复现
  candidates.sort((a, b) => a.score - b.score || a.order - b.order);
  const selected = candidates.slice(0, Math.max(0, config.maxRegenerations));
  for (const dropped of candidates.slice(selected.length)) {
    skipped.push({ shotId: dropped.shotId, order: dropped.order, reason: "over_budget" });
  }

  skipped.sort((a, b) => a.order - b.order);
  return { selected, skipped };
}

/**
 * 重画时拼在提示词后的「修正要求」段落。
 * 只把 suggestions 拼进去而不是 issues：issues 是「哪里不对」，
 * suggestions 才是「怎么改」，模型对后者更敏感。
 */
export function buildRegenGuidance(suggestions: string[]): string {
  const tips = suggestions
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (tips.length === 0) return "";
  return `【画面修正要求】上一版存在以下问题，本版务必避免：\n${tips
    .map((tip) => `- ${tip}`)
    .join("\n")}`;
}

/** 把「整体分 + 漏评」压成一条人能读懂的消息 */
export function summarizeCritique(
  critique: VisionCritique,
  missingOrders: number[],
  threshold: number,
): string {
  const parts = [
    `关键帧视觉审查：${critique.score.toFixed(1)} 分（阈值 ${threshold}）`,
    critique.score >= threshold ? "通过" : "未达标",
  ];
  if (critique.issues.length > 0) parts.push(`发现 ${critique.issues.length} 个问题`);
  if (missingOrders.length > 0) {
    parts.push(`镜头 ${missingOrders.map((order) => `#${order}`).join("、")} 未返回评分`);
  }
  return parts.join("，");
}

/**
 * 合并多批结果。
 *
 * 分数用「所有镜头」重新平均，而不是「各批分数的平均」——
 * 后者在分批张数不等时会被小批次带偏（2 张的批和 4 张的批权重一样）。
 */
export function mergeBatchCritiques(list: ParsedVisionCritique[]): ParsedVisionCritique {
  if (list.length === 1) return list[0];

  const shots = list.flatMap((item) => item.critique.shots);
  const missingOrders = list.flatMap((item) => item.missingOrders);
  const shotAverage = average(shots.map((shot) => shot.score));

  const dimensionKeys = new Set<string>();
  for (const shot of shots) Object.keys(shot.dimensions).forEach((key) => dimensionKeys.add(key));
  const dimensions: Record<string, number> = {};
  for (const key of dimensionKeys) {
    const values = shots
      .map((shot) => shot.dimensions[key])
      .filter((value): value is number => typeof value === "number");
    const value = average(values);
    if (value !== null) dimensions[key] = value;
  }

  return {
    critique: {
      score: shotAverage ?? average(list.map((item) => item.critique.score)) ?? 0,
      dimensions,
      shots,
      issues: list.flatMap((item) => item.critique.issues),
      suggestions: list.flatMap((item) => item.critique.suggestions),
      needsRegenerate: list.some((item) => item.critique.needsRegenerate),
    },
    missingOrders,
  };
}
