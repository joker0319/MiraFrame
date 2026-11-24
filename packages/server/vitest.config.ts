import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "server",
    globals: true,
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // e2e spec 会跑图节点，关掉 MCP 子进程让测试只关注业务逻辑
    env: { MIRAFRAME_MCP_ASSETS: "0" },
  },
});
