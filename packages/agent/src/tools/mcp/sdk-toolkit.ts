import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { ToolRegistry } from "../registry.js";
import type { AgentTool } from "../types.js";
import { langChainMcpToolToAgentTool, registerAgentTools } from "./adapter.js";
import type { AssetsToolkit, AssetsToolkitTuning } from "./assets-toolkit.js";

/**
 * 官方 SDK 连接层：`@langchain/mcp-adapters` 的 `MultiServerMCPClient`。
 *
 * 这一层只做「连上 → 拿工具 → 关掉」，不碰工具语义 —— 转换交给 `adapter.ts`
 * 的 `langChainMcpToolToAgentTool()`。所以换掉连接方式（自实现 stdio ↔ 官方 SDK）
 * 对节点代码完全透明，这也是当初把「连接」和「转换」拆开的价值。
 */

export const SDK_SERVER_NAME = "assets";

export async function createSdkAssetsToolkit(
  serverScript: string,
  tuning: AssetsToolkitTuning,
): Promise<AssetsToolkit> {
  const { root } = tuning;

  const client = new MultiServerMCPClient({
    mcpServers: {
      [SDK_SERVER_NAME]: {
        command: process.execPath,
        args: [serverScript, `--root=${root}`],
        cwd: root,
      },
    },
  });

  try {
    const langChainTools = await client.getTools(SDK_SERVER_NAME);
    const tools = langChainTools.map(langChainMcpToolToAgentTool);

    const registry = new ToolRegistry();
    const registered = registerAgentTools(registry, tools);

    const connection = await client.getClient(SDK_SERVER_NAME);
    const info = connection?.getServerVersion?.() as { name?: string; version?: string } | undefined;

    let closed = false;
    return {
      registry,
      tools: registered,
      serverInfo: { ...(info?.name ? { name: info.name } : {}), ...(info?.version ? { version: info.version } : {}) },
      transport: "sdk",
      close: async () => {
        if (closed) return;
        closed = true;
        await client.close();
      },
    };
  } catch (error) {
    // 连不上就把子进程收掉，避免半开的连接泄漏
    await client.close().catch(() => undefined);
    throw error;
  }
}
