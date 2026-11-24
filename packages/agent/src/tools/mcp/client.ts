import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * 最小 MCP（Model Context Protocol）客户端：JSON-RPC 2.0 over stdio。
 *
 * 为什么自己写而不用 @langchain/mcp-adapters：
 * 1. 项目已有工具层与 ToolRegistry，只需要「远端工具 → AgentTool」这一层薄适配；
 * 2. MCP 的 stdio 传输本身就是「每行一个 JSON-RPC 消息」，协议面很小；
 * 3. 少一个重依赖，冷启动与调试成本都低。
 *
 * 协议要点（已按规范实现）：
 * - 消息按换行分隔，stdout 只走协议，日志必须打 stderr；
 * - 握手：initialize（带 protocolVersion）→ 收到 result → 发 notifications/initialized；
 * - 工具：tools/list 拿清单，tools/call 执行，结果在 result.content[] 里。
 */

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

export interface McpClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 单次请求超时，默认 8s */
  timeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** 客户端握手的协议版本；server 可以回一个它支持的版本，这里不做协商 */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly stderrTail: string[] = [];
  private closed = false;
  private toolsCache: McpToolDescriptor[] | null = null;
  private serverInfo: { name?: string; version?: string } = {};

  constructor(private readonly options: McpClientOptions) {}

  get isClosed(): boolean {
    return this.closed;
  }

  get info(): { name?: string; version?: string } {
    return this.serverInfo;
  }

  /** 启动子进程并完成握手；失败时抛错，调用方自行决定降级 */
  async connect(): Promise<void> {
    if (this.child) throw new Error("MCP 客户端已连接，不要重复 connect");

    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // 保留最后若干行用于诊断，不直接打日志（避免刷屏）
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        this.stderrTail.push(line.trim().slice(0, 300));
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      }
    });

    child.on("error", (error) => {
      this.failAll(new Error(`MCP 服务进程启动失败：${error.message}`));
      this.closed = true;
    });

    child.on("exit", (code, signal) => {
      this.closed = true;
      const detail = this.stderrTail.slice(-3).join(" | ");
      this.failAll(
        new Error(`MCP 服务进程退出（code=${code ?? "null"} signal=${signal ?? "null"}）${detail ? `：${detail}` : ""}`),
      );
    });

    const result = (await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "miraframe-agent", version: "0.1.0" },
    })) as { serverInfo?: { name?: string; version?: string } } | undefined;

    this.serverInfo = result?.serverInfo ?? {};
    // 握手最后一步是通知，不需要等回复；不发这一步部分 server 会拒绝后续请求
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    if (this.toolsCache) return this.toolsCache;
    const result = (await this.request("tools/list", {})) as { tools?: unknown } | undefined;
    const raw = Array.isArray(result?.tools) ? result!.tools : [];
    const tools: McpToolDescriptor[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (typeof record.name !== "string" || !record.name) continue;
      tools.push({
        name: record.name,
        description: typeof record.description === "string" ? record.description : "",
        inputSchema: record.inputSchema,
      });
    }
    this.toolsCache = tools;
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = (await this.request("tools/call", { name, arguments: args })) as
      | { content?: unknown; isError?: unknown }
      | undefined;

    const isError = result?.isError === true;
    const parts: string[] = [];
    if (Array.isArray(result?.content)) {
      for (const item of result!.content as unknown[]) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        if (record.type === "text" && typeof record.text === "string") {
          parts.push(record.text);
        } else if (record.type === "image") {
          // 二进制内容不下发给模型，只说明存在
          parts.push(`[图片内容 ${String(record.mimeType ?? "unknown")}]`);
        } else if (record.type === "resource") {
          parts.push(`[资源 ${JSON.stringify(record.resource ?? {})}]`);
        }
      }
    }

    const text = parts.join("\n").trim();
    return { text: text || (isError ? "工具执行失败（服务端未返回详情）" : "(工具执行成功，无返回内容)"), isError };
  }

  /** 关闭子进程；重复调用安全 */
  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) {
      this.closed = true;
      return;
    }
    this.failAll(new Error("MCP 客户端已关闭"));
    this.closed = true;
    if (child.exitCode == null && !child.killed) {
      // 先礼后兵：stdin 结束触发 server 自然退出，超时再 SIGKILL
      try {
        child.stdin.end();
      } catch {
        /* 进程可能已退出 */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          resolve();
        }, 1000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`MCP 连接已关闭，无法发送 ${method}`));
    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs ?? 8000;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时（${method}, ${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private send(message: JsonRpcMessage): void {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error("MCP 管道不可写，服务进程可能已退出");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // stdout 出现非协议内容说明 server 没遵守规范，记下来便于排查
      this.stderrTail.push(`[stdout 非协议内容] ${line.slice(0, 200)}`);
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return; // 超时后迟到的响应，直接丢弃
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`MCP 错误（${pending.method}）：${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // 服务端主动发起的请求（如 sampling）暂不支持，回一个明确的方法不存在
    if (typeof message.method === "string" && message.id != null) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `客户端不支持服务端方法 ${message.method}` },
      });
    }
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
