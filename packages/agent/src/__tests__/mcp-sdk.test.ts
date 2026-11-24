import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAssetsToolKit, findProjectRoot, type AssetsToolkit } from "../tools/mcp/assets-toolkit.js";
import { toMcpErrorText } from "../tools/mcp/adapter.js";

/**
 * 官方 SDK 连接层（`@langchain/mcp-adapters`）的验收。
 *
 * 重点不是「能不能连上」，而是两条连接层**契约一致**：
 * 工具名、参数 schema、调用方式、失败文本形状、close 语义都一样，
 * 所以节点代码和 ToolLoop 换层时无需任何改动。
 */

const root = findProjectRoot() ?? process.cwd();
const serverScript = join(root, "packages/agent/src/tools/mcp/servers/assets-server.mjs");

describe("createAssetsToolKit（官方 SDK 连接层）", () => {
  let kit: AssetsToolkit;

  beforeAll(async () => {
    const created = await createAssetsToolKit({ enabled: true, root, transport: "sdk" });
    if (!created) throw new Error("SDK 连接失败");
    kit = created;
  }, 20000);

  afterAll(async () => {
    await kit?.close();
  });

  it("默认走 SDK，且工具清单与自实现路径完全一致", () => {
    expect(kit.transport).toBe("sdk");
    expect(kit.registry.names().sort()).toEqual(["list_project_assets", "read_text_asset"]);
  });

  it("SDK 的 DynamicStructuredTool 暴露纯 JSON Schema，可直接转成 AgentTool", () => {
    const listTool = kit.registry.list().find((item) => item.name === "list_project_assets")!;
    expect(listTool.inputSchema.type).toBe("object");
    expect(listTool.inputSchema.properties).toHaveProperty("path");
    expect(listTool.description.length).toBeGreaterThan(10);
  });

  it("serverInfo 来自 initialize 握手，可用来确认真的连上了", () => {
    expect(kit.serverInfo).toEqual({ name: "miraframe-assets", version: "0.1.0" });
  });

  it("通过 ToolRegistry 调用远端工具，与本地工具用法一致", async () => {
    const result = await kit.registry.execute({
      id: "sdk-1",
      name: "list_project_assets",
      arguments: { path: "docs", max_entries: 2 },
    });
    expect(result.content.startsWith("ERROR:")).toBe(false);
    expect(result.content).toContain("目录 docs");
  });

  it("工具级错误被还原成单层 ERROR: 文本，而不是抛异常", async () => {
    // SDK 会把 isError 包成 "MCP tool 'x' on server 'y' returned an error: ..."，
    // 适配层必须剥掉这层，否则模型看到的是传输错误而非参数错误
    const result = await kit.registry.execute({
      id: "sdk-2",
      name: "read_text_asset",
      arguments: { path: "../../etc/hosts" },
    });
    expect(result.content.startsWith("ERROR:")).toBe(true);
    expect(result.content).toContain("路径越界");
    expect(result.content).not.toContain("returned an error");
  });

  it("close 幂等", async () => {
    const kit2 = await createAssetsToolKit({ enabled: true, root, transport: "sdk" });
    expect(kit2?.transport).toBe("sdk");
    await kit2!.close();
    await expect(kit2!.close()).resolves.toBeUndefined();
  }, 20000);
});

describe("连接层可切换", () => {
  it("transport: builtin 走自实现客户端", async () => {
    const kit = await createAssetsToolKit({ enabled: true, root, transport: "builtin" });
    expect(kit?.transport).toBe("builtin");
    await kit?.close();
  }, 20000);

  it("auto（默认）优先 SDK", async () => {
    const kit = await createAssetsToolKit({ enabled: true, root, transport: "auto" });
    expect(kit?.transport).toBe("sdk");
    await kit?.close();
  }, 20000);

  it("sdk 模式下 server 脚本缺失时降级为 null 而不是抛错", async () => {
    const kit = await createAssetsToolKit({
      enabled: true,
      root,
      transport: "sdk",
      serverScript: join(root, "packages/agent/src/tools/mcp/servers/nope.mjs"),
    });
    expect(kit).toBeNull();
  }, 20000);

  it("auto 模式下 SDK 失败会回落到 builtin，最终仍返回 null（脚本不存在时两条路都不可用）", async () => {
    const kit = await createAssetsToolKit({
      enabled: true,
      root,
      transport: "auto",
      serverScript: join(root, "packages/agent/src/tools/mcp/servers/nope.mjs"),
      timeoutMs: 2000,
    });
    expect(kit).toBeNull();
  }, 20000);
});

describe("toMcpErrorText", () => {
  it("剥掉 SDK 的包装，保留 server 原本的 ERROR: 文案", () => {
    const error = new Error(
      "MCP tool 'read_text_asset' on server 'assets' returned an error: ERROR: 路径越界，只允许访问项目根内的路径",
    );
    expect(toMcpErrorText("read_text_asset", error)).toBe("ERROR: 路径越界，只允许访问项目根内的路径");
  });

  it("SDK 包装里没有 ERROR: 前缀时，补上工具名再回填", () => {
    const error = new Error("MCP tool 'x' on server 'assets' returned an error: boom");
    expect(toMcpErrorText("x", error)).toBe("ERROR: MCP 工具 x 调用失败：boom");
  });

  it("传输级错误（连不上、超时）保留工具名，便于定位", () => {
    expect(toMcpErrorText("list_project_assets", new Error("spawn ENOENT"))).toBe(
      "ERROR: MCP 工具 list_project_assets 调用失败：spawn ENOENT",
    );
  });

  it("非 Error 抛出物也能转文本", () => {
    expect(toMcpErrorText("x", "plain string")).toBe("ERROR: MCP 工具 x 调用失败：plain string");
  });
});
