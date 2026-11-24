import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { timingSafeEqual } from "node:crypto";

export const ADMIN_TOKEN_HEADER = "x-admin-token";

/**
 * 保护「会改动运行时配置或读取敏感信息」的接口。
 *
 * 设计取舍：ADMIN_TOKEN 未配置时视为本地开发模式并放行 —— 否则设置面板在
 * 首次配置 token 前会被自己的守卫锁死。是否为开发模式由启动期日志明确告警，
 * 部署到共享环境前设置 ADMIN_TOKEN 即自动启用校验。
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>("app.adminToken");
    if (!expected) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    const provided = request.headers?.[ADMIN_TOKEN_HEADER];
    const token = Array.isArray(provided) ? provided[0] : provided;

    if (token && constantTimeEquals(token, expected)) return true;
    throw new UnauthorizedException("需要有效的 X-Admin-Token 才能执行该操作");
  }
}

/** 长度不同时直接返回 false；相同长度用 timingSafeEqual 避免时序侧信道。 */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
