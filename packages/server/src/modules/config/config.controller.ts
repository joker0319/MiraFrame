import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Put, UseGuards } from "@nestjs/common";
import { RuntimeConfigService, type ConfigValue } from "./config.service";
import { AdminGuard } from "./admin.guard";

@Controller("api/v1/config")
export class RuntimeConfigController {
  constructor(@Inject(RuntimeConfigService) private readonly runtimeConfig: RuntimeConfigService) {}

  /** 只读接口，敏感值已脱敏，保持公开以便设置面板加载。 */
  @Get()
  async list() {
    return this.runtimeConfig.list();
  }

  /** 写 .env 与测试连接都受 ADMIN_TOKEN 保护（未配置 token 时为本地开发模式）。 */
  @Put()
  @UseGuards(AdminGuard)
  async update(@Body() body: { configs?: Record<string, ConfigValue> }) {
    const configs = Object.fromEntries(
      Object.entries(body.configs || {}).map(([key, value]) => [
        key,
        value === null ? null : String(value),
      ]),
    );
    return this.runtimeConfig.update(configs);
  }

  @Post("test-connection")
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  async testConnection(@Body() body: { service?: "llm" | "image" | "video"; config_overrides?: Record<string, string | null> }) {
    const service = body.service === "image" || body.service === "video" ? body.service : "llm";
    return this.runtimeConfig.testConnection(service, body.config_overrides);
  }
}
