import {
  CanActivate,
  Inject,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { constantTimeEquals } from "../modules/config/admin.guard";

/**
 * 可选的 API 共享令牌。
 *
 * 未配置 API_TOKEN 时完全放行（本地开发 / 演示）。
 * 配置后，所有 HTTP 接口要求 `X-API-Token` 或 `Authorization: Bearer`；
 * WebSocket 在网关里单独校验 handshake token。
 *
 * 注意：这是「共享口令」级别的门，不是用户体系/会话鉴权。
 * 要真正区分用户、做权限和审计，需要再接 OIDC/Session。
 */
@Injectable()
export class ApiAuthGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") return true;
    const expected = this.config.get<string>("app.apiToken");
    if (!expected) return true;

    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
    }>();
    const tokens = extractTokens(request.headers);
    if (tokens.some((token) => constantTimeEquals(token, expected))) return true;
    throw new UnauthorizedException("需要有效的 X-API-Token 才能访问该接口");
  }
}

function extractTokens(
  headers: Record<string, string | string[] | undefined> | undefined,
): string[] {
  const tokens: string[] = [];
  const apiToken = headers?.["x-api-token"];
  if (typeof apiToken === "string" && apiToken) tokens.push(apiToken);

  const adminToken = headers?.["x-admin-token"];
  if (typeof adminToken === "string" && adminToken) tokens.push(adminToken);

  const authorization = headers?.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    const bearer = authorization.slice("Bearer ".length).trim();
    if (bearer) tokens.push(bearer);
  }
  return tokens;
}
