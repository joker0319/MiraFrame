#!/usr/bin/env node
/**
 * MiraFrame 素材库 MCP server（stdio 传输，零依赖）。
 *
 * 用途：让 Agent 在生成前能查项目里真实存在的东西 —— 风格参考图、历史导出产物、
 * 风格文档。这是 MCP 协议的**服务端**实现，配合 tools/mcp/client.ts 端到端跑通。
 *
 * 协议要点：
 * - stdin 每行一个 JSON-RPC 2.0 消息，stdout 只写协议响应；
 * - 所有日志走 stderr（stdout 混入非协议内容会污染客户端解析）；
 * - 实现 initialize / tools/list / tools/call / ping 与 initialized 通知。
 *
 * 安全：只暴露项目根内的路径，拒绝 node_modules / .git / dist 与 .env、密钥类文件，
 * 并对 resolve 后的路径做越界校验，防止 ../ 穿越。
 */
import { createInterface } from "node:readline";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const PROTOCOL_VERSION = "2024-11-05";
const MAX_READ_BYTES = 64 * 1024;
const DEFAULT_READ_BYTES = 16 * 1024;
const MAX_LIST_ENTRIES = 200;
const DEFAULT_LIST_ENTRIES = 60;

const DENY_DIRS = new Set(["node_modules", ".git", "dist", ".turbo", "backups"]);
const DENY_FILE_PATTERNS = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_rsa/i, /\.p12$/i];

const log = (...args) => process.stderr.write(`[mcp:assets] ${args.join(" ")}\n`);

function resolveRoot() {
  const fromArg = process.argv.find((arg) => arg.startsWith("--root="));
  const raw = fromArg ? fromArg.slice("--root=".length) : process.env.MIRAFRAME_ROOT || process.cwd();
  return resolve(raw);
}

const ROOT = resolveRoot();

const TOOLS = [
  {
    name: "list_project_assets",
    description:
      "列出漫剧项目内的文件或子目录（相对项目根）。用于在生成前查看可用的风格参考图、历史导出产物与文档。会自动跳过 node_modules、.git、dist 等目录，并拒绝 .env 与密钥文件。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "相对项目根的子目录，例如 packages/frontend/public/style-covers；省略则列项目根",
        },
        max_entries: {
          type: "number",
          description: `最多返回条数，默认 ${DEFAULT_LIST_ENTRIES}，上限 ${MAX_LIST_ENTRIES}`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_text_asset",
    description:
      "读取项目内一个文本文件的内容（默认 16KB，上限 64KB）。用于查阅风格指南、README、分镜规范等文档。二进制文件只返回元数据。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对项目根的文件路径" },
        max_bytes: {
          type: "number",
          description: `最多读取字节数，默认 ${DEFAULT_READ_BYTES}，上限 ${MAX_READ_BYTES}`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

function clampNumber(value, fallback, max) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function isDeniedFile(name) {
  return DENY_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

/** 解析并校验路径：必须在项目根内，且不在受限目录/文件里 */
function resolveSafe(inputPath) {
  const raw = typeof inputPath === "string" && inputPath.trim() ? inputPath.trim() : ".";
  const target = resolve(ROOT, raw);
  const rel = relative(ROOT, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(target) === resolve(ROOT, "..")) {
    throw new Error(`路径越界，只允许访问项目根内的路径：${raw}`);
  }

  const segments = rel ? rel.split(sep) : [];
  const blockedDir = segments.find((segment) => DENY_DIRS.has(segment));
  if (blockedDir) throw new Error(`受限目录不允许访问：${blockedDir}`);

  const fileName = segments[segments.length - 1] ?? "";
  if (fileName && isDeniedFile(fileName)) throw new Error(`受限文件不允许访问：${fileName}`);

  return { target, rel: rel || "." };
}

async function listProjectAssets(args) {
  const { target, rel } = resolveSafe(args.path);
  const info = await stat(target);
  if (info.isFile()) {
    return `路径是文件：${rel}（${formatSize(info.size)}）`;
  }
  if (!info.isDirectory()) {
    throw new Error(`既不是文件也不是目录：${rel}`);
  }

  const limit = clampNumber(args.max_entries, DEFAULT_LIST_ENTRIES, MAX_LIST_ENTRIES);
  const entries = await readdir(target, { withFileTypes: true });
  const visible = entries
    .filter((entry) => !(entry.isDirectory() && DENY_DIRS.has(entry.name)) && !isDeniedFile(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

  const lines = [];
  for (const entry of visible) {
    if (lines.length >= limit) {
      lines.push(`...（已截断，仅显示前 ${limit} 项，共 ${visible.length} 项）`);
      break;
    }
    if (entry.isDirectory()) {
      lines.push(`[dir]  ${entry.name}/`);
    } else if (entry.isFile()) {
      const fileStat = await stat(join(target, entry.name));
      lines.push(`[file] ${entry.name}  ${formatSize(fileStat.size)}`);
    }
  }

  if (lines.length === 0) return `目录 ${rel} 为空（或内容全部被安全策略过滤）`;
  return `目录 ${rel}，共 ${visible.length} 项：\n${lines.join("\n")}`;
}

async function readTextAsset(args) {
  if (typeof args.path !== "string" || !args.path.trim()) {
    throw new Error("path 不能为空");
  }
  const { target, rel } = resolveSafe(args.path);
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`不是文件：${rel}`);

  const limit = clampNumber(args.max_bytes, DEFAULT_READ_BYTES, MAX_READ_BYTES);
  const buffer = await readFile(target);
  const slice = buffer.subarray(0, Math.min(limit, buffer.length));

  if (slice.includes(0)) {
    return `二进制文件 ${rel}（${formatSize(info.size)}），不返回内容。如需查看请用 list_project_assets 确认元数据。`;
  }

  const text = slice.toString("utf8");
  const truncated = buffer.length > slice.length;
  const header = `文件 ${rel}（${formatSize(info.size)}${truncated ? `，已截断到前 ${limit} 字节` : ""}）：\n`;
  return header + text;
}

const HANDLERS = {
  list_project_assets: listProjectAssets,
  read_text_asset: readTextAsset,
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleToolCall(params) {
  const name = params && typeof params.name === "string" ? params.name : "";
  const args =
    params && params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments
      : {};

  const handler = HANDLERS[name];
  if (!handler) {
    return {
      content: [{ type: "text", text: `ERROR: 未知工具 "${name}"。可用：${Object.keys(HANDLERS).join(", ")}` }],
      isError: true,
    };
  }

  try {
    const text = await handler(args);
    return { content: [{ type: "text", text }], isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;

  // 通知（无 id）不需要回复
  if (id === undefined || id === null) {
    if (method === "notifications/initialized") log("client initialized");
    return;
  }

  switch (method) {
    case "initialize":
      log(`initialize from ${params?.clientInfo?.name ?? "unknown"} (root=${ROOT})`);
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "miraframe-assets", version: "0.1.0" },
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call":
      return reply(id, await handleToolCall(params));
    default:
      return replyError(id, -32601, `未知方法：${method}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    log(`无法解析的消息：${trimmed.slice(0, 120)}`);
    return;
  }
  handleMessage(message).catch((error) => {
    log(`处理消息失败：${error instanceof Error ? error.message : String(error)}`);
  });
});

rl.on("close", () => {
  log("stdin closed, exiting");
  process.exit(0);
});

log(`started, root=${ROOT}`);
