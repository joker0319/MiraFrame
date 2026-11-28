import {
  CanActivate,
  Inject,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

interface Window {
  count: number;
  resetAt: number;
}

/**
 * 进程内固定窗口限流。默认关闭（RATE_LIMIT_PER_MINUTE=0）。
 *
 * 单实例原型足够用；多实例部署时应换 Redis/网关级限流，
 * 否则每个副本各算各的，实际额度会翻倍。
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limit: number;
  private readonly hits = new Map<string, Window>();

  constructor(@Inject(ConfigService) config: ConfigService) {
    const raw = config.get<number>("app.rateLimitPerMinute") ?? 0;
    this.limit = Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.limit <= 0 || context.getType() !== "http") return true;

    const request = context.switchToHttp().getRequest<{
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
    }>();
    const forwarded = request.headers?.["x-forwarded-for"];
    const ip =
      (typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined) ||
      request.ip ||
      "unknown";
    const now = Date.now();
    const existing = this.hits.get(ip);

    if (!existing || existing.resetAt <= now) {
      this.hits.set(ip, { count: 1, resetAt: now + 60_000 });
      this.prune(now);
      return true;
    }
    existing.count += 1;
    if (existing.count > this.limit) {
      throw new HttpException("请求过于频繁，请稍后再试", HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }

  private prune(now: number): void {
    if (this.hits.size < 5000) return;
    for (const [key, window] of this.hits) {
      if (window.resetAt <= now) this.hits.delete(key);
    }
  }
}
