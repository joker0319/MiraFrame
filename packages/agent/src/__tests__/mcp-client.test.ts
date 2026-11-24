import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpStdioClient } from "../tools/mcp/client.js";
import { findProjectRoot } from "../tools/mcp/assets-toolkit.js";

/**
 * MCP 客户端的集成测试：真的 spawn 一个 server 子进程，走完整的
 * initialize → tools/list → tools/call 往返。
 *
 * 这里不 mock 传输层 —— 换行分帧、JSON-RPC 配对、超时与关闭语义
 * 只有在真进程上跑才验证得出来。
 */

const root = findProjectRoot() ?? process.cwd();
const serverScript = join(root, "packages/agent/src/tools/mcp/servers/assets-server.mjs");

function createClient(timeoutMs = 8000) {
  return new McpStdioClient({
    command: process.execPath,
    args: [serverScript, `--root=${root}`],
    cwd: root,
    timeoutMs,
  });
}

describe("McpStdioClient", () => {
  let client: McpStdioClient;

  beforeAll(async () => {
    expect(existsSync(serverScript), `server 脚本不存在：${serverScript}`).toBe(true);
    client = createClient();
    await client.connect();
  }, 20000);

  afterAll(async () => {
    await client?.close();
  });

  it("握手成功后能拿到 serverInfo", () => {
    expect(client.isClosed).toBe(false);
    expect(client.info.name).toBe("miraframe-assets");
    expect(client.info.version).toBe("0.1.0");
  });

  it("tools/list 枚举出可用的远端工具", async () => {
    const tools = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["list_project_assets", "read_text_asset"]));
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("tools/list 结果会被缓存，不会重复发请求", async () => {
    const first = await client.listTools();
    const second = await client.listTools();
    expect(second).toBe(first);
  });

  it("调用 list_project_assets 能读到真实目录内容", async () => {
    const result = await client.callTool("list_project_assets", {
      path: "packages/frontend/public/style-covers",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("shot-1.png");
    expect(result.text).toContain("[file]");
  });

  it("调用 read_text_asset 能读到真实文件内容并截断", async () => {
    const result = await client.callTool("read_text_asset", { path: "README.md", max_bytes: 120 });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("README.md");
    expect(result.text.length).toBeLessThan(600);
  });

  it("路径穿越被服务端拒绝，且以工具级错误返回而不是协议错误", async () => {
    const result = await client.callTool("read_text_asset", { path: "../../../etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("越界");
  });

  it("受限目录不可访问", async () => {
    const result = await client.callTool("read_text_asset", { path: "node_modules/typescript/package.json" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("受限目录");
  });

  it("未知工具返回可读错误而不是抛异常", async () => {
    const result = await client.callTool("no_such_tool", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("未知工具");
  });
});

describe("McpStdioClient 生命周期", () => {
  it("close 之后拒绝新请求并标记为已关闭", async () => {
    const client = createClient();
    await client.connect();
    await client.close();
    expect(client.isClosed).toBe(true);
    await expect(client.callTool("list_project_assets", {})).rejects.toThrow(/已关闭/);
  });

  it("server 脚本不存在时报错而不是挂死", async () => {
    const client = new McpStdioClient({
      command: process.execPath,
      args: [join(root, "packages/agent/src/tools/mcp/servers/does-not-exist.mjs")],
      cwd: root,
      timeoutMs: 3000,
    });
    await expect(client.connect()).rejects.toThrow(/退出|启动失败/);
    await client.close();
  });
});
