import { fromLangChainTool, type LangChainToolLike } from "../langchain-bridge.js";
import { ToolRegistry } from "../registry.js";
import type { AgentTool, ToolInputSchema } from "../types.js";
import type { McpStdioClient, McpToolDescriptor } from "./client.js";

/**
 * MCP 远端工具 → 项目内 AgentTool。
 *
 * 适配只做三件事：字段改名、schema 兜底、错误文本统一成 `ERROR:` 前缀
 * —— 这样 ToolRegistry / ToolLoop 对本地工具和远端工具一视同仁，
 * 节点代码完全感知不到工具体在哪。
 */

function normalizeSchema(schema: unknown): ToolInputSchema {
  if (schema && typeof schema === "object") {
    const record = schema as Record<string, unknown>;
    if (record.type === "object" && record.properties && typeof record.properties === "object") {
      return record as unknown as ToolInputSchema;
    }
  }
  // 未声明参数的工具有两种可能：真的无参，或 server 偷懒。给空 object schema，调用方传 {} 即可。
  return { type: "object", properties: {}, additionalProperties: true };
}

export function mcpToolToAgentTool(client: McpStdioClient, descriptor: McpToolDescriptor): AgentTool {
  return {
    definition: {
      name: descriptor.name,
      description: descriptor.description ?? `MCP 工具 ${descriptor.name}`,
      inputSchema: normalizeSchema(descriptor.inputSchema),
    },
    execute: async (args) => {
      try {
        const result = await client.callTool(descriptor.name, args ?? {});
        // 工具级错误（isError）不是协议错误，用 ERROR: 前缀回填给模型，让它自己换参数重试
        return result.isError ? `ERROR: ${result.text}` : result.text;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `ERROR: MCP 工具 ${descriptor.name} 调用失败：${message}`;
      }
    },
  };
}

export function mcpToolsToAgentTools(client: McpStdioClient, descriptors: McpToolDescriptor[]): AgentTool[] {
  return descriptors.map((descriptor) => mcpToolToAgentTool(client, descriptor));
}

/**
 * 把 MCP 的失败统一成 `ERROR:` 前缀文本。
 *
 * 为什么必须做这一层：MCP 规范里工具的 `isError: true` 是**工具级错误**
 * （参数不对、路径越界），模型看到它才能自我修正；但官方 SDK 会把它包成
 * 一个抛出的异常（`MCP tool 'x' on server 'y' returned an error: ...`）。
 * 如果任由异常冒泡，ToolLoop 就会中断而不是回填给模型 —— 工具错误变成了
 * 传输错误，Agent 的自我修正能力随之消失。所以适配层要把语义还原回去。
 */
export function toMcpErrorText(toolName: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // 剥掉 SDK 的包装前缀，让模型看到 server 原本的文案
  const marker = "returned an error: ";
  const at = raw.indexOf(marker);
  const inner = (at >= 0 ? raw.slice(at + marker.length) : raw).trim();
  return inner.startsWith("ERROR:") ? inner : `ERROR: MCP 工具 ${toolName} 调用失败：${inner}`;
}

/**
 * 官方 SDK（`@langchain/mcp-adapters`）返回的 `DynamicStructuredTool` → AgentTool。
 * 转换仍走 `fromLangChainTool`，只是把失败包成文本，保持「工具不抛异常」的约定。
 */
export function langChainMcpToolToAgentTool(tool: LangChainToolLike): AgentTool {
  const base = fromLangChainTool(tool);
  return {
    definition: base.definition,
    execute: async (args) => {
      try {
        return await base.execute(args);
      } catch (error) {
        return toMcpErrorText(base.definition.name, error);
      }
    },
  };
}

/**
 * 把一批远端工具注册进 registry。重名时跳过并告警（而不是整体失败），
 * 这样一个 server 里的某个工具名冲突不会连带废掉其余工具。
 */
export function registerAgentTools(registry: ToolRegistry, tools: AgentTool[]): AgentTool[] {
  const registered: AgentTool[] = [];
  for (const tool of tools) {
    try {
      registry.register(tool);
      registered.push(tool);
    } catch (error) {
      console.warn(
        `[mcp] 工具 ${tool.definition.name} 注册失败（可能与本地工具重名）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return registered;
}
