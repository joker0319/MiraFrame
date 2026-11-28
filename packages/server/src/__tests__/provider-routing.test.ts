import { describe, expect, it } from "vitest";
import {
  ProviderHttpError,
  ProviderRouter,
  chainFingerprint,
  classifyProviderFailure,
  providerEnvPrefix,
  resolveProviderChain,
  type ProviderCandidate,
} from "../services/provider-routing";

type Env = Record<string, string | undefined>;

const read = (env: Env) => (key: string) => env[key];

function candidate(name: string, overrides: Partial<ProviderCandidate> = {}): ProviderCandidate {
  return {
    name,
    provider: "openai",
    baseUrl: `https://${name}.example/v1`,
    apiKey: `${name}-key`,
    model: `${name}-model`,
    endpoint: "/chat/completions",
    ...overrides,
  };
}

describe("resolveProviderChain", () => {
  it("未配置 *_PROVIDERS 时退化为单元素链，与改造前行为一致", () => {
    const chain = resolveProviderChain(
      "text",
      read({ TEXT_PROVIDER: "openai", TEXT_BASE_URL: "https://a.example/v1", TEXT_API_KEY: "k" }),
    );
    expect(chain).toEqual([
      {
        name: "openai",
        provider: "openai",
        baseUrl: "https://a.example/v1",
        apiKey: "k",
        model: "deepseek-v4-flash",
        endpoint: "/chat/completions",
      },
    ]);
  });

  it("什么都不配时默认 fake，本地演示不需要任何密钥", () => {
    expect(resolveProviderChain("text", read({})).map((item) => item.provider)).toEqual(["fake"]);
  });

  it("逗号分隔的候选按声明顺序解析，scoped 变量覆盖通用值", () => {
    const chain = resolveProviderChain(
      "text",
      read({
        TEXT_PROVIDERS: "agnes, kimi",
        TEXT_PROVIDER: "openai",
        TEXT_BASE_URL: "https://base.example/v1",
        TEXT_API_KEY: "base-key",
        TEXT_MODEL: "base-model",
        TEXT_KIMI_BASE_URL: "https://kimi.example/v1",
        TEXT_KIMI_API_KEY: "kimi-key",
        TEXT_KIMI_MODEL: "kimi-k3",
      }),
    );
    expect(chain.map((item) => item.name)).toEqual(["agnes", "kimi"]);
    expect(chain[0]).toMatchObject({ baseUrl: "https://base.example/v1", apiKey: "base-key", model: "base-model" });
    expect(chain[1]).toMatchObject({
      baseUrl: "https://kimi.example/v1",
      apiKey: "kimi-key",
      model: "kimi-k3",
      provider: "openai",
    });
  });

  it("清理空项与重复项，大小写视为同一家", () => {
    const chain = resolveProviderChain("text", read({ TEXT_PROVIDERS: "agnes, ,Kimi, kimi ,agnes" }));
    expect(chain.map((item) => item.name)).toEqual(["agnes", "Kimi"]);
  });

  it("apiKey 为空不从链里剔除，让调用方区分「没配」与「配了但失败」", () => {
    const chain = resolveProviderChain("text", read({ TEXT_PROVIDERS: "a,b", TEXT_A_API_KEY: "ka" }));
    expect(chain).toHaveLength(2);
    expect(chain[1].apiKey).toBe("");
  });

  it("带连字符的名字用下划线前缀读配置", () => {
    expect(providerEnvPrefix("kimi-k2")).toBe("KIMI_K2");
    const chain = resolveProviderChain(
      "text",
      read({ TEXT_PROVIDERS: "kimi-k2", TEXT_KIMI_K2_MODEL: "kimi-k2-thinking" }),
    );
    expect(chain[0].model).toBe("kimi-k2-thinking");
  });

  it("指纹不含密钥，改密钥不会误判为换链", () => {
    const a = resolveProviderChain("text", read({ TEXT_PROVIDERS: "agnes", TEXT_API_KEY: "k1" }));
    const b = resolveProviderChain("text", read({ TEXT_PROVIDERS: "agnes", TEXT_API_KEY: "k2" }));
    expect(chainFingerprint(a)).toBe(chainFingerprint(b));
  });
});

describe("classifyProviderFailure", () => {
  it("429 视为限流，可切换", () => {
    expect(classifyProviderFailure(new ProviderHttpError(429, "slow down"))).toEqual({
      kind: "rate_limit",
      switchable: true,
      status: 429,
    });
  });

  it("5xx 可切换，401/403 也可切换（备用 key 往往有效）", () => {
    expect(classifyProviderFailure(new ProviderHttpError(503, "busy"))).toMatchObject({
      kind: "server",
      switchable: true,
    });
    expect(classifyProviderFailure(new ProviderHttpError(401, "bad key"))).toMatchObject({
      kind: "auth",
      switchable: true,
    });
    expect(classifyProviderFailure(new ProviderHttpError(403, "forbidden"))).toMatchObject({
      kind: "auth",
      switchable: true,
    });
  });

  it("400/422 是请求本身的问题，不切换也不该污染健康度", () => {
    expect(classifyProviderFailure(new ProviderHttpError(400, "bad prompt"))).toMatchObject({
      kind: "client",
      switchable: false,
    });
    expect(classifyProviderFailure(new ProviderHttpError(422, "unprocessable"))).toMatchObject({
      switchable: false,
    });
  });

  it("显式 switchableOverride 可以覆盖 4xx 的默认判断（工具通道用）", () => {
    expect(
      classifyProviderFailure(new ProviderHttpError(400, "tools not supported", { switchableOverride: true })),
    ).toMatchObject({ kind: "client", switchable: true });
    // 429 即使带 override 也仍是限流语义
    expect(
      classifyProviderFailure(new ProviderHttpError(429, "slow", { switchableOverride: true })).kind,
    ).toBe("rate_limit");
  });

  it("超时与网络错误可切换，且能沿 cause 链识别", () => {
    const timeout = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    expect(classifyProviderFailure(timeout)).toMatchObject({ kind: "timeout", switchable: true });

    const wrapped = new Error("LLM call failed: fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }),
    });
    expect(classifyProviderFailure(wrapped)).toMatchObject({ kind: "network", switchable: true });
  });

  it("未知错误按可切换处理：宁可多试一家", () => {
    expect(classifyProviderFailure(new Error("something odd"))).toMatchObject({
      kind: "unknown",
      switchable: true,
    });
  });
});

describe("ProviderRouter 熔断状态机", () => {
  function makeRouter(options: { threshold?: number; cooldownMs?: number; maxCooldownMs?: number } = {}) {
    let now = 1_000;
    const router = new ProviderRouter("text", [candidate("primary"), candidate("backup")], {
      failureThreshold: options.threshold ?? 2,
      cooldownMs: options.cooldownMs ?? 1_000,
      maxCooldownMs: options.maxCooldownMs ?? 8_000,
      now: () => now,
      log: () => undefined,
    });
    return {
      router,
      advance: (ms: number) => {
        now += ms;
      },
      current: () => now,
    };
  }

  it("健康时按链序尝试", () => {
    const { router } = makeRouter();
    expect(router.attemptOrder().map((item) => item.candidate.name)).toEqual(["primary", "backup"]);
  });

  it("未达阈值仍优先主 provider", () => {
    const { router } = makeRouter({ threshold: 2 });
    router.recordFailure("primary", new Error("boom"));
    expect(router.attemptOrder().map((item) => item.candidate.name)).toEqual(["primary", "backup"]);
  });

  it("连续失败达到阈值后熔断：冷却期内跳过，日志之外不影响备用", () => {
    const { router } = makeRouter({ threshold: 2, cooldownMs: 1_000 });
    const tripped = [router.recordFailure("primary", new Error("a")), router.recordFailure("primary", new Error("b"))];
    expect(tripped).toEqual([false, true]);

    const order = router.attemptOrder();
    expect(order.map((item) => item.candidate.name)).toEqual(["backup"]);
    expect(router.snapshot()[0]).toMatchObject({ state: "open", consecutiveFailures: 2 });
    expect(router.snapshot()[0].cooldownRemainingMs).toBe(1_000);
    expect(router.snapshot()[0].skips).toBe(1);
  });

  it("冷却到期后转为 half-open 并排在最前面探测，成功即恢复", () => {
    const { router, advance } = makeRouter({ threshold: 1, cooldownMs: 1_000 });
    router.recordFailure("primary", new Error("boom"));
    advance(1_000);

    const order = router.attemptOrder();
    expect(order.map((item) => [item.candidate.name, item.availability])).toEqual([
      ["primary", "probe"],
      ["backup", "healthy"],
    ]);
    expect(router.snapshot()[0].state).toBe("half_open");

    router.recordSuccess("primary", 120);
    expect(router.snapshot()[0]).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
      successes: 1,
      avgLatencyMs: 120,
    });
    expect(router.attemptOrder().map((item) => item.candidate.name)).toEqual(["primary", "backup"]);
  });

  it("half-open 探测失败：冷却时间翻倍", () => {
    const { router, advance } = makeRouter({ threshold: 1, cooldownMs: 1_000, maxCooldownMs: 8_000 });
    router.recordFailure("primary", new Error("boom"));
    advance(1_000);
    router.attemptOrder(); // 触发一次探测计划
    router.recordFailure("primary", new Error("still down"));
    expect(router.snapshot()[0].cooldownRemainingMs).toBe(2_000);
  });

  it("连续熔断的冷却时长指数增长但封顶", () => {
    const { router, advance } = makeRouter({ threshold: 1, cooldownMs: 1_000, maxCooldownMs: 3_000 });
    router.recordFailure("primary", new Error("1"));
    advance(1_000); // half-open
    router.recordFailure("primary", new Error("2"));
    expect(router.snapshot()[0].cooldownRemainingMs).toBe(2_000);

    advance(2_000); // half-open
    router.recordFailure("primary", new Error("3"));
    expect(router.snapshot()[0].cooldownRemainingMs).toBe(3_000);

    advance(3_000);
    router.recordFailure("primary", new Error("4"));
    expect(router.snapshot()[0].cooldownRemainingMs).toBe(3_000);
  });

  it("全部熔断时仍 best-effort 尝试最早恢复的一家，而不是直接失败", () => {
    const { router, advance } = makeRouter({ threshold: 1, cooldownMs: 1_000 });
    router.recordFailure("primary", new Error("a"));
    advance(100);
    router.recordFailure("backup", new Error("b"));

    const order = router.attemptOrder();
    expect(order).toHaveLength(1);
    expect(order[0].candidate.name).toBe("primary"); // 早 100ms 恢复
  });

  it("无密钥的候选不会被尝试，fake 不受影响", () => {
    const router = new ProviderRouter(
      "text",
      [candidate("no-key", { apiKey: "" }), candidate("fake", { provider: "fake" })],
      { log: () => undefined },
    );
    expect(router.attemptOrder().map((item) => item.candidate.name)).toEqual(["fake"]);
  });

  it("syncChain 保留同名 provider 的健康度，只增删差异项", () => {
    const { router } = makeRouter({ threshold: 1, cooldownMs: 1_000 });
    router.recordFailure("primary", new Error("boom"));
    router.syncChain([candidate("primary"), candidate("extra")]);

    expect(router.snapshot().map((item) => [item.name, item.state])).toEqual([
      ["primary", "open"],
      ["extra", "closed"],
    ]);
  });

  it("统计成功率与平均延迟，供 /providers 观测", () => {
    const { router } = makeRouter({ threshold: 5 });
    router.recordSuccess("primary", 100);
    router.recordSuccess("primary", 300);
    router.recordFailure("primary", new Error("boom"));

    expect(router.snapshot()[0]).toMatchObject({
      successes: 2,
      failures: 1,
      successRate: 0.667,
      avgLatencyMs: 200,
      lastError: "boom",
    });
  });
});
