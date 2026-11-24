import { Injectable, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { LlmChatMessage, LlmChatResponse, ToolDefinition, ToolCall } from "@miraframe/agent";
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
export class TextService {
  // 进程级请求队列：多数 LLM 账号并发限制为 1（如 Kimi），把请求串行化，
  // 从源头避免"并发超限"型 429；重试只需处理偶发的 RPM 频率限制。
  private static requestQueue: Promise<unknown> = Promise.resolve();

  /** 选路器持有熔断状态，必须跨请求复用；链被运行时改写时原地同步而不重建。 */
  private router: ProviderRouter | null = null;
  private routerFingerprint = "";

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  private envReader(): ProviderEnvReader {
    // 保留改造前的兜底顺序：TEXT_* → ANTHROPIC_*（历史上只配过这一组）→ app.* 默认值。
    // 否则 `.env` 里只写 ANTHROPIC_AUTH_TOKEN 的环境会在选路时被判定为「没有 key」。
    const anthropicFallbacks: Record<string, string> = {
      TEXT_BASE_URL: "ANTHROPIC_BASE_URL",
      TEXT_API_KEY: "ANTHROPIC_AUTH_TOKEN",
      TEXT_MODEL: "ANTHROPIC_MODEL",
    };
    const appFallbacks: Record<string, string> = {
      TEXT_PROVIDER: "app.textProvider",
      TEXT_BASE_URL: "app.textBaseUrl",
      TEXT_API_KEY: "app.textApiKey",
      TEXT_MODEL: "app.textModel",
      TEXT_ENDPOINT: "app.textEndpoint",
    };
    return (key: string) => {
      const direct = this.config.get<string>(key);
      if (typeof direct === "string" && direct.trim()) return direct;
      const anthropicKey = anthropicFallbacks[key];
      if (anthropicKey) {
        const value = this.config.get<string>(anthropicKey);
        if (typeof value === "string" && value.trim()) return value;
      }
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
    const chain = resolveProviderChain("text", get);
    const fingerprint = chainFingerprint(chain);
    if (!this.router) {
      this.router = new ProviderRouter("text", chain, readRouterOptions("text", get));
      this.logChain(chain);
    } else if (fingerprint !== this.routerFingerprint) {
      this.router.syncChain(chain);
      this.logChain(chain);
    }
    this.routerFingerprint = fingerprint;
    return this.router;
  }

  private logChain(chain: ProviderCandidate[]): void {
    const names = chain
      .map((item) => `${item.name}${item.provider === "fake" ? "(fake)" : ""}${item.apiKey || item.provider === "fake" ? "" : "(no-key)"}`)
      .join(" → ");
    console.log(`[TextService] provider 链：${names}`);
  }

  /** 只读健康快照，供 /api/v1/providers 观测。 */
  providerHealth(): ProviderHealthSnapshot[] {
    return this.getRouter().snapshot();
  }

  async generate(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; systemPrompt?: string; intent?: string },
  ): Promise<string> {
    const router = this.getRouter();
    const plan = router.attemptOrder();

    // 链里没有任何「配了 key 的非 fake 候选」：沿用改造前的占位行为，
    // 让未配置密钥的本地环境和 fake 演示不受影响。
    if (plan.length === 0) {
      console.warn("[TextService] 没有可用的 provider（未配置 API key）— 返回占位文本");
      return `[LLM not configured] API key not set. Prompt was: ${prompt.substring(0, 100)}...`;
    }

    const failures: Array<{ name: string; message: string }> = [];
    for (let index = 0; index < plan.length; index += 1) {
      const { candidate } = plan[index];

      if (candidate.provider === "fake") {
        this.announceFallback(plan, index);
        router.recordSuccess(candidate.name, 0);
        return this.generateFakeResponse(prompt, options?.intent);
      }

      const startedAt = Date.now();
      try {
        const text = await this.attemptGenerate(candidate, prompt, options);
        router.recordSuccess(candidate.name, Date.now() - startedAt);
        this.announceFallback(plan, index);
        return text;
      } catch (error) {
        const failure = classifyProviderFailure(error);
        const message = error instanceof Error ? error.message : String(error);
        // 请求本身有问题（400/422 等）：换 provider 只会再错一次，还会污染健康度
        if (!failure.switchable) {
          console.error(
            `[TextService] ${candidate.name} 拒绝请求（${failure.kind}${failure.status ? ` ${failure.status}` : ""}），不切换：${message}`,
          );
          throw error;
        }
        router.recordFailure(candidate.name, error);
        failures.push({ name: candidate.name, message: message.slice(0, 200) });
        const next = plan[index + 1];
        if (next) {
          console.warn(
            `[TextService] ${candidate.name} 失败（${failure.kind}${failure.status ? ` ${failure.status}` : ""}），` +
              `切换到 ${next.candidate.name}：${message.slice(0, 120)}`,
          );
        }
      }
    }

    throw new Error(
      `所有文本 provider 均失败（${failures.map((item) => `${item.name}: ${item.message}`).join("；")}）`,
    );
  }

  /** 非首选候选成功时补一条降级日志，日志里能直接复盘「哪家挂了、切到了谁」。 */
  private announceFallback(plan: Array<{ candidate: ProviderCandidate }>, index: number): void {
    if (index === 0) return;
    console.warn(
      `[TextService] 已降级到 ${plan[index].candidate.name}（前序 ` +
        `${plan.slice(0, index).map((item) => item.candidate.name).join("、")} 未成功）`,
    );
  }

  private async attemptGenerate(
    candidate: ProviderCandidate,
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; systemPrompt?: string; intent?: string },
  ): Promise<string> {
    const forceTemperature = this.config.get<number>("app.textForceTemperature");
    const timeoutMs = this.config.get<number>("app.textTimeoutMs") || 300_000;

    console.log(`[TextService] provider=${candidate.name}(${candidate.provider}) model=${candidate.model}`);
    console.log(`[TextService] url=${candidate.baseUrl}${candidate.endpoint}`);

    const body = {
      model: candidate.model,
      messages: [
        {
          role: "system",
          content:
            options?.systemPrompt ||
            "You are a creative AI assistant specialized in story creation, character design, and storyboarding for animated comics.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: options?.maxTokens || 4096,
      temperature: forceTemperature ?? options?.temperature ?? 0.7,
    } as Record<string, unknown>;
    const reasoningEffort = this.config.get<string>("app.textReasoningEffort");
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;

    console.log(`[TextService] → POST ${candidate.baseUrl}${candidate.endpoint}`);

    try {
      const response = await this.fetchWithRetry(`${candidate.baseUrl}${candidate.endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${candidate.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      console.log(`[TextService] ← HTTP ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        console.error(`[TextService] LLM API error ${response.status}: ${errorText}`);
        // 抛带状态码的错误：选路层据此决定是否切换/熔断，不靠正则猜
        throw new ProviderHttpError(response.status, errorText);
      }

      const json = (await response.json()) as Record<string, unknown>;
      console.log(`[TextService] Response structure:`, Object.keys(json));

      // OpenAI-compatible: choices[0].message.content
      const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
      if (choices?.[0]?.message?.content) {
        const content = choices[0].message.content;
        console.log(`[TextService] Content length=${content.length}`);
        return content;
      }

      // Anthropic-compatible: content[0].text
      const contentArr = json.content as Array<{ text?: string }> | undefined;
      if (contentArr?.[0]?.text) {
        console.log(`[TextService] Content length=${contentArr[0].text.length}`);
        return contentArr[0].text;
      }

      console.warn(`[TextService] Unexpected response format:`, JSON.stringify(json).substring(0, 300));
      return JSON.stringify(json);
    } catch (error) {
      if (error instanceof ProviderHttpError) throw error;
      console.error(`[TextService] Network/fetch error:`, error);
      // 保留 cause，让分类器能识别超时/网络根因
      throw new Error(`LLM call failed: ${String(error)}`, { cause: error });
    }
  }

  /**
   * Function calling 通道：把工具描述发给模型，解析它返回的 tool_calls。
   *
   * 与 generate() 的区别只在于"模型可以决定做什么"，而不是只能生成一段文本。
   * fake provider 用状态机模拟了"写草稿 → 落库 → 收尾"三轮决策，
   * 因此不开 API key 也能完整演示 Agent 循环。
   */
  async generateWithTools(
    messages: LlmChatMessage[],
    tools: ToolDefinition[],
    options?: { maxTokens?: number; temperature?: number; intent?: string },
  ): Promise<LlmChatResponse> {
    const router = this.getRouter();
    const plan = router.attemptOrder();

    // 与改造前一致：无密钥时抛特定错误，ToolLoop 会降级到 JSON 协议
    if (plan.length === 0) {
      throw new Error("TOOLS_UNSUPPORTED: API key not configured");
    }

    const failures: Array<{ name: string; message: string; toolsIssue: boolean }> = [];
    for (let index = 0; index < plan.length; index += 1) {
      const { candidate } = plan[index];

      if (candidate.provider === "fake") {
        this.announceFallback(plan, index);
        router.recordSuccess(candidate.name, 0);
        return this.fakeToolLoop(messages, tools);
      }

      const startedAt = Date.now();
      try {
        const response = await this.attemptWithTools(candidate, messages, tools, options);
        router.recordSuccess(candidate.name, Date.now() - startedAt);
        this.announceFallback(plan, index);
        return response;
      } catch (error) {
        const failure = classifyProviderFailure(error);
        const message = error instanceof Error ? error.message : String(error);
        const toolsIssue =
          error instanceof ProviderHttpError && error.switchableOverride === true && failure.kind === "client";

        if (!failure.switchable) {
          console.error(`[TextService] ${candidate.name} 拒绝 tools 请求（${failure.kind}），不切换：${message}`);
          throw error;
        }

        router.recordFailure(candidate.name, error);
        failures.push({ name: candidate.name, message: message.slice(0, 200), toolsIssue });
        const next = plan[index + 1];
        if (next) {
          console.warn(
            `[TextService] tools 通道 ${candidate.name} 失败（${failure.kind}${failure.status ? ` ${failure.status}` : ""}），` +
              `切换到 ${next.candidate.name}：${message.slice(0, 120)}`,
          );
        }
      }
    }

    const prefix = failures.length > 0 && failures.every((item) => item.toolsIssue) ? "TOOLS_UNSUPPORTED: " : "";
    throw new Error(
      `${prefix}所有文本 provider 均失败（${failures.map((item) => `${item.name}: ${item.message}`).join("；")}）`,
    );
  }

  private async attemptWithTools(
    candidate: ProviderCandidate,
    messages: LlmChatMessage[],
    tools: ToolDefinition[],
    options?: { maxTokens?: number; temperature?: number; intent?: string },
  ): Promise<LlmChatResponse> {
    const timeoutMs = this.config.get<number>("app.textTimeoutMs") || 300_000;

    const body = {
      model: candidate.model,
      messages: messages.map(toWireMessage),
      tools: tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      tool_choice: "auto",
      max_tokens: options?.maxTokens || 4096,
      temperature: this.config.get<number>("app.textForceTemperature") ?? options?.temperature ?? 0.7,
    } as Record<string, unknown>;
    const reasoningEffort = this.config.get<string>("app.textReasoningEffort");
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;

    console.log(
      `[TextService] tools(${candidate.name}) → POST ${candidate.baseUrl}${candidate.endpoint} | tools=${tools.map((t) => t.name).join(",")}`,
    );

    const response = await this.fetchWithRetry(`${candidate.baseUrl}${candidate.endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${candidate.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.error(`[TextService] tool-calls error ${response.status} (${candidate.name}): ${errorText}`);
      if (response.status === 429) {
        // 限流按 rate_limit 处理（切下一家），不要被当成「不支持 tools」
        throw new ProviderHttpError(429, errorText, {
          message: `LLM API error 429 (rate limit, retries exhausted): ${errorText.substring(0, 200)}`,
        });
      }
      // 其它 4xx/5xx 在工具通道上很可能是「这家不支持 function calling」，
      // 换一家有实际意义，所以显式标为可切换；全部失败时上层回 TOOLS_UNSUPPORTED 让 ToolLoop 走 JSON。
      throw new ProviderHttpError(response.status, errorText, {
        switchableOverride: true,
        message: `LLM API error ${response.status}: ${errorText.substring(0, 200)}`,
      });
    }

    const json = (await response.json()) as Record<string, unknown>;
    const choices = json.choices as Array<{ message?: Record<string, unknown> }> | undefined;
    const message = choices?.[0]?.message || {};
    const content = typeof message.content === "string" ? message.content : "";
    const toolCalls = parseWireToolCalls(message.tool_calls);
    console.log(`[TextService] tools ← content=${content.length} chars, toolCalls=${toolCalls.length}`);
    return { content, toolCalls };
  }

  /**
   * 带 429 限流自动重试的 fetch。
   *
   *  reasoning 模型账号常有 RPM / 并发限制（如 Kimi 3 次/分钟、并发 1），
   *  流水线连续调用会撞 429。这里在遇到 429 时按指数退避自动等待重试，
   *  优先采用服务端 Retry-After / 错误信息里建议的等待秒数。
   *  网络层错误（fetch 抛异常）也一并重试，提升弱网下的稳定性。
   */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    // 排队：等上一个请求（含其重试）彻底结束再发，保证任一时刻只发一个请求
    const previous = TextService.requestQueue;
    let release!: () => void;
    TextService.requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await this.doFetchWithRetry(url, init);
    } finally {
      release();
    }
  }

  private async doFetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const maxRetries = this.config.get<number>("app.textMaxRetries") ?? 6;
    const baseDelayMs = this.config.get<number>("app.textRetryBaseMs") ?? 1000;
    let lastNetworkError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        lastNetworkError = error;
        if (attempt >= maxRetries) break;
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.warn(
          `[TextService] 网络错误，${delay}ms 后重试 (${attempt + 1}/${maxRetries}): ${String(error)}`,
        );
        await this.sleep(delay);
        continue;
      }

      if (response.status !== 429 || attempt >= maxRetries) {
        return response;
      }

      const delay = await this.resolveRetryDelay(response, baseDelayMs, attempt);
      console.warn(
        `[TextService] 429 限流，${delay}ms 后重试 (${attempt + 1}/${maxRetries})`,
      );
      await this.sleep(delay);
    }

    if (lastNetworkError instanceof Error) throw lastNetworkError;
    throw new Error("LLM API error 429: 重试已耗尽");
  }

  /** 解析等待时间：优先服务端建议（Retry-After 头 / 错误信息），否则指数退避；都加随机抖动防同步重试。 */
  private async resolveRetryDelay(
    response: Response,
    baseDelayMs: number,
    attempt: number,
  ): Promise<number> {
    let suggestedMs = 0;

    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = parseFloat(retryAfter);
      if (!Number.isNaN(seconds) && seconds >= 0) suggestedMs = seconds * 1000;
    }

    if (!suggestedMs) {
      const errorText = await response.text().catch(() => "");
      const match = errorText.match(/after\s+(\d+(?:\.\d+)?)\s*(?:second|s)\b/i);
      if (match) suggestedMs = parseFloat(match[1]) * 1000;
    }

    const backoffMs = baseDelayMs * Math.pow(2, attempt);
    const jitterMs = Math.floor(Math.random() * 500);
    return Math.max(suggestedMs, backoffMs) + jitterMs;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private fakeToolLoop(messages: LlmChatMessage[], tools: ToolDefinition[]): LlmChatResponse {
    const toolResults = messages.filter((message) => message.role === "tool").map((message) => message.content);
    const hasDraft = toolResults.some((text) => text.includes("草稿已记录"));
    const hasSaved = toolResults.some((text) => text.includes("大纲已保存"));

    if (!hasDraft && tools.some((tool) => tool.name === "write_outline_draft")) {
      console.log(`[TextService:fake] 模型决策 → write_outline_draft`);
      return {
        content: "",
        toolCalls: [
          {
            id: "fake-write-1",
            name: "write_outline_draft",
            arguments: { outline: FAKE_OUTLINE, note: "先写草稿，再根据完整性决定是否落库" },
          },
        ],
      };
    }

    if (hasDraft && !hasSaved && tools.some((tool) => tool.name === "save_outline")) {
      console.log(`[TextService:fake] 模型决策 → save_outline`);
      return {
        content: "",
        toolCalls: [{ id: "fake-save-1", name: "save_outline", arguments: { draftId: "draft-1" } }],
      };
    }

    console.log(`[TextService:fake] 模型决策 → 结束，无更多工具调用`);
    return { content: "大纲已通过工具流程保存完成。", toolCalls: [] };
  }

  private generateFakeResponse(prompt: string, intent?: string): string {
    // Agents pass an explicit intent so the fake provider returns the right
    // fixture even when the prompt contains keywords for other request types
    // (e.g. the project context embeds the approved outline's "shots").
    const normalized = (intent || prompt).toLowerCase();

    // Director（Supervisor）规划：演示用，返回一个跳过角色图阶段的短篇计划，
    // 让"模型决定路径"在本地 fake 模式下也能被观察到。
    if (normalized.includes("director-plan")) {
      return JSON.stringify({
        steps: ["plan_outline", "plan_shots", "critique_shots", "render_shot_images", "compose_videos"],
        rationale: "短篇样片，跳过独立角色图阶段以节省时间，保留质检与成片环节。",
      });
    }

    // Review 路由决策：根据反馈类型演示不同的回退目标
    if (normalized.includes("review-route")) {
      const p = prompt.toLowerCase();
      let targetStage = "plan_shots";
      if (p.includes("角色") || p.includes("character")) targetStage = "plan_characters";
      else if (p.includes("大纲") || p.includes("剧情") || p.includes("结构")) targetStage = "plan_outline";
      else if (p.includes("画面") || p.includes("色调") || p.includes("风格")) targetStage = "render_shot_images";
      else if (p.includes("剪辑") || p.includes("时长") || p.includes("顺序")) targetStage = "compose_videos";
      return JSON.stringify({
        targetStage,
        mode: "incremental",
        rationale: `反馈指向${targetStage}，采用增量模式复用其余产物。`,
      });
    }

    // 滚动摘要：fake 模式下给一段结构化摘要，让「多轮记忆」本地也能演示
    if (normalized.includes("memory")) {
      const turnCount = (prompt.match(/【第 \d+ 轮】/g) ?? []).length;
      return [
        "第 1 轮：用户要求冷色调与雨夜氛围，保留结尾的灯笼特写；",
        "第 2 轮：确认跳过独立角色图阶段，先出分镜再审。",
        turnCount > 0 ? `（本次合并了 ${turnCount} 轮更早对话）` : "",
      ]
        .filter(Boolean)
        .join("");
    }

    if (normalized.includes("shot")) {
      return JSON.stringify({
        shots: [
          {
            order: 1,
            description: "雨夜街角，少女撑伞停在熄灭的路灯下，城市霓虹被雨水拉成长线。",
            camera: "Wide shot",
            scene: "雨夜街道",
            action: "少女抬头看见一盏微弱发光的灯笼。",
            dialogue: "这里以前，好像很亮。",
          },
          {
            order: 2,
            description: "AI 灯笼从旧灯杆旁亮起，用温柔光点组成一段遗失的童年画面。",
            camera: "Medium shot",
            scene: "旧灯杆旁",
            action: "星灯绕着少女旋转，投射光影故事。",
            dialogue: "我负责记得，你负责再次看见。",
          },
          {
            order: 3,
            description: "少女跟随光点奔跑，沿途一盏盏路灯被点亮，行人的表情逐渐柔和。",
            camera: "Tracking shot",
            scene: "城市长街",
            action: "城市记忆被连续点亮。",
            dialogue: "",
          },
          {
            order: 4,
            description: "天色放晴，少女把速写本摊开，星灯停在肩旁，整座城市映出暖色光晕。",
            camera: "Close-up",
            scene: "清晨天台",
            action: "少女画下新的故事开头。",
            dialogue: "这一次，我也想把光留下。",
          },
        ],
      });
    }

    if (normalized.includes("character")) {
      return JSON.stringify({
        characters: [
          {
            name: "林小雨",
            description: "敏感但勇敢的少女，习惯把情绪藏在速写本里，在故事中逐步学会主动表达。",
          },
          {
            name: "星灯",
            description: "会讲故事的 AI 灯笼，外形温暖灵动，能用光影唤醒城市中被遗忘的记忆。",
          },
        ],
      });
    }

    return JSON.stringify(FAKE_OUTLINE);
  }
}

/** fake provider 与工具循环共用的大纲样本，保证两条路径产物一致 */
const FAKE_OUTLINE: Record<string, unknown> = {
  title: "雨夜星灯",
  logline: "一个孤独少女遇见会讲故事的 AI 灯笼，在雨夜城市中找回被遗忘的温暖记忆。",
  genre: ["奇幻", "治愈"],
  themes: ["记忆", "陪伴", "成长"],
  setting: "近未来城市，雨夜的霓虹与旧街巷交错，遗失的记忆被星光点亮。",
  tone: "温柔、克制、带一点淡淡的忧伤",
  visual_bible: "治愈系二次元漫剧，雨夜霓虹、暖金光点、柔和镜头运动，情绪从冷蓝过渡到晨曦金。",
  acts: [
    { act: 1, title: "雨夜相遇", summary: "少女在雨夜迷路，发现一盏会说话的灯笼。" },
    { act: 2, title: "点亮街区", summary: "灯笼带她看见城市遗失的回忆，两人一起点亮街区。" },
    { act: 3, title: "留下光", summary: "少女学会记录和分享自己的故事，城市重新拥有光。" },
  ],
  emotional_arc: "从孤独疏离到主动连接，最终把温暖传递给整座城市。",
};

/** 内部 ToolCall 协议 → OpenAI wire 格式 */
function toWireMessage(message: LlmChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.tool_call_id || "", content: message.content };
  }
  if (message.tool_calls?.length) {
    return {
      role: "assistant",
      content: message.content || "",
      tool_calls: message.tool_calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

/** OpenAI wire tool_calls → 内部 ToolCall 协议 */
function parseWireToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index): ToolCall[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : {};
    const name = typeof fn.name === "string" ? fn.name : null;
    if (!name) return [];
    let args: Record<string, unknown> = {};
    if (typeof fn.arguments === "string") {
      try {
        const parsed = JSON.parse(fn.arguments) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        console.warn(`[TextService] 工具 ${name} 的 arguments 不是合法 JSON，按空对象处理`);
      }
    } else if (fn.arguments && typeof fn.arguments === "object") {
      args = fn.arguments as Record<string, unknown>;
    }
    return [{ id: typeof record.id === "string" ? record.id : `call-${index}`, name, arguments: args }];
  });
}
