import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { CoreModule } from "./core";
import { DatabaseModule } from "./db";
import { RedisModule } from "./redis";
import { ServicesModule } from "./services";
import { WsModule } from "./ws";
import { AgentModule } from "./agent";
import { GenerationModule } from "./modules/generation";
import { ProjectsModule } from "./modules/projects/projects.module";
import { RuntimeConfigModule } from "./modules/config/config.module";
import { BullModule } from "@nestjs/bullmq";
import { ApiAuthGuard } from "./common/api-auth.guard";
import { RateLimitGuard } from "./common/rate-limit.guard";

@Module({
  imports: [
    CoreModule,
    DatabaseModule,
    RedisModule,
    ServicesModule,
    WsModule,
    // BullMQ for background jobs
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>("app.redisHost") || "localhost",
          port: config.get<number>("app.redisPort") || 6379,
        },
      }),
    }),
    AgentModule,
    GenerationModule,
    ProjectsModule,
    RuntimeConfigModule,
  ],
  providers: [
    // 顺序即执行顺序：先认证，再限流
    { provide: APP_GUARD, useClass: ApiAuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
