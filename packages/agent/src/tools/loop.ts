import type { AgentContext } from "../agents/base.js";
import type { ToolRegistry } from "./registry.js";
import type { LlmChatMessage, LlmChatResponse, ToolCall, ToolDefinition } from "./types.js";

const JSON_PROTOCOL_SYSTEM = `
## 工具调用协议（强制）
你必须通过工具完成任务，不要直接输出大纲正文。
每一轮只输出一个 JSON 对象，不要输出解释文字、不要使用代码块标记：
- 调用工具：{"tool": "工具名", "arguments": { ... }}
- 任务完成：{"done": true, "summary": "完成说明"}
可用工具会在用户消息中列出。至少调用 write_outline_draft 和 save_outline 各一次，除非用户明确要求不保存。`.trim();

export interface ToolLoopOptions {
  ctx: AgentContext;
  registry: ToolRegistry;
  system: string;
  user: string;
  tools?: ToolDefinition[];
  maxRounds?: number;
  intent?: string;
  /** 每轮工具调用时的回调，可用于实时推送思考过程 */
  onCall?: (call: ToolCall, result: string) => Promise<void> | void;
}

export interface ToolLoopResult {
  finalText: string;
  rounds: number;
  /** 实际执行的工具调用序列，方便调试与前端展示 */
  toolCalls: string[];
  usedNative: boolean;
}

/**
 * Agent 的核心循环：模型输出 tool_calls → 执行工具 → 把结果回填 → 再问模型，
 * 直到模型不再请求工具。这一步就是"模型决定下一步做什么"，而不是代码写死流程。
 *
 * 兼容性：若模型/服务端不支持 function calling（报错或没配置通道），
 * 自动降级为 JSON 协议——同一套工具、同一个循环，只是传输格式不同。
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const { ctx, registry, system, user, maxRounds = 6, intent } = options;
  const tools = options.tools ?? registry.list();
  const messages: LlmChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  let usedNative = typeof ctx.callLlmWithTools === "function";
  let rounds = 0;
  const toolCalls: string[] = [];
  const seenSignatures: string[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    rounds = round;
    let response: LlmChatResponse;

    if (usedNative) {
      try {
        response = await ctx.callLlmWithTools!(messages, tools, { intent });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[ToolLoop] function calling 不可用，降级到 JSON 协议：${message}`);
        usedNative = false;
        response = await askWithJsonProtocol(ctx, system, user, messages, tools, intent);
      }
    } else {
      response = await askWithJsonProtocol(ctx, system, user, messages, tools, intent);
    }

    messages.push({
      role: "assistant",
      content: response.content || "",
      ...(response.toolCalls.length ? { tool_calls: response.toolCalls } : {}),
    });

    if (response.toolCalls.length === 0) {
      return { finalText: response.content, rounds, toolCalls, usedNative };
    }

    // 防死循环：同样的调用连续出现 3 次就结束，把控制权交回节点
    const roundSignature = response.toolCalls.map((call) => `${call.name}:${JSON.stringify(call.arguments)}`).join("|");
    if (seenSignatures.length >= 2 && seenSignatures.slice(-2).every((sig) => sig === roundSignature)) {
      console.warn(`[ToolLoop] 检测到重复调用，提前结束：${roundSignature}`);
      return { finalText: response.content, rounds, toolCalls, usedNative };
    }
    seenSignatures.push(roundSignature);

    for (const call of response.toolCalls) {
      const result = await registry.execute(call);
      toolCalls.push(`${call.name}(${result.content.startsWith("ERROR:") ? "failed" : "ok"})`);
      messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
      if (options.onCall) await options.onCall(call, result.content);
    }
  }

  // 到达上限：让模型基于已有工具结果做一次收尾，不再给工具
  const finalText = usedNative
    ? await ctx.callLlm(
        `${system}\n\n所有可用工具已执行完毕，请直接给出最终中文总结，不要再请求工具。`,
        serializeMessages(messages),
        { intent },
      )
    : await ctx.callLlm(`${system}\n\n请直接给出最终中文总结。`, serializeMessages(messages), { intent });

  return { finalText, rounds, toolCalls, usedNative };
}

/** JSON 降级：把多轮消息摊平进 user prompt，模型仍按同一套工具协议回应 */
async function askWithJsonProtocol(
  ctx: AgentContext,
  system: string,
  user: string,
  messages: LlmChatMessage[],
  tools: ToolDefinition[],
  intent?: string,
): Promise<LlmChatResponse> {
  const toolList = tools
    .map((tool) => `- ${tool.name}: ${tool.description}\n  参数: ${JSON.stringify(tool.inputSchema)}`)
    .join("\n");
  const history = serializeMessages(messages.filter((message) => message.role !== "system"));
  const prompt = `原始任务：\n${user}\n\n可用工具：\n${toolList}\n\n当前对话与工具执行记录：\n${history}\n\n请输出下一步的 JSON 工具调用或完成标记。`;
  const reply = await ctx.callLlm(`${system}\n\n${JSON_PROTOCOL_SYSTEM}`, prompt, { intent });
  return parseJsonProtocol(reply);
}

function parseJsonProtocol(text: string): LlmChatResponse {
  const raw = extractJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { content: text, toolCalls: [] };
  }
  if (!parsed || typeof parsed !== "object") return { content: text, toolCalls: [] };
  const record = parsed as Record<string, unknown>;

  if (Array.isArray(record.tool_calls)) {
    const calls = record.tool_calls
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item, index) => toToolCall(item, index));
    if (calls.length) return { content: "", toolCalls: calls };
  }

  if (typeof record.tool === "string" && record.tool) {
    return { content: "", toolCalls: [toToolCall(record, 0)] };
  }

  if (record.done === true) {
    return { content: typeof record.summary === "string" ? record.summary : "任务完成", toolCalls: [] };
  }

  // 模型没遵守协议时，把原始输出当作最终文本，由节点层兜底解析
  return { content: text, toolCalls: [] };
}

function toToolCall(record: Record<string, unknown>, index: number): ToolCall {
  const name = typeof record.name === "string" ? record.name : String(record.tool ?? "unknown");
  const args =
    record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)
      ? (record.arguments as Record<string, unknown>)
      : {};
  return { id: `json-${Date.now()}-${index}`, name, arguments: args };
}

function serializeMessages(messages: LlmChatMessage[]): string {
  return messages
    .map((message) => {
      if (message.role === "tool") return `[工具结果 ${message.tool_call_id}] ${message.content}`;
      if (message.tool_calls?.length) {
        const calls = message.tool_calls.map((call) => `${call.name}(${JSON.stringify(call.arguments)})`).join(", ");
        return `[模型决定调用] ${calls}`;
      }
      return `[${message.role}] ${message.content}`;
    })
    .join("\n");
}

function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const braces = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  return braces ? braces[1].trim() : text.trim();
}
