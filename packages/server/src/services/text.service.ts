import { Injectable, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { LlmChatMessage, LlmChatResponse, ToolDefinition, ToolCall } from "@miraframe/agent";

@Injectable()
export class TextService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async generate(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; systemPrompt?: string; intent?: string },
  ): Promise<string> {
    const provider = this.config.get<string>("app.textProvider") || "anthropic";
    const baseUrl =
      this.config.get<string>("app.textBaseUrl") ||
      this.config.get<string>("ANTHROPIC_BASE_URL") ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const apiKey =
      this.config.get<string>("app.textApiKey") ||
      this.config.get<string>("ANTHROPIC_AUTH_TOKEN") ||
      "";
    const model =
      this.config.get<string>("app.textModel") ||
      this.config.get<string>("ANTHROPIC_MODEL") ||
      "qwen3.6-plus";
    const endpoint =
      this.config.get<string>("app.textEndpoint") ||
      this.config.get<string>("TEXT_ENDPOINT") ||
      "/chat/completions";

    console.log(`[TextService] provider=${provider} model=${model}`);
    console.log(`[TextService] url=${baseUrl}${endpoint}`);

    if (provider === "fake") {
      return this.generateFakeResponse(prompt, options?.intent);
    }

    if (!apiKey) {
      console.warn("[TextService] No API key configured — returning placeholder");
      return `[LLM not configured] API key not set. Prompt was: ${prompt.substring(0, 100)}...`;
    }

    const body = {
      model,
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
      temperature: options?.temperature ?? 0.7,
    };

    console.log(`[TextService] → POST ${baseUrl}${endpoint}`);

    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      console.log(`[TextService] ← HTTP ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        console.error(`[TextService] LLM API error ${response.status}: ${errorText}`);
        throw new Error(`LLM API error ${response.status}: ${errorText.substring(0, 200)}`);
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
      if (error instanceof Error && error.message.startsWith("LLM API error")) {
        throw error;
      }
      console.error(`[TextService] Network/fetch error:`, error);
      throw new Error(`LLM call failed: ${String(error)}`);
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
    const provider = this.config.get<string>("app.textProvider") || "anthropic";
    if (provider === "fake") return this.fakeToolLoop(messages, tools);

    const baseUrl =
      this.config.get<string>("app.textBaseUrl") ||
      this.config.get<string>("ANTHROPIC_BASE_URL") ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const apiKey =
      this.config.get<string>("app.textApiKey") ||
      this.config.get<string>("ANTHROPIC_AUTH_TOKEN") ||
      "";
    const model =
      this.config.get<string>("app.textModel") ||
      this.config.get<string>("ANTHROPIC_MODEL") ||
      "qwen3.6-plus";
    const endpoint =
      this.config.get<string>("app.textEndpoint") ||
      this.config.get<string>("TEXT_ENDPOINT") ||
      "/chat/completions";

    if (!apiKey) {
      throw new Error("TOOLS_UNSUPPORTED: API key not configured");
    }

    const body = {
      model,
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
      temperature: options?.temperature ?? 0.7,
    };

    console.log(`[TextService] tools → POST ${baseUrl}${endpoint} | tools=${tools.map((t) => t.name).join(",")}`);

    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.error(`[TextService] tool-calls error ${response.status}: ${errorText}`);
      // 上游不支持 tools 时抛特定错误，ToolLoop 会降级到 JSON 协议重试
      throw new Error(`TOOLS_UNSUPPORTED: LLM API error ${response.status}: ${errorText.substring(0, 200)}`);
    }

    const json = (await response.json()) as Record<string, unknown>;
    const choices = json.choices as Array<{ message?: Record<string, unknown> }> | undefined;
    const message = choices?.[0]?.message || {};
    const content = typeof message.content === "string" ? message.content : "";
    const toolCalls = parseWireToolCalls(message.tool_calls);
    console.log(`[TextService] tools ← content=${content.length} chars, toolCalls=${toolCalls.length}`);
    return { content, toolCalls };
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
