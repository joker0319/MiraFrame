/**
 * Provider 选路与降级。
 *
 * 之前只有「对同一个 URL 重试」：429 退避、503 退避，但主 provider 整体挂掉
 * （密钥失效、账号欠费、区域故障）时只能一路重试到超时。这里补上第二层：
 *
 *   1. **候选链**：`TEXT_PROVIDERS=agnes,kimi` 声明顺序即优先级，每个候选的
 *      baseUrl / apiKey / model 用 `TEXT_<NAME>_*` 覆盖，缺省回落 `TEXT_*`。
 *      不配 `*_PROVIDERS` 时链长度为 1，行为与改造前完全一致。
 *   2. **熔断**：同一 provider 连续失败 N 次后进入冷却（指数翻倍、有上限），
 *      冷却期内不再被选中；冷却到期放一个试探请求（half-open），成功即恢复。
 *   3. **降级**：只对「换一个 provider 可能有用」的失败切换（网络/超时/429/
 *      5xx/401/403）。400 参数错这类换谁都一样，不切换也不熔断，避免一次
 *      坏 prompt 打穿整条链的健康度。
 *   4. **观测**：成功率、平均延迟、连续失败数、剩余冷却时间可快照，
 *      由 `GET /api/v1/providers` 只读暴露（不含 baseUrl 与密钥）。
 *
 * 本文件是纯逻辑，不碰网络，便于单测。
 */

export type ProviderCapability = "text" | "image" | "video";

export const PROVIDER_CAPABILITIES: readonly ProviderCapability[] = ["text", "image", "video"];

export interface ProviderCandidate {
  /** 链中的逻辑名，如 agnes / kimi，用于日志与环境变量前缀 */
  name: string;
  /** 传输协议族：fake 走桩，其余按 OpenAI 兼容 / 端点嗅探构造请求 */
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  endpoint: string;
}

export type ProviderEnvReader = (key: string) => string | undefined;

interface CapabilityDefaults {
  baseUrl: string;
  model: string;
  endpoint: string;
}

const DEFAULTS: Record<ProviderCapability, CapabilityDefaults> = {
  text: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "deepseek-v4-flash",
    endpoint: "/chat/completions",
  },
  image: {
    baseUrl: "https://api.openai.com/v1",
    model: "dall-e-3",
    endpoint: "/images/generations",
  },
  video: {
    baseUrl: "https://api.example.com/v1",
    model: "video-gen-1",
    endpoint: "/videos/generations",
  },
};

/** 名字 → 环境变量片段：`kimi-k2` → `KIMI_K2` */
export function providerEnvPrefix(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function nonEmpty(value: string | undefined | null): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    const found = nonEmpty(value);
    if (found) return found;
  }
  return undefined;
}

/**
 * 解析一条候选链。
 *
 * - `TEXT_PROVIDERS` 未配置 → `[TEXT_PROVIDER || "fake"]`，与改造前等价。
 * - 内联注释、空项、重复项都会被清掉（`a, ,b` → `[a, b]`）。
 * - apiKey 为空**不**从链里剔除：调用方需要区分「没配 key」与「配了但失败」。
 */
export function resolveProviderChain(
  capability: ProviderCapability,
  get: ProviderEnvReader,
): ProviderCandidate[] {
  const prefix = capability.toUpperCase();
  const defaults = DEFAULTS[capability];
  const globalProvider = firstNonEmpty(get(`${prefix}_PROVIDER`));
  const rawList = nonEmpty(get(`${prefix}_PROVIDERS`));
  const names = rawList
    ? rawList.split(",").map((item) => item.trim()).filter(Boolean)
    : [globalProvider ?? "fake"];

  const seen = new Set<string>();
  const chain: ProviderCandidate[] = [];
  for (const name of names) {
    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const scoped = `${prefix}_${providerEnvPrefix(name)}`;
    // 只写 `TEXT_PROVIDERS=agnes,kimi` 时不该因为忘了设 TEXT_PROVIDER 就全都变成 fake；
    // 名字里带 fake 的候选才默认 fake，其余默认按 OpenAI 兼容协议调用。
    const nameSuggestsFake = /(^|[^a-z])fake([^a-z]|$)/i.test(name);
    chain.push({
      name,
      provider:
        firstNonEmpty(get(`${scoped}_PROVIDER`), globalProvider, nameSuggestsFake ? "fake" : "openai") ?? "openai",
      baseUrl: firstNonEmpty(get(`${scoped}_BASE_URL`), get(`${prefix}_BASE_URL`)) ?? defaults.baseUrl,
      apiKey: firstNonEmpty(get(`${scoped}_API_KEY`), get(`${prefix}_API_KEY`)) ?? "",
      model: firstNonEmpty(get(`${scoped}_MODEL`), get(`${prefix}_MODEL`)) ?? defaults.model,
      endpoint: firstNonEmpty(get(`${scoped}_ENDPOINT`), get(`${prefix}_ENDPOINT`)) ?? defaults.endpoint,
    });
  }
  return chain;
}

/** 链的可比较指纹（不含密钥）。用于判断运行时配置是否被改写、需要同步候选。 */
export function chainFingerprint(chain: ProviderCandidate[]): string {
  return chain
    .map((item) => `${item.name}|${item.provider}|${item.baseUrl}|${item.model}|${item.endpoint}`)
    .join(";");
}

// ────────────────────────── 错误分类 ──────────────────────────

export type ProviderFailureKind =
  | "network"
  | "timeout"
  | "rate_limit"
  | "server"
  | "auth"
  | "client"
  | "unknown";

export interface ProviderFailure {
  kind: ProviderFailureKind;
  /** 换一个 provider 是否有意义 */
  switchable: boolean;
  status?: number;
}

/** 带 HTTP 状态码的错误：让选路层不靠正则去猜 status。 */
export class ProviderHttpError extends Error {
  /**
   * @param switchableOverride 覆盖默认分类。例如工具通道的 400 通常是
   *   「这个 provider 不支持 function calling」，换一家就有意义，不该按
   *   普通参数错误（不切换）处理。
   */
  constructor(
    readonly status: number,
    readonly body: string,
    options: { message?: string; switchableOverride?: boolean } = {},
  ) {
    super(options.message ?? `provider 返回 HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "ProviderHttpError";
    this.switchableOverride = options.switchableOverride;
  }

  readonly switchableOverride?: boolean;
}

function readStatus(error: unknown): number | undefined {
  if (error instanceof ProviderHttpError) return error.status;
  const candidate = (error as { status?: unknown; statusCode?: unknown } | null) ?? null;
  if (typeof candidate?.status === "number") return candidate.status;
  if (typeof candidate?.statusCode === "number") return candidate.statusCode;
  return undefined;
}

function isTimeoutError(error: unknown): boolean {
  return errorChain(error).some(
    (item) =>
      item.name === "TimeoutError" ||
      item.name === "AbortError" ||
      /timeout|timed out|超时|aborted/i.test(item.message),
  );
}

function isNetworkError(error: unknown): boolean {
  return errorChain(error).some((item) => {
    const code = (item as { code?: string }).code ?? "";
    const causeCode = ((item as { cause?: { code?: string } }).cause?.code) ?? "";
    return (
      item.name === "TypeError" ||
      /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network/i.test(
        `${item.message} ${code} ${causeCode}`,
      )
    );
  });
}

/** 沿 cause 链展开：服务层包装过的错误（`LLM call failed: ...`）仍能识别根因。 */
function errorChain(error: unknown): Error[] {
  const chain: Error[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * 判定一次失败该不该往下一个 provider 切。
 *
 * 设计取舍：401/403 也算可切换——主 provider 的 key 失效时，备用 key 往往
 * 是好的，这正是降级最该救的场景。反过来 400/422 是请求本身有问题，
 * 换 provider 只会再错一次，还白白污染健康度，所以不切换、也不计熔断。
 */
export function classifyProviderFailure(error: unknown, statusHint?: number): ProviderFailure {
  if (error instanceof ProviderHttpError && error.switchableOverride !== undefined) {
    const status = statusHint ?? error.status;
    if (status >= 400 && status < 500 && status !== 429 && status !== 408) {
      return { kind: "client", switchable: error.switchableOverride, status };
    }
  }
  const status = statusHint ?? readStatus(error);
  if (status !== undefined) {
    if (status === 429) return { kind: "rate_limit", switchable: true, status };
    if (status === 408) return { kind: "timeout", switchable: true, status };
    if (status === 401 || status === 403) return { kind: "auth", switchable: true, status };
    if (status >= 500) return { kind: "server", switchable: true, status };
    if (status >= 400) return { kind: "client", switchable: false, status };
  }
  if (isTimeoutError(error)) return { kind: "timeout", switchable: true };
  if (isNetworkError(error)) return { kind: "network", switchable: true };
  return { kind: "unknown", switchable: true };
}

// ────────────────────────── 熔断 + 选路 ──────────────────────────

export interface ProviderRouterOptions {
  /** 连续失败多少次熔断 */
  failureThreshold?: number;
  /** 首次冷却时长 */
  cooldownMs?: number;
  /** 冷却时长上限（连续熔断时指数翻倍，到这里封顶） */
  maxCooldownMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export type ProviderAvailability = "healthy" | "probe" | "cooling";

export interface PlannedProvider {
  candidate: ProviderCandidate;
  availability: ProviderAvailability;
  cooldownRemainingMs: number;
}

export interface ProviderHealthSnapshot {
  name: string;
  provider: string;
  model: string;
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  successes: number;
  failures: number;
  skips: number;
  successRate: number | null;
  avgLatencyMs: number | null;
  lastError: string | null;
  cooldownRemainingMs: number;
}

interface ProviderState {
  consecutiveFailures: number;
  successes: number;
  failures: number;
  skips: number;
  latencyTotalMs: number;
  latencySamples: number;
  openUntil: number;
  tripCount: number;
  lastError: string | null;
}

const DEFAULT_OPTIONS: Required<Omit<ProviderRouterOptions, "now" | "log">> = {
  failureThreshold: 3,
  cooldownMs: 30_000,
  maxCooldownMs: 300_000,
};

function freshState(): ProviderState {
  return {
    consecutiveFailures: 0,
    successes: 0,
    failures: 0,
    skips: 0,
    latencyTotalMs: 0,
    latencySamples: 0,
    openUntil: 0,
    tripCount: 0,
    lastError: null,
  };
}

export class ProviderRouter {
  private chain: ProviderCandidate[];
  private readonly states = new Map<string, ProviderState>();
  private readonly options: Required<Omit<ProviderRouterOptions, "now" | "log">>;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(
    readonly capability: ProviderCapability,
    chain: ProviderCandidate[],
    options: ProviderRouterOptions = {},
  ) {
    this.chain = chain;
    this.options = {
      failureThreshold: options.failureThreshold ?? DEFAULT_OPTIONS.failureThreshold,
      cooldownMs: options.cooldownMs ?? DEFAULT_OPTIONS.cooldownMs,
      maxCooldownMs: options.maxCooldownMs ?? DEFAULT_OPTIONS.maxCooldownMs,
    };
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.warn(message));
    this.syncChain(chain);
  }

  getChain(): ProviderCandidate[] {
    return this.chain;
  }

  /**
   * 运行时配置可能被设置面板改写，链变化时保留同名 provider 的健康度，
   * 只增删差异项——整体重建会把熔断状态清零，等于配置一动就放开全链路。
   */
  syncChain(chain: ProviderCandidate[]): void {
    this.chain = chain;
    const live = new Set(chain.map((item) => item.name));
    for (const name of [...this.states.keys()]) {
      if (!live.has(name)) this.states.delete(name);
    }
    for (const item of chain) {
      if (!this.states.has(item.name)) this.states.set(item.name, freshState());
    }
  }

  /**
   * 只读计划：half-open（冷却到期、等待试探）优先 → healthy（链序）→ cooling。
   *
   * 半开必须排在最前面：如果备用一直健康、主 provider 冷却到期后永远排在后面，
   * 备用每次都先成功，主就再也没机会被探活，等于永久摘除。
   */
  plan(now: number = this.now()): PlannedProvider[] {
    const healthy: PlannedProvider[] = [];
    const probe: PlannedProvider[] = [];
    const cooling: PlannedProvider[] = [];

    for (const candidate of this.chain) {
      const state = this.states.get(candidate.name) ?? freshState();
      if (state.openUntil > now) {
        cooling.push({
          candidate,
          availability: "cooling",
          cooldownRemainingMs: state.openUntil - now,
        });
      } else if (state.openUntil > 0) {
        probe.push({ candidate, availability: "probe", cooldownRemainingMs: 0 });
      } else {
        healthy.push({ candidate, availability: "healthy", cooldownRemainingMs: 0 });
      }
    }

    cooling.sort((a, b) => a.cooldownRemainingMs - b.cooldownRemainingMs);
    return [...probe, ...healthy, ...cooling];
  }

  /**
   * 本次请求实际要尝试的顺序。
   *
   * 正常情况下跳过冷却中的 provider；如果**全部**在冷却，给最早恢复的那个
   * 一次 best-effort 机会——硬失败对调用方没有任何好处，而抖动常常已经恢复。
   */
  attemptOrder(now: number = this.now()): PlannedProvider[] {
    const plan = this.plan(now).filter((item) => item.candidate.apiKey || item.candidate.provider === "fake");
    if (plan.length === 0) return [];

    const usable = plan.filter((item) => item.availability !== "cooling");
    if (usable.length > 0) {
      for (const item of plan) {
        if (item.availability === "cooling") {
          this.states.get(item.candidate.name)!.skips += 1;
          this.log(
            `[provider:${this.capability}] ${item.candidate.name} 冷却中` +
              `（剩 ${Math.ceil(item.cooldownRemainingMs / 1000)}s），本次跳过`,
          );
        }
      }
      return usable;
    }

    this.log(
      `[provider:${this.capability}] 全部 provider 处于冷却，best-effort 尝试最早恢复的 ${plan[0].candidate.name}`,
    );
    return plan.slice(0, 1);
  }

  recordSuccess(name: string, latencyMs?: number): void {
    const state = this.states.get(name);
    if (!state) return;
    // 冷却已到期、这次是放行的试探请求：成功即恢复，日志里留一条便于复盘
    const recovering = state.openUntil > 0 && state.openUntil <= this.now();
    state.successes += 1;
    state.consecutiveFailures = 0;
    state.tripCount = 0;
    state.openUntil = 0;
    state.lastError = null;
    if (typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0) {
      state.latencyTotalMs += latencyMs;
      state.latencySamples += 1;
    }
    if (recovering) {
      this.log(`[provider:${this.capability}] ${name} 试探成功，恢复为正常路由`);
    }
  }

  /** 记录一次失败；达到阈值则熔断。返回本次是否触发了熔断，便于调用方打点。 */
  recordFailure(name: string, error: unknown): boolean {
    const state = this.states.get(name);
    if (!state) return false;
    state.failures += 1;
    state.consecutiveFailures += 1;
    state.lastError = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    if (state.consecutiveFailures < this.options.failureThreshold) return false;

    state.tripCount += 1;
    const cooldownMs = Math.min(
      this.options.cooldownMs * Math.pow(2, state.tripCount - 1),
      this.options.maxCooldownMs,
    );
    state.openUntil = this.now() + cooldownMs;
    this.log(
      `[provider:${this.capability}] ${name} 连续失败 ${state.consecutiveFailures} 次，` +
        `熔断 ${Math.round(cooldownMs / 1000)}s（第 ${state.tripCount} 次）`,
    );
    return true;
  }

  /** 被熔断跳过计数（指标用；attemptOrder 内已自增） */
  recordSkip(name: string): void {
    const state = this.states.get(name);
    if (state) state.skips += 1;
  }

  snapshot(now: number = this.now()): ProviderHealthSnapshot[] {
    return this.chain.map((candidate) => {
      const state = this.states.get(candidate.name) ?? freshState();
      const settled = state.successes + state.failures;
      const stateName: ProviderHealthSnapshot["state"] =
        state.openUntil > now ? "open" : state.openUntil > 0 ? "half_open" : "closed";
      return {
        name: candidate.name,
        provider: candidate.provider,
        model: candidate.model,
        state: stateName,
        consecutiveFailures: state.consecutiveFailures,
        successes: state.successes,
        failures: state.failures,
        skips: state.skips,
        successRate: settled > 0 ? Number((state.successes / settled).toFixed(3)) : null,
        avgLatencyMs:
          state.latencySamples > 0 ? Math.round(state.latencyTotalMs / state.latencySamples) : null,
        lastError: state.lastError,
        cooldownRemainingMs: Math.max(0, state.openUntil - now),
      };
    });
  }

  /** 测试 / 手动运维复位 */
  reset(): void {
    for (const name of this.states.keys()) this.states.set(name, freshState());
  }
}

/** 从环境变量读取熔断参数，支持按能力覆盖（`TEXT_PROVIDER_FAILURE_THRESHOLD`）。 */
export function readRouterOptions(
  capability: ProviderCapability,
  get: ProviderEnvReader,
): ProviderRouterOptions {
  const prefix = capability.toUpperCase();
  const int = (value: string | undefined): number | undefined => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  return {
    failureThreshold:
      int(get(`${prefix}_PROVIDER_FAILURE_THRESHOLD`)) ?? int(get("PROVIDER_FAILURE_THRESHOLD")),
    cooldownMs: int(get(`${prefix}_PROVIDER_COOLDOWN_MS`)) ?? int(get("PROVIDER_COOLDOWN_MS")),
    maxCooldownMs:
      int(get(`${prefix}_PROVIDER_MAX_COOLDOWN_MS`)) ?? int(get("PROVIDER_MAX_COOLDOWN_MS")),
  };
}
