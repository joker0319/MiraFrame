import { describe, expect, it } from "vitest";
import { resolveApiBase } from "@/services/client";

/**
 * WS 与 API 共用同一套地址解析。这里直接注入 location / env，
 * 覆盖显式配置、HTTPS 同源（nginx /ws/）、开发直连、SSR 四种形态。
 */
const httpsOrigin = {
  href: "https://mira.example.com/projects/1",
  origin: "https://mira.example.com",
};
const devOrigin = {
  href: "http://localhost:5173/projects/1",
  origin: "http://localhost:5173",
};

describe("WS / API 地址解析", () => {
  it("显式 VITE_API_URL 同时作为 API 与 WS 的 origin", () => {
    const base = resolveApiBase(devOrigin, {
      VITE_API_URL: "https://api.example.com",
      DEV: true,
    });

    expect(base).toBe("https://api.example.com");
    expect(`${base}/ws/projects`).toBe("https://api.example.com/ws/projects");
  });

  it("生产环境用页面同源，不再硬编码 3000 端口", () => {
    const base = resolveApiBase(httpsOrigin, { DEV: false });

    expect(base).toBe("https://mira.example.com");
    expect(`${base}/ws/projects`).toBe("https://mira.example.com/ws/projects");
  });

  it("开发环境保留直连后端 3000", () => {
    expect(resolveApiBase(devOrigin, { DEV: true })).toBe("http://localhost:3000");
  });

  it("SSR / 无 window 回落到 localhost:3000", () => {
    expect(resolveApiBase(undefined, { DEV: false })).toBe("http://localhost:3000");
  });
});
