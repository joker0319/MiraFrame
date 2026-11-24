import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAssetsToolKit, findProjectRoot, type AssetsToolkit } from "../tools/mcp/assets-toolkit.js";
import { mcpToolsToAgentTools } from "../tools/mcp/adapter.js";
import { McpStdioClient } from "../tools/mcp/client.js";

/**
 * 工具层的「远端可插拔」验证：MCP 工具注册进 ToolRegistry 后，
 * 调用方式与本地工具完全一致 —— 这是节点代码不需要知道工具在哪的前提。
 */

const root = findProjectRoot() ?? process.cwd();
const serverScript = join(root, "packages/agent/src/tools/mcp/servers/assets-server.mjs");

describe("findProjectRoot", () => {
  it("从包目录向上能找到含 pnpm-workspace.yaml 的项目根", () => {
    const found = findProjectRoot(join(root, "packages", "agent"));
    expect(found).toBe(root);
  });

  it("找不到标记时返回 null 而不是抛错", () => {
    expect(findProjectRoot("/tmp")).toBeNull();
  });
});

describe("createAssetsToolKit", () => {
  let kit: AssetsToolkit;

  beforeAll(async () => {
    // 这个文件专测「自实现 stdio 客户端」这条连接层；官方 SDK 那条在 mcp-sdk.test.ts
    const created = await createAssetsToolKit({ enabled: true, root, transport: "builtin" });
    if (!created) throw new Error("MCP toolkit 连接失败");
    kit = created;
  }, 20000);

  afterAll(async () => {
    await kit?.close();
  });

  it("工具清单可枚举，且带完整参数描述", () => {
    expect(kit.transport).toBe("builtin");
    expect(kit.registry.names().sort()).toEqual(["list_project_assets", "read_text_asset"]);
    const definitions = kit.registry.list();
    const listTool = definitions.find((item) => item.name === "list_project_assets")!;
    expect(listTool.description).toContain("项目");
    expect(listTool.inputSchema.properties).toHaveProperty("path");
  });

  it("通过 ToolRegistry 调远端工具，与本地工具用法一致", async () => {
    const result = await kit.registry.execute({
      id: "call-1",
      name: "list_project_assets",
      arguments: { path: "packages/frontend/public/style-covers", max_entries: 3 },
    });
    expect(result.toolCallId).toBe("call-1");
    expect(result.content).toContain("shot-");
    expect(result.content.startsWith("ERROR:")).toBe(false);
  });

  it("远端工具返回的失败以 ERROR: 前缀回填，沿用本地工具的约定", async () => {
    const result = await kit.registry.execute({
      id: "call-2",
      name: "read_text_asset",
      arguments: { path: "../../etc/hosts" },
    });
    expect(result.content.startsWith("ERROR:")).toBe(true);
  });

  it("未知工具由本地 registry 直接拦截，不会发到远端", async () => {
    const result = await kit.registry.execute({ id: "call-3", name: "not_registered", arguments: {} });
    expect(result.content).toContain("未知工具");
    expect(result.content).toContain("list_project_assets");
  });

  it("close 幂等", async () => {
    const kit2 = await createAssetsToolKit({ enabled: true, root, transport: "builtin" });
    expect(kit2).not.toBeNull();
    await kit2!.close();
    await expect(kit2!.close()).resolves.toBeUndefined();
  });
});

describe("createAssetsToolKit 的降级路径", () => {
  it("enabled: false 时直接返回 null，不拉起子进程", async () => {
    await expect(createAssetsToolKit({ enabled: false, root })).resolves.toBeNull();
  });

  it("环境变量 MIRAFRAME_MCP_ASSETS=0 时默认关闭（测试环境即此状态）", async () => {
    expect(process.env.MIRAFRAME_MCP_ASSETS).toBe("0");
    await expect(createAssetsToolKit({ root })).resolves.toBeNull();
  });

  it("server 脚本缺失时降级为 null 而不是抛错", async () => {
    const kit = await createAssetsToolKit({
      enabled: true,
      root,
      serverScript: join(root, "packages/agent/src/tools/mcp/servers/nope.mjs"),
      timeoutMs: 2000,
      transport: "builtin",
    });
    expect(kit).toBeNull();
  });
});

describe("mcpToolsToAgentTools", () => {
  it("把远端描述符转成 AgentTool，未声明参数时补空 schema", async () => {
    const client = new McpStdioClient({
      command: process.execPath,
      args: [serverScript, `--root=${root}`],
      cwd: root,
    });
    await client.connect();
    try {
      const [tool] = mcpToolsToAgentTools(client, [{ name: "bare_tool" }]);
      expect(tool.definition.name).toBe("bare_tool");
      expect(tool.definition.inputSchema).toMatchObject({ type: "object", properties: {} });
      // 远端不存在的工具：adapter 把协议错误转成 ERROR 文本，而不是抛给节点
      await expect(tool.execute({})).resolves.toMatch(/^ERROR:/);
    } finally {
      await client.close();
    }
  });
});
