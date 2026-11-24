/**
 * 把 MCP server 脚本复制进 dist。
 *
 * tsup 是 bundle 模式（所有 TS 打成 index.js），.mjs 子进程脚本不会被打进去；
 * 但生产镜像是「只拷 dist」的，缺了它 dist 形态下 MCP 就永远降级。
 * 这个脚本让 `node dist` 与 `tsx src` 两种运行方式行为一致。
 */
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "src", "tools", "mcp", "servers");
const to = join(here, "..", "dist", "tools", "mcp", "servers");

await mkdir(dirname(to), { recursive: true });
await cp(from, to, { recursive: true });
console.log(`[build] MCP server 脚本已复制 -> ${to}`);
