import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { NestExpressApplication } from "@nestjs/platform-express";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { AppModule } from "./app.module.js";
import { checkStartupConfig } from "./config/startup-check.js";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 生产在 nginx 后面：信任第一层代理，RateLimitGuard 才能拿到真实客户端 IP。
  app.set("trust proxy", 1);
  const config = app.get(ConfigService);
  const port = config.get<number>("app.port") || 3000;
  // 先确保静态目录存在：上传接口的 multer dest 在启动时不会自动建目录，
  // 成片/参考图又都要写到这里。启动时建一次，失败时早暴露。
  await mkdir(join(process.cwd(), "static", "uploads"), { recursive: true });
  app.useStaticAssets(join(process.cwd(), "static"), { prefix: "/static/" });
  const corsOrigins = config.get<string[]>("app.corsOrigins") || [];
  app.enableCors({
    origin: corsOrigins,
    // origin: "*" 与 credentials: true 会被浏览器拒绝，二者不能同时开。
    credentials: !corsOrigins.includes("*"),
  });

  // 启动期配置诊断：只告警，不阻断（项目支持 fake provider 与运行时补配）
  const { warnings, summary } = checkStartupConfig();
  for (const line of summary) console.log(`[config] ${line}`);
  for (const warning of warnings) console.warn(`[config][WARN] ${warning}`);

  await app.listen(port);
  console.log(`Server running on http://localhost:${port}`);
}

bootstrap();
