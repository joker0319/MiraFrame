import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "server",
    globals: true,
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
