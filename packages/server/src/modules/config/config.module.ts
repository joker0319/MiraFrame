import { Module } from "@nestjs/common";
import { RuntimeConfigController } from "./config.controller";
import { ProvidersController } from "./providers.controller";
import { RuntimeConfigService } from "./config.service";
import { AdminGuard } from "./admin.guard";

@Module({
  controllers: [RuntimeConfigController, ProvidersController],
  providers: [RuntimeConfigService, AdminGuard],
})
export class RuntimeConfigModule {}
