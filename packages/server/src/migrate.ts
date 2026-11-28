/**
 * 独立的迁移入口。
 *
 * 容器启动时先跑一次 `drizzle` 迁移再拉起 Nest，避免「镜像起来了但表不存在」。
 * 本地开发仍然用 `pnpm db:migrate`，这个入口只是给部署用的最小执行器。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

function resolveMigrationsFolder(): string {
  // 开发：cwd = packages/server；容器：cwd = /app，迁移在 packages/server/drizzle
  const candidates = [
    join(process.cwd(), "drizzle"),
    join(process.cwd(), "packages/server/drizzle"),
  ];
  const found = candidates.find((candidate) => existsSync(join(candidate, "meta/_journal.json")));
  if (!found) {
    throw new Error(`找不到 drizzle 迁移目录，已尝试：${candidates.join("、")}`);
  }
  return found;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL 未配置，无法执行数据库迁移");
  }

  console.log("[migrate] 开始执行数据库迁移...");
  const sql = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(sql), { migrationsFolder: resolveMigrationsFolder() });
    console.log("[migrate] 数据库迁移完成");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error("[migrate] 迁移失败:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
