import { Controller, Get, Inject } from "@nestjs/common";
import { TextService } from "../../services/text.service";
import { ImageService } from "../../services/image.service";
import { VideoService } from "../../services/video.service";

/**
 * Provider 选路观测端点（只读、脱敏）。
 *
 * 只暴露「谁在链上、当前是否熔断、成功率、平均延迟、上次错误」，
 * 不返回 baseUrl / apiKey / endpoint，避免把内部拓扑和凭证带出去。
 * 演示时可以直接 curl 看到主 provider 连续 401 之后 half_open 的过程。
 */
@Controller("api/v1/providers")
export class ProvidersController {
  constructor(
    @Inject(TextService) private readonly text: TextService,
    @Inject(ImageService) private readonly image: ImageService,
    @Inject(VideoService) private readonly video: VideoService,
  ) {}

  @Get()
  list() {
    return {
      text: this.text.providerHealth(),
      image: this.image.providerHealth(),
      video: this.video.providerHealth(),
    };
  }
}
