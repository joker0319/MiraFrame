import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "agent",
    globals: true,
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // 默认不拉起 MCP 子进程；MCP 相关用例显式传 enabled: true
    env: { MIRAFRAME_MCP_ASSETS: "0" },
  },
});
