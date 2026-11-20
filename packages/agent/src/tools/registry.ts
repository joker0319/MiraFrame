import type { AgentTool, ToolCall, ToolDefinition, ToolResult } from "./types.js";

/**
 * Tool Registry：工具的唯一注册处。
 *
 * 设计要点：
 * 1. 工具执行失败不抛给图，而是把错误文本回填给模型 —— 让它有机会自我修正，
 *    这正是"Agent"区别于"工作流"的地方之一。
 * 2. list() 直接产出 OpenAI-compatible 的工具描述，将来接 MCP 只需要再实现
 *    一个把远端工具转成 AgentTool 的适配器，节点代码不用动。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): this {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Tool already registered: ${tool.definition.name}`);
    }
    this.tools.set(tool.definition.name, tool);
    return this;
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values(), (tool) => tool.definition);
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        toolCallId: call.id,
        content: `ERROR: 未知工具 "${call.name}"。可用工具：${this.names().join(", ")}`,
      };
    }

    try {
      const content = await tool.execute(call.arguments || {});
      return { toolCallId: call.id, content: content || "(工具执行成功，无返回内容)" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { toolCallId: call.id, content: `ERROR: 工具 "${call.name}" 执行失败：${message}` };
    }
  }
}
