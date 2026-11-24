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
