import { describe, expect, it } from "vitest";
import { HttpException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { ApiAuthGuard } from "../common/api-auth.guard";
import { RateLimitGuard } from "../common/rate-limit.guard";

function makeConfig(values: Record<string, unknown>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function httpContext(
  headers: Record<string, string | undefined> = {},
  ip = "127.0.0.1",
): ExecutionContext {
  return {
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => ({ headers, ip }) }),
  } as unknown as ExecutionContext;
}

describe("ApiAuthGuard", () => {
  it("未配置 API_TOKEN 时放行", () => {
    const guard = new ApiAuthGuard(makeConfig({}));
    expect(guard.canActivate(httpContext())).toBe(true);
  });

  it("支持 X-API-Token、X-Admin-Token 与 Bearer", () => {
    const guard = new ApiAuthGuard(makeConfig({ "app.apiToken": "secret" }));
    expect(guard.canActivate(httpContext({ "x-api-token": "secret" }))).toBe(true);
    expect(guard.canActivate(httpContext({ "x-admin-token": "secret" }))).toBe(true);
    expect(guard.canActivate(httpContext({ authorization: "Bearer secret" }))).toBe(true);
  });

  it("缺少或错误 token 返回 401", () => {
    const guard = new ApiAuthGuard(makeConfig({ "app.apiToken": "secret" }));
    expect(() => guard.canActivate(httpContext())).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(httpContext({ "x-api-token": "wrong" }))).toThrow(
      UnauthorizedException,
    );
  });
});

describe("RateLimitGuard", () => {
  it("超过每分钟额度返回 429，不同 IP 单独计数", () => {
    const guard = new RateLimitGuard(makeConfig({ "app.rateLimitPerMinute": 2 }));
    expect(guard.canActivate(httpContext({}, "1.1.1.1"))).toBe(true);
    expect(guard.canActivate(httpContext({}, "1.1.1.1"))).toBe(true);
    expect(() => guard.canActivate(httpContext({}, "1.1.1.1"))).toThrow(HttpException);
    expect(guard.canActivate(httpContext({}, "2.2.2.2"))).toBe(true);
  });

  it("0 表示关闭", () => {
    const guard = new RateLimitGuard(makeConfig({ "app.rateLimitPerMinute": 0 }));
    for (let i = 0; i < 10; i += 1) {
      expect(guard.canActivate(httpContext())).toBe(true);
    }
  });
});
