import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ToolRegistry } from "../registry.js";
import type { AgentTool } from "../types.js";
import { McpStdioClient } from "./client.js";
import { mcpToolsToAgentTools } from "./adapter.js";

/**
 * 把 MCP 素材库 server 接进工具层。
 *
 * 设计取舍：
 * - **失败即降级**：MCP 是增强能力，拉不起子进程时返回 null，节点照常跑；
 * - **用完即关**：不为每个 job 常驻一个子进程，避免进程泄漏；
 * - **工具清单可枚举**：registry.names() 直接能打印出来，面试可现场演示。
 */

const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"];
const SERVER_RELATIVE_PATHS = [
  "packages/agent/src/tools/mcp/servers/assets-server.mjs",
  "packages/agent/dist/tools/mcp/servers/assets-server.mjs",
];

export interface AssetsToolkitOptions {
  /** 项目根；默认从 cwd 向上找 pnpm-workspace.yaml */
  root?: string;
  /** 显式指定 server 脚本路径 */
  serverScript?: string;
  /** 单次 RPC 超时，默认 6s */
  timeoutMs?: number;
  /** 显式关闭（测试里用，避免每次跑测试都拉起子进程） */
  enabled?: boolean;
}

export interface AssetsToolkit {
  registry: ToolRegistry;
  tools: AgentTool[];
  serverInfo: { name?: string; version?: string };
  /** 关闭子进程；重复调用安全 */
  close: () => Promise<void>;
}

/** 从起始目录向上找项目根（含 pnpm-workspace.yaml 或 .git 的目录） */
export function findProjectRoot(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveServerScript(root: string, explicit?: string): string | null {
  const fromEnv = process.env.MIRAFRAME_MCP_ASSETS_SERVER;
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(root, explicit);
  if (fromEnv) return isAbsolute(fromEnv) ? fromEnv : resolve(root, fromEnv);
  for (const candidate of SERVER_RELATIVE_PATHS) {
    const full = join(root, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

/**
 * 连接 MCP 素材库 server 并把远端工具注册进一个新的 ToolRegistry。
 * 任何一步失败都返回 null（打一条 warn），调用方无需 try/catch。
 */
export async function createAssetsToolKit(options: AssetsToolkitOptions = {}): Promise<AssetsToolkit | null> {
  // enabled: true 可以显式压过环境变量（测试用），enabled: false 永远关闭
  if (options.enabled === false) return null;
  if (options.enabled !== true && process.env.MIRAFRAME_MCP_ASSETS === "0") return null;

  const root = options.root ?? process.env.MIRAFRAME_ROOT ?? findProjectRoot();
  if (!root) {
    console.warn("[mcp:assets] 找不到项目根，跳过 MCP 工具");
    return null;
  }

  const serverScript = resolveServerScript(root, options.serverScript);
  if (!serverScript) {
    console.warn("[mcp:assets] 找不到 assets-server.mjs，跳过 MCP 工具");
    return null;
  }

  const client = new McpStdioClient({
    command: process.execPath,
    args: [serverScript, `--root=${root}`],
    cwd: root,
    timeoutMs: options.timeoutMs ?? 6000,
  });

  try {
    await client.connect();
    const descriptors = await client.listTools();
    const tools = mcpToolsToAgentTools(client, descriptors);

    const registry = new ToolRegistry();
    const registered: AgentTool[] = [];
    for (const tool of tools) {
      try {
        registry.register(tool);
        registered.push(tool);
      } catch (error) {
        console.warn(
          `[mcp:assets] 工具 ${tool.definition.name} 注册失败（可能与本地工具重名）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    let closed = false;
    return {
      registry,
      tools: registered,
      serverInfo: client.info,
      close: async () => {
        if (closed) return;
        closed = true;
        await client.close();
      },
    };
  } catch (error) {
    console.warn(
      `[mcp:assets] MCP 服务不可用，跳过远端工具：${error instanceof Error ? error.message : String(error)}`,
    );
    await client.close();
    return null;
  }
}
