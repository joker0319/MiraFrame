import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "agent",
    globals: true,
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
