import { Injectable, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FaceService, type DetectedFace } from "./face.service";
import {
  DEFAULT_THRESHOLDS,
  evaluateShot,
  summarize,
  type CharacterReference,
  type ConsistencyReport,
  type ConsistencyThresholds,
  type ShotInput,
} from "./consistency";

export interface ConsistencyInput {
  characters: Array<{
    id: number;
    name: string;
    imageUrl: string | null;
    referenceImages?: string[] | null;
  }>;
  shots: Array<{
    id: number;
    order: number;
    imageUrl: string | null;
    characterIds: number[] | null;
  }>;
}

/** 单进程内缓存：同一张图不重复下载、不重复推理 */
const faceCache = new Map<string, DetectedFace[]>();
const downloadCache = new Map<string, string>();

@Injectable()
export class ConsistencyService {
  constructor(
    @Inject(FaceService) private readonly face: FaceService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  getThresholds(): ConsistencyThresholds {
    const ok = Number(this.config.get<string>("app.faceOkDistance") ?? "");
    const drift = Number(this.config.get<string>("app.faceDriftDistance") ?? "");
    return {
      ok: Number.isFinite(ok) && ok > 0 ? ok : DEFAULT_THRESHOLDS.ok,
      drift: Number.isFinite(drift) && drift > 0 ? drift : DEFAULT_THRESHOLDS.drift,
      matchLimit: DEFAULT_THRESHOLDS.matchLimit,
    };
  }

  async analyze(input: ConsistencyInput): Promise<ConsistencyReport> {
    const started = Date.now();
    if (!this.face.isReady()) {
      throw new Error(`人脸模型未就绪：${this.face.getError() || "未知原因"}`);
    }
    const thresholds = this.getThresholds();

    // 1. 角色参考特征
    const references: CharacterReference[] = [];
    for (const character of input.characters) {
      const urls = dedupe([character.imageUrl, ...(character.referenceImages || [])]).slice(0, 3);
      const descriptors: number[][] = [];
      for (const url of urls) {
        const faces = await this.detectUrl(url);
        // 参考图如果是全身/多人构图，取最大的一张脸作为这个角色的基准
        const primary = faces.sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
        if (primary) descriptors.push(primary.descriptor);
      }
      references.push({ characterId: character.id, name: character.name, descriptors });
    }

    // 2. 逐镜头检测
    const shots: ShotInput[] = [];
    for (const shot of input.shots) {
      const faces = shot.imageUrl ? await this.detectUrl(shot.imageUrl) : [];
      shots.push({
        shotId: shot.id,
        order: shot.order,
        expectedCharacterIds: shot.characterIds || [],
        faces: faces.map((f) => ({ descriptor: f.descriptor, score: f.score, box: f.box })),
      });
    }

    const results = shots.map((shot) => evaluateShot(shot, references, thresholds));
    results.sort((a, b) => a.order - b.order);

    return {
      thresholds,
      characters: references.map((r) => ({
        characterId: r.characterId,
        name: r.name,
        referenceFaces: r.descriptors.length,
      })),
      shots: results,
      summary: summarize(results),
    };
  }

  private async detectUrl(url: string): Promise<DetectedFace[]> {
    const cached = faceCache.get(url);
    if (cached) return cached;
    const path = await this.fetchToCache(url);
    const faces = await this.face.detect(path, { maxSide: 640 });
    faceCache.set(url, faces);
    return faces;
  }

  private async fetchToCache(url: string): Promise<string> {
    const known = downloadCache.get(url);
    if (known) return known;

    const dir = join(tmpdir(), "miraframe-face-cache");
    await mkdir(dir, { recursive: true });
    const hash = createHash("sha1").update(url).digest("hex");
    const ext = (url.match(/\.(png|jpe?g|webp)(?:\?|$)/i)?.[1] || "png").toLowerCase();
    const path = join(dir, `${hash}.${ext}`);

    try {
      const info = await stat(path);
      if (info.size > 1024) {
        downloadCache.set(url, path);
        return path;
      }
    } catch {
      // 未缓存，走下载
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) throw new Error("下载到的图片过小，可能是错误页");
      await writeFile(path, buf);
      downloadCache.set(url, path);
      return path;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 供测试/调试：清空进程内缓存 */
  clearCache() {
    faceCache.clear();
    downloadCache.clear();
  }
}

function dedupe(list: Array<string | null | undefined>): string[] {
  return [...new Set(list.filter((v): v is string => Boolean(v)))];
}
