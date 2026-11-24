import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextService } from "../services/text.service";
import { ImageService } from "../services/image.service";
import type { ToolDefinition } from "@miraframe/agent";

type Env = Record<string, string | number | undefined>;

/** 最小 ConfigService 桩：app.* 走默认值，其余直接读传入的环境。 */
function makeConfig(env: Env) {
  return {
    get(key: string) {
      if (key === "app.textMaxRetries") return 0; // 测试里不做 429 退避
      if (key === "app.textRetryBaseMs") return 1;
      if (key === "app.videoMaxRetries") return 0;
      if (key === "app.videoRetryBaseMs") return 1;
      return env[key];
    },
  };
}

function okChat(content: string): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => "",
  } as unknown as Response;
}

function okTools(name: string): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: "{}" } }],
          },
        },
      ],
    }),
    text: async () => "",
  } as unknown as Response;
}

function fail(status: number, body = "upstream error"): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

const TWO_TEXT_PROVIDERS: Env = {
  TEXT_PROVIDERS: "primary, backup",
  TEXT_PRIMARY_BASE_URL: "https://primary.example/v1",
  TEXT_PRIMARY_API_KEY: "primary-key",
  TEXT_PRIMARY_MODEL: "primary-model",
  TEXT_BACKUP_BASE_URL: "https://backup.example/v1",
  TEXT_BACKUP_API_KEY: "backup-key",
  TEXT_BACKUP_MODEL: "backup-model",
};

const TOOLS: ToolDefinition[] = [
  { name: "write_outline_draft", description: "写草稿", inputSchema: { type: "object", properties: {} } },
];

describe("TextService provider 降级", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("主 provider 401 时自动切到备用，并把结果返回给调用方", async () => {
    fetchMock.mockResolvedValueOnce(fail(401, "invalid api key")).mockResolvedValueOnce(okChat("备用回答"));

    const service = new TextService(makeConfig(TWO_TEXT_PROVIDERS) as never);
    await expect(service.generate("写个开头")).resolves.toBe("备用回答");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("primary.example");
    expect(String(fetchMock.mock.calls[1][0])).toContain("backup.example");

    const [primary, backup] = service.providerHealth();
    expect(primary).toMatchObject({ name: "primary", failures: 1, successes: 0, lastError: expect.stringContaining("401") });
    expect(backup).toMatchObject({ name: "backup", successes: 1, successRate: 1 });
  });

  it("400 是请求本身的问题：直接失败，不切换也不记入熔断", async () => {
    fetchMock.mockResolvedValueOnce(fail(400, "bad prompt"));

    const service = new TextService(makeConfig(TWO_TEXT_PROVIDERS) as never);
    await expect(service.generate("坏请求")).rejects.toThrow(/400/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(service.providerHealth()[0].failures).toBe(0);
  });

  it("主 provider 连续失败达到阈值后熔断，后续请求不再打它", async () => {
    const service = new TextService(
      makeConfig({ ...TWO_TEXT_PROVIDERS, PROVIDER_FAILURE_THRESHOLD: "3" }) as never,
    );

    // 前三轮：primary 失败 → backup 顶上并成功（真实降级场景），primary 累计 3 次失败
    fetchMock
      .mockResolvedValueOnce(fail(500))
      .mockResolvedValueOnce(okChat("第 1 轮备用"))
      .mockResolvedValueOnce(fail(500))
      .mockResolvedValueOnce(okChat("第 2 轮备用"))
      .mockResolvedValueOnce(fail(500))
      .mockResolvedValueOnce(okChat("第 3 轮备用"))
      .mockResolvedValueOnce(okChat("熔断后备用直出")); // 第 4 轮 primary 被跳过

    for (let round = 1; round <= 3; round += 1) {
      await expect(service.generate("重试")).resolves.toBe(`第 ${round} 轮备用`);
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);

    await expect(service.generate("熔断后")).resolves.toBe("熔断后备用直出");

    // 第 4 轮只打了一次，且落在备用
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(String(fetchMock.mock.calls[6][0])).toContain("backup.example");
    expect(service.providerHealth()[0]).toMatchObject({ state: "open", consecutiveFailures: 3 });
  });

  it("整条链都失败时抛出聚合错误，带上每一家的原因", async () => {
    fetchMock.mockResolvedValueOnce(fail(503, "queue full")).mockResolvedValueOnce(fail(502, "bad gateway"));

    const service = new TextService(makeConfig(TWO_TEXT_PROVIDERS) as never);
    await expect(service.generate("hi")).rejects.toThrow(/primary: .*503.*backup: .*502/);
  });

  it("链尾放 fake 可以在真实 provider 全挂时兜底演示", async () => {
    fetchMock.mockResolvedValueOnce(fail(401, "key expired"));

    const service = new TextService(
      makeConfig({
        TEXT_PROVIDERS: "primary, local-fake",
        TEXT_PRIMARY_BASE_URL: "https://primary.example/v1",
        TEXT_PRIMARY_API_KEY: "expired",
        TEXT_LOCAL_FAKE_PROVIDER: "fake",
      }) as never,
    );

    const text = await service.generate("雨夜星灯", { intent: "outline" });
    expect(text).toContain("雨夜星灯");
    expect(service.providerHealth()[1]).toMatchObject({ name: "local-fake", successes: 1 });
  });

  it("没有任何可用密钥时保持改造前的占位行为", async () => {
    const service = new TextService(makeConfig({ TEXT_PROVIDER: "openai" }) as never);
    await expect(service.generate("hi")).resolves.toContain("[LLM not configured]");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tools 通道：主 provider 不支持 function calling 时切到备用", async () => {
    fetchMock
      .mockResolvedValueOnce(fail(400, "tools are not supported"))
      .mockResolvedValueOnce(okTools("write_outline_draft"));

    const service = new TextService(makeConfig(TWO_TEXT_PROVIDERS) as never);
    const response = await service.generateWithTools([{ role: "user", content: "写大纲" }], TOOLS);

    expect(response.toolCalls.map((call) => call.name)).toEqual(["write_outline_draft"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("tools 通道：整条链都不支持时回 TOOLS_UNSUPPORTED，让 ToolLoop 降级 JSON", async () => {
    fetchMock
      .mockResolvedValueOnce(fail(400, "tools unsupported"))
      .mockResolvedValueOnce(fail(422, "unknown field tools"));

    const service = new TextService(makeConfig(TWO_TEXT_PROVIDERS) as never);
    await expect(
      service.generateWithTools([{ role: "user", content: "写大纲" }], TOOLS),
    ).rejects.toThrow(/^TOOLS_UNSUPPORTED/);
  });

  it("tools 通道 429 不伪装成「不支持 tools」，但仍会切下一家", async () => {
    fetchMock.mockResolvedValueOnce(fail(429, "rate limit")).mockResolvedValueOnce(okTools("write_outline_draft"));

    const service = new TextService(makeConfig(TWO_TEXT_PROVIDERS) as never);
    await expect(
      service.generateWithTools([{ role: "user", content: "写大纲" }], TOOLS),
    ).resolves.toMatchObject({ content: "" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("配置改写后重建链路判断，但保留同名 provider 的熔断状态", async () => {
    fetchMock.mockResolvedValue(fail(500));
    const env: Env = { ...TWO_TEXT_PROVIDERS, PROVIDER_FAILURE_THRESHOLD: "1" };
    const service = new TextService(makeConfig(env) as never);

    await expect(service.generate("x")).rejects.toThrow();
    expect(service.providerHealth()[0].state).toBe("open");

    // 追加一个候选（模拟运行时改 .env 后下一次请求重新解析）
    env.TEXT_PROVIDERS = "primary, backup, third";
    env.TEXT_THIRD_BASE_URL = "https://third.example/v1";
    env.TEXT_THIRD_API_KEY = "third-key";
    const health = service.providerHealth();

    expect(health.map((item) => item.name)).toEqual(["primary", "backup", "third"]);
    expect(health[0].state).toBe("open");
    expect(health[2].state).toBe("closed");
  });
});

describe("ImageService provider 降级", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("主 provider 5xx 时切到备用并返回图片地址", async () => {
    fetchMock.mockResolvedValueOnce(fail(500, "internal")).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ data: [{ url: "https://cdn.example/shot.png" }] }),
      text: async () => "",
    } as unknown as Response);

    const service = new ImageService(
      makeConfig({
        IMAGE_PROVIDERS: "primary, backup",
        IMAGE_PRIMARY_BASE_URL: "https://img-a.example/v1",
        IMAGE_PRIMARY_API_KEY: "a",
        IMAGE_BACKUP_BASE_URL: "https://img-b.example/v1",
        IMAGE_BACKUP_API_KEY: "b",
      }) as never,
    );

    await expect(service.generateImage("雨夜街角")).resolves.toBe("https://cdn.example/shot.png");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(service.providerHealth()).toMatchObject([
      { name: "primary", failures: 1 },
      { name: "backup", successes: 1 },
    ]);
  });
});
