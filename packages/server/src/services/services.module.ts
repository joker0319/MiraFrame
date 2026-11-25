import { Module, Global } from "@nestjs/common";
import { TextService } from "./text.service";
import { ImageService } from "./image.service";
import { VideoService } from "./video.service";
import { FaceService } from "./face.service";
import { ConsistencyService } from "./consistency.service";
import { ShotRepairService } from "./shot-repair.service";
import { KeyframeCriticService } from "./keyframe-critic.service";
import { TtsService } from "./tts.service";
import { SidecarService } from "./sidecar.service";

@Global()
@Module({
  providers: [
    TextService,
    ImageService,
    VideoService,
    FaceService,
    ConsistencyService,
    ShotRepairService,
    KeyframeCriticService,
    TtsService,
    SidecarService,
  ],
  exports: [
    TextService,
    ImageService,
    VideoService,
    FaceService,
    ConsistencyService,
    ShotRepairService,
    KeyframeCriticService,
    TtsService,
    SidecarService,
  ],
})
export class ServicesModule {}
