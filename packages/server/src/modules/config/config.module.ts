import { Module } from "@nestjs/common";
import { RuntimeConfigController } from "./config.controller";
import { RuntimeConfigService } from "./config.service";
import { AdminGuard } from "./admin.guard";

@Module({
  controllers: [RuntimeConfigController],
  providers: [RuntimeConfigService, AdminGuard],
})
export class RuntimeConfigModule {}
