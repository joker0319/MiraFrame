import { Injectable, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ProviderHttpError,
  ProviderRouter,
  chainFingerprint,
  classifyProviderFailure,
  readRouterOptions,
  resolveProviderChain,
  type ProviderCandidate,
  type ProviderEnvReader,
  type ProviderHealthSnapshot,
} from "./provider-routing";

@Injectable()
export class ImageService {
  /** 熔断状态要跨请求累计，链被改写时原地同步。 */
  private router: ProviderRouter | null = null;
  private routerFingerprint = "";

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  private envReader(): ProviderEnvReader {
    const appFallbacks: Record<string, string> = {
      IMAGE_PROVIDER: "app.imageProvider",
      IMAGE_BASE_URL: "app.imageBaseUrl",
      IMAGE_API_KEY: "app.imageApiKey",
      IMAGE_MODEL: "app.imageModel",
      IMAGE_ENDPOINT: "app.imageEndpoint",
    };
    return (key: string) => {
      const direct = this.config.get<string>(key);
      if (typeof direct === "string" && direct.trim()) return direct;
      const appKey = appFallbacks[key];
      if (appKey) {
        const value = this.config.get<string>(appKey);
        if (typeof value === "string" && value.trim()) return value;
      }
      return undefined;
    };
  }

  private getRouter(): ProviderRouter {
    const get = this.envReader();
    const chain = resolveProviderChain("image", get);
    const fingerprint = chainFingerprint(chain);
    if (!this.router) {
      this.router = new ProviderRouter("image", chain, readRouterOptions("image", get));
      console.log(
        `[ImageService] provider 链：${chain.map((item) => `${item.name}${item.apiKey || item.provider === "fake" ? "" : "(no-key)"}`).join(" → ")}`,
      );
    } else if (fingerprint !== this.routerFingerprint) {
      this.router.syncChain(chain);
    }
    this.routerFingerprint = fingerprint;
    return this.router;
  }

  providerHealth(): ProviderHealthSnapshot[] {
    return this.getRouter().snapshot();
  }

  async generateImage(
    prompt: string,
    options?: { size?: string; referenceImages?: string[] },
  ): Promise<string> {
    const router = this.getRouter();
    const plan = router.attemptOrder();

    // 与改造前一致：一个 key 都没有时返回占位图，不让流水线整条断掉
    if (plan.length === 0) return placeholderDataUrl("Image API key missing");

    const failures: Array<{ name: string; message: string }> = [];
    for (let index = 0; index < plan.length; index += 1) {
      const { candidate } = plan[index];

      if (candidate.provider === "fake") {
        router.recordSuccess(candidate.name, 0);
        return this.config.get<string>("app.fakeImageFixtureUrl") || placeholderDataUrl("Image fixture");
      }

      const startedAt = Date.now();
      try {
        const url = await this.attemptGenerateImage(candidate, prompt, options);
        router.recordSuccess(candidate.name, Date.now() - startedAt);
        if (index > 0) {
          console.warn(
            `[ImageService] 已降级到 ${candidate.name}（前序 ` +
              `${plan.slice(0, index).map((item) => item.candidate.name).join("、")} 未成功）`,
          );
        }
        return url;
      } catch (error) {
        const failure = classifyProviderFailure(error);
        const message = error instanceof Error ? error.message : String(error);
        if (!failure.switchable) {
          console.error(`[ImageService] ${candidate.name} 拒绝请求（${failure.kind}），不切换：${message}`);
          throw error;
        }
        router.recordFailure(candidate.name, error);
        failures.push({ name: candidate.name, message: message.slice(0, 200) });
        const next = plan[index + 1];
        if (next) {
          console.warn(
            `[ImageService] ${candidate.name} 失败（${failure.kind}${failure.status ? ` ${failure.status}` : ""}），` +
              `切换到 ${next.candidate.name}：${message.slice(0, 120)}`,
          );
        }
      }
    }

    throw new Error(
      `所有图像 provider 均失败（${failures.map((item) => `${item.name}: ${item.message}`).join("；")}）`,
    );
  }

  private async attemptGenerateImage(
    candidate: ProviderCandidate,
    prompt: string,
    options?: { size?: string; referenceImages?: string[] },
  ): Promise<string> {
    const isDashScope =
      candidate.baseUrl.includes("dashscope") || candidate.endpoint.includes("multimodal-generation");

    const references = (options?.referenceImages || []).filter(Boolean).slice(0, 4);
    const requestBody = JSON.stringify(
      isDashScope
        ? {
            model: candidate.model,
            input: {
              messages: [
                {
                  role: "user",
                  content: [{ text: prompt }],
                },
              ],
            },
            parameters: {
              prompt_extend: true,
              watermark: false,
              size: normalizeDashScopeSize(options?.size || "1024x1024"),
            },
          }
        : buildAgnesImageBody(candidate.model, prompt, options?.size || "1024x1024", references),
    );

    console.log(`[ImageService] 出图(${candidate.name}) → POST ${candidate.baseUrl}${candidate.endpoint}`);

    const response = await postWithRateLimitRetry(`${candidate.baseUrl}${candidate.endpoint}`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${candidate.apiKey}`,
      },
      body: requestBody,
      timeoutMs: 180_000,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new ProviderHttpError(response.status, errorText);
    }

    const json = (await response.json()) as Record<string, unknown>;
    let url = extractMediaUrl(json);
    if (!url) {
      const taskId = extractTaskId(json);
      if (taskId) url = await this.pollDashScopeTask(candidate.baseUrl, candidate.apiKey, taskId, 180_000);
    }
    if (!url) {
      throw new Error(`Image API returned no URL: ${JSON.stringify(json).substring(0, 300)}`);
    }
    return url;
  }

  private async pollDashScopeTask(baseUrl: string, apiKey: string, taskId: string, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(5_000);
      const response = await fetch(`${baseUrl}/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) continue;
      const json = (await response.json()) as Record<string, unknown>;
      const status = extractTaskStatus(json);
      if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
        throw new Error(`Image task ${taskId} failed: ${JSON.stringify(json).substring(0, 300)}`);
      }
      const url = extractMediaUrl(json);
      if (status === "SUCCEEDED" && url) return url;
    }
    return null;
  }
}

/**
 * Agnes 图生图：参考图必须放在 extra_body.image，response_format 也不能放顶层。
 * 没有参考图时保持原来的文生图请求体，不影响既有生成链路。
 */
export function buildAgnesImageBody(
  model: string,
  prompt: string,
  size: string,
  referenceImages: string[] = [],
): Record<string, unknown> {
  const body: Record<string, unknown> = { model, prompt, n: 1, size };
  if (referenceImages.length > 0) {
    body.extra_body = { image: referenceImages, response_format: "url" };
  }
  return body;
}

export function extractMediaUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["url", "image", "img_url", "image_url", "video_url", "output_url"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }

  const b64 = record.b64_json;
  if (typeof b64 === "string" && b64) return `data:image/png;base64,${b64}`;

  for (const key of ["data", "output", "result", "results", "choices", "message", "content"]) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const url = extractMediaUrl(item);
        if (url) return url;
      }
    } else {
      const url = extractMediaUrl(nested);
      if (url) return url;
    }
  }

  return null;
}

export function extractTaskId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["task_id", "taskId", "id"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  for (const key of ["output", "data", "result"]) {
    const nested = extractTaskId(record[key]);
    if (nested) return nested;
  }
  return null;
}

export function extractTaskStatus(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.task_status === "string") return record.task_status;
  if (typeof record.status === "string") return record.status;
  for (const key of ["output", "data", "result"]) {
    const nested = extractTaskStatus(record[key]);
    if (nested) return nested;
  }
  return null;
}

function normalizeDashScopeSize(size: string): string {
  return size.replace("x", "*");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postWithRateLimitRetry(
  url: string,
  options: { headers: Record<string, string>; body: string; timeoutMs: number },
): Promise<Response> {
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: options.headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (response.status !== 429) return response;
    lastResponse = response;
    await response.text().catch(() => "");
    await sleep((attempt + 1) * 20_000);
  }
  return lastResponse as Response;
}

function placeholderDataUrl(label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="100%" height="100%" fill="#f3f4f6"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="44" fill="#6b7280">${label}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
