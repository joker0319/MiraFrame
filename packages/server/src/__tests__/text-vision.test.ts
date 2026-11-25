import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextService } from "../services/text.service";

/**
 * 视觉通道的协议层测试：只关心「发出去的请求长什么样」和「坏响应怎么退」。
 * 图片内容、压缩、解析在 keyframe-critic 那两层已经覆盖。
 */

type Env = Record<string, string | number | undefined>;

function makeConfig(env: Env) {
  return {
    get(key: string) {
      if (key === "app.textMaxRetries") return 0;
      if (key === "app.textRetryBaseMs") return 1;
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

function fail(status: number, body = "upstream error"): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn();
const FAKE_PNG = "data:image/jpeg;base64,AAAA";

const SINGLE: Env = {
  TEXT_PROVIDER: "openai",
  TEXT_BASE_URL: "https://primary.example/v1",
  TEXT_API_KEY: "k1",
  TEXT_MODEL: "qwen-plus",
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.at(-1);
  return JSON.parse(String(call?.[1]?.body ?? "{}")) as Record<string, unknown>;
}

describe("generateVision 请求体", () => {
  it("user 消息是多模态数组：文字在前、图片按序在后", async () => {
    fetchMock.mockResolvedValueOnce(okChat('{"score":8}'));
    const service = new TextService(makeConfig(SINGLE) as never);

    await service.generateVision("评审这两张图", [FAKE_PNG, "data:image/jpeg;base64,BBBB"]);

    const body = lastBody();
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0].role).toBe("system");
    const userContent = messages[1].content as Array<Record<string, unknown>>;
    expect(userContent[0]).toEqual({ type: "text", text: "评审这两张图" });
    expect(userContent[1]).toEqual({ type: "image_url", image_url: { url: FAKE_PNG } });
    expect(userContent[2]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,BBBB" },
    });
    expect(userContent).toHaveLength(3);
  });

  it("视觉模型名优先用 VISION_MODEL 覆盖，不改 baseUrl 和 key", async () => {
    fetchMock.mockResolvedValueOnce(okChat("{}"));
    const service = new TextService(
      makeConfig({ ...SINGLE, VISION_MODEL: "qwen-vl-max" }) as never,
    );

    await service.generateVision("看图", [FAKE_PNG], { model: "qwen-vl-max" });

    expect(lastBody().model).toBe("qwen-vl-max");
    expect(String(fetchMock.mock.calls[0][0])).toContain("primary.example");
  });

  it("不传 reasoning_effort：视觉判图不需要多步推理，白烧时间", async () => {
    fetchMock.mockResolvedValueOnce(okChat("{}"));
    const service = new TextService(
      makeConfig({ ...SINGLE, TEXT_REASONING_EFFORT: "high" }) as never,
    );

    await service.generateVision("看图", [FAKE_PNG]);

    expect(lastBody().reasoning_effort).toBeUndefined();
  });

  it("温度默认 0.2：评审要稳定，不要发挥", async () => {
    fetchMock.mockResolvedValueOnce(okChat("{}"));
    const service = new TextService(makeConfig(SINGLE) as never);

    await service.generateVision("看图", [FAKE_PNG]);

    expect(lastBody().temperature).toBe(0.2);
  });

  it("没有图片直接报错，不发空请求", async () => {
    const service = new TextService(makeConfig(SINGLE) as never);
    await expect(service.generateVision("看图", [])).rejects.toThrow(/至少需要一张图片/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("generateVision 失败切换", () => {
  const TWO: Env = {
    TEXT_PROVIDERS: "primary, backup",
    TEXT_PRIMARY_BASE_URL: "https://primary.example/v1",
    TEXT_PRIMARY_API_KEY: "k1",
    TEXT_PRIMARY_MODEL: "m1",
    TEXT_BACKUP_BASE_URL: "https://backup.example/v1",
    TEXT_BACKUP_API_KEY: "k2",
    TEXT_BACKUP_MODEL: "m2",
  };

  it("401 视为结构性故障：切到备用继续审", async () => {
    fetchMock
      .mockResolvedValueOnce(fail(401, "invalid key"))
      .mockResolvedValueOnce(okChat('{"ok":true}'));
    const service = new TextService(makeConfig(TWO) as never);

    await expect(service.generateVision("看图", [FAKE_PNG])).resolves.toBe('{"ok":true}');
    expect(String(fetchMock.mock.calls[1][0])).toContain("backup.example");
  });

  it("400 不切换：换一家也是同样的错，还会污染健康度", async () => {
    fetchMock.mockResolvedValueOnce(fail(400, "bad image format"));
    const service = new TextService(makeConfig(TWO) as never);

    await expect(service.generateVision("看图", [FAKE_PNG])).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("整条链都挂时抛聚合错误，文案区分视觉与文本", async () => {
    fetchMock.mockResolvedValueOnce(fail(500)).mockResolvedValueOnce(fail(503));
    const service = new TextService(makeConfig(TWO) as never);

    await expect(service.generateVision("看图", [FAKE_PNG])).rejects.toThrow(
      /所有视觉 provider 均失败/,
    );
  });

  it("视觉调用失败不影响文本调用：共用一条链但不共享错误状态", async () => {
    fetchMock
      .mockResolvedValueOnce(fail(401))
      .mockResolvedValueOnce(fail(401))
      .mockResolvedValueOnce(okChat("文本正常"));
    const service = new TextService(makeConfig(TWO) as never);

    await expect(service.generateVision("看图", [FAKE_PNG])).rejects.toThrow();
    await expect(service.generate("写个开头")).resolves.toBe("文本正常");
  });
});

describe("fake provider 的视觉分支", () => {
  it("返回可解析的 JSON，且镜头号能从提示词里读出来", async () => {
    const service = new TextService(makeConfig({ TEXT_PROVIDER: "fake" }) as never);

    const raw = await service.generateVision("图 1 = 镜头 #1\n图 2 = 镜头 #2", [FAKE_PNG], {
      intent: "critique_keyframes",
    });
    const parsed = JSON.parse(raw) as {
      shots: Array<{ order: number }>;
      needs_regenerate: boolean;
    };
    expect(parsed.shots.map((item) => item.order)).toEqual([1, 2]);
    // fake 用占位图，审也审不出东西，必须给「通过」避免触发无意义重画
    expect(parsed.needs_regenerate).toBe(false);
  });
});
