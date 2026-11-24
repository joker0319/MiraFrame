import { describe, expect, it } from "vitest";
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { AdminGuard, constantTimeEquals } from "../modules/config/admin.guard";
import { DEFAULT_CORS_ORIGINS, parseCorsOrigins } from "../config/cors";
import { checkStartupConfig } from "../config/startup-check";
import { parseProjectRoomId } from "../ws/room";

function makeContext(headers: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function makeConfig(token: string | null): ConfigService {
  return { get: () => token } as unknown as ConfigService;
}

const CLEAN_ENV: Record<string, string | undefined> = {
  TEXT_PROVIDER: "fake",
  IMAGE_PROVIDER: "fake",
  VIDEO_PROVIDER: "fake",
  ADMIN_TOKEN: "local-secret",
  CORS_ORIGINS: '["http://localhost:5173"]',
};

describe("parseCorsOrigins", () => {
  it("未配置时返回本地开发白名单，不放开任意来源", () => {
    expect(parseCorsOrigins(undefined)).toEqual(DEFAULT_CORS_ORIGINS);
    expect(parseCorsOrigins(undefined)).not.toContain("*");
  });

  it("解析 JSON 数组与逗号分隔格式", () => {
    expect(parseCorsOrigins('["http://a.com","http://b.com"]')).toEqual(["http://a.com", "http://b.com"]);
    expect(parseCorsOrigins("http://a.com, http://b.com")).toEqual(["http://a.com", "http://b.com"]);
  });

  it("只有显式配置为 * 才放开任意来源", () => {
    expect(parseCorsOrigins("*")).toEqual(["*"]);
    expect(parseCorsOrigins("")).toEqual(DEFAULT_CORS_ORIGINS);
  });

  it("空数组或非法 JSON 退回默认白名单，不会变成拒绝所有来源", () => {
    expect(parseCorsOrigins("[]")).toEqual(DEFAULT_CORS_ORIGINS);
    expect(parseCorsOrigins("[not-json")).toEqual(DEFAULT_CORS_ORIGINS);
  });
});

describe("parseProjectRoomId", () => {
  it("接受字符串与数字形式的正整数", () => {
    expect(parseProjectRoomId("23")).toBe(23);
    expect(parseProjectRoomId(" 23 ")).toBe(23);
    expect(parseProjectRoomId(23)).toBe(23);
  });

  it("拒绝非数字、负数、零、小数、超大数与对象", () => {
    for (const raw of ["abc", "project:1", "-1", "0", "1.5", "", null, {}, NaN, Infinity]) {
      expect(parseProjectRoomId(raw)).toBeNull();
    }
    expect(parseProjectRoomId(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });
});

describe("constantTimeEquals", () => {
  it("相同字符串返回 true", () => {
    expect(constantTimeEquals("secret", "secret")).toBe(true);
  });

  it("长度不同或内容不同返回 false", () => {
    expect(constantTimeEquals("secret", "secret-longer")).toBe(false);
    expect(constantTimeEquals("secret", "secreT")).toBe(false);
  });
});

describe("AdminGuard", () => {
  it("未配置 ADMIN_TOKEN 时放行（本地开发模式）", () => {
    const guard = new AdminGuard(makeConfig(null));
    expect(guard.canActivate(makeContext({}))).toBe(true);
  });

  it("配置 token 后，缺失或错误的 header 会被拒绝", () => {
    const guard = new AdminGuard(makeConfig("expected"));
    expect(() => guard.canActivate(makeContext({}))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(makeContext({ "x-admin-token": "wrong" }))).toThrow(UnauthorizedException);
  });

  it("配置 token 后，正确 header 放行", () => {
    const guard = new AdminGuard(makeConfig("expected"));
    expect(guard.canActivate(makeContext({ "x-admin-token": "expected" }))).toBe(true);
  });
});

describe("checkStartupConfig", () => {
  it("配置齐全时无告警，并给出三个 provider 摘要", () => {
    const result = checkStartupConfig(CLEAN_ENV);
    expect(result.warnings).toEqual([]);
    expect(result.summary).toHaveLength(3);
    expect(result.summary[0]).toContain("TEXT: provider=fake");
  });

  it("未配置 ADMIN_TOKEN 时给出明确告警", () => {
    const result = checkStartupConfig({ ...CLEAN_ENV, ADMIN_TOKEN: "" });
    expect(result.warnings.some((w) => w.includes("ADMIN_TOKEN"))).toBe(true);
  });

  it("CORS 全开时给出告警", () => {
    const result = checkStartupConfig({ ...CLEAN_ENV, CORS_ORIGINS: "*" });
    expect(result.warnings.some((w) => w.includes("CORS_ORIGINS"))).toBe(true);
  });

  it("非 fake provider 缺 API Key 时给出告警，fake 不告警", () => {
    const withMissing = checkStartupConfig({ ...CLEAN_ENV, VIDEO_PROVIDER: "openai" });
    expect(withMissing.warnings.some((w) => w.includes("VIDEO_API_KEY"))).toBe(true);

    const withFake = checkStartupConfig({ ...CLEAN_ENV, VIDEO_PROVIDER: "fake" });
    expect(withFake.warnings.some((w) => w.includes("VIDEO_API_KEY"))).toBe(false);
  });

  it("数值配置非法时给出告警，空值视为未配置不告警", () => {
    const bad = checkStartupConfig({ ...CLEAN_ENV, CRITIC_SCORE_THRESHOLD: "abc" });
    expect(bad.warnings.some((w) => w.includes("CRITIC_SCORE_THRESHOLD"))).toBe(true);

    const empty = checkStartupConfig({ ...CLEAN_ENV, CRITIC_SCORE_THRESHOLD: "" });
    expect(empty.warnings.some((w) => w.includes("CRITIC_SCORE_THRESHOLD"))).toBe(false);
  });

  it("一致性阈值 OK >= DRIFT 时给出告警", () => {
    const result = checkStartupConfig({
      ...CLEAN_ENV,
      FACE_OK_DISTANCE: "0.8",
      FACE_DRIFT_DISTANCE: "0.6",
    });
    expect(result.warnings.some((w) => w.includes("FACE_OK_DISTANCE"))).toBe(true);
  });

  it("provider 值不在枚举内时给出告警", () => {
    const result = checkStartupConfig({ ...CLEAN_ENV, TEXT_PROVIDER: "doubao" });
    expect(result.warnings.some((w) => w.includes("不是已知 provider"))).toBe(true);
  });
});
