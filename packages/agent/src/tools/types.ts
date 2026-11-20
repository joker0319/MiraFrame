/**
 * 工具层协议定义。
 *
 * 刻意只依赖 JSON Schema，不依赖 zod —— 这样工具描述既能直接送给
 * OpenAI-compatible 的 function calling 接口，也能在 fake / 无 SDK 环境下
 * 走 JSON 降级协议，测试不需要真实模型。
 */

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** 送给模型的工具描述（OpenAI function calling 兼容格式） */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

/** 模型决定要调用的一次工具调用 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 一次工具调用的执行结果，回填给模型 */
export interface ToolResult {
  toolCallId: string;
  content: string;
}

/** 工具循环中的消息；tool_calls / tool_call_id 只在对应角色上出现 */
export interface LlmChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** 带工具能力的模型返回 */
export interface LlmChatResponse {
  content: string;
  toolCalls: ToolCall[];
}

/** 一个可执行工具 = 描述 + 执行体 */
export interface AgentTool {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<string>;
}
