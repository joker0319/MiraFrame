import { Injectable, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { extractMediaUrl, extractTaskId, extractTaskStatus } from "./image.service";
import { TtsService } from "./tts.service";
import { planDialogue, type DialogueSegment } from "./dialogue";

@Injectable()
export class VideoService {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(TtsService) private readonly tts: TtsService,
  ) {}

  async generateVideo(
    prompt: string,
    options?: { imageUrl?: string | null; duration?: number | null; ratio?: string | null },
  ): Promise<string> {
    const provider = this.config.get<string>("app.videoProvider") || "fake";
    const fixtureUrl = this.config.get<string>("app.fakeVideoFixtureUrl");
    if (provider === "fake") return fixtureUrl || "about:blank#video-fixture";

    const baseUrl = this.config.get<string>("app.videoBaseUrl") || "https://api.example.com/v1";
    const configuredEndpoint = this.config.get<string>("app.videoEndpoint") || "";
    const isDashScope = baseUrl.includes("dashscope");
    const isAgnes = baseUrl.includes("agnes");
    const endpoint =
      isDashScope && (!configuredEndpoint || configuredEndpoint === "/videos/generations")
        ? "/services/aigc/video-generation/video-synthesis"
        : configuredEndpoint || "/videos/generations";
    const apiKey =
      this.config.get<string>("app.videoApiKey") ||
      this.config.get<string>("app.doubaoApiKey") ||
      "";
    const model =
      this.config.get<string>("app.videoModel") ||
      this.config.get<string>("app.doubaoVideoModel") ||
      "video-gen-1";

    if (!apiKey) return "about:blank#video-api-key-missing";

    // Agnes AI：POST /v1/videos 创建任务 → 轮询 /agnesapi 取结果
    if (isAgnes) {
      return this.generateAgnesVideo(baseUrl, apiKey, model, prompt, options, this.config.get<number>("app.videoTimeoutMs"));
    }

    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(isDashScope ? { "X-DashScope-Async": "enable" } : {}),
      },
      body: JSON.stringify(
        isDashScope
          ? {
              model,
              input: {
                prompt,
                ...(options?.imageUrl
                  ? {
                      media: [
                        {
                          type: "first_frame",
                          url: options.imageUrl,
                        },
                      ],
                    }
                  : {}),
              },
              parameters: {
                duration: options?.duration || this.config.get<number>("app.doubaoVideoDuration") || 5,
                resolution: "720P",
                prompt_extend: true,
                watermark: false,
              },
            }
          : {
              model,
              prompt,
              image_url: options?.imageUrl || undefined,
              duration: options?.duration || this.config.get<number>("app.doubaoVideoDuration") || 5,
              ratio: options?.ratio || this.config.get<string>("app.doubaoVideoRatio") || "adaptive",
            },
      ),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Video API error ${response.status}: ${errorText.substring(0, 200)}`);
    }

    const json = (await response.json()) as Record<string, unknown>;
    const url = extractMediaUrl(json);
    if (url) return url;

    const taskId = extractTaskId(json) || stringValue(json.id) || stringValue(json.task_id) || stringValue(json.taskId);
    if (taskId && isDashScope) {
      const taskUrl = await this.pollDashScopeTask(baseUrl, apiKey, taskId, 300_000);
      if (taskUrl) return taskUrl;
      throw new Error(`Video task ${taskId} did not finish within 300 seconds. Please retry this shot later.`);
    }
    if (taskId) return `${baseUrl}${endpoint}/${taskId}`;

    throw new Error(`Video API returned no URL: ${JSON.stringify(json).substring(0, 300)}`);
  }

  /**
   * 合成为成片。
   *
   * 传入 dialogues 时会给每个镜头配上人声：原视频自带的音轨压成底噪（默认 0.08 ≈ -22dB），
   * 台词按角色音色合成后混入主轨；台词超出镜头时长时先加速人声（上限 maxTempo），
   * 仍不够就冻结末帧延长画面，保证话说完、画面不断。
   */
  async composeVideo(
    projectId: number,
    clipUrls: string[],
    options: ComposeOptions = {},
  ): Promise<string> {
    const exportDir = join(process.cwd(), "static", "exports", `project-${projectId}`);
    const workDir = join(exportDir, "clips");
    await mkdir(exportDir, { recursive: true });
    await mkdir(workDir, { recursive: true });

    const clipPaths: string[] = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const clipPath = join(workDir, `clip-${String(i + 1).padStart(2, "0")}.mp4`);
      await downloadFile(clipUrls[i], clipPath);
      clipPaths.push(clipPath);
    }

    const spec = await probeMedia(clipPaths[0], this.ffprobePath);
    const stagePaths: string[] = [];
    const cues: SubtitleCue[] = [];
    let timeline = 0;
    let voicedShots = 0;

    for (let i = 0; i < clipPaths.length; i += 1) {
      const raw = this.tts.enabled ? options.dialogues?.[i] : null;
      const plan = raw ? planDialogue(raw, { descriptions: options.characterDescriptions, baseRate: this.ttsBaseRate }) : [];
      const staged = join(workDir, `stage-${String(i + 1).padStart(2, "0")}.mp4`);

      const result = await this.buildStagedClip({
        clipPath: clipPaths[i],
        plan,
        index: i,
        spec,
        outPath: staged,
        workDir,
      });

      stagePaths.push(staged);
      if (result.voiced) {
        voicedShots += 1;
        cues.push({ start: timeline, end: timeline + result.duration, text: buildCueText(plan) });
      }
      timeline += result.duration;
    }

    const concatListPath = join(workDir, "concat.txt");
    await writeFile(concatListPath, stagePaths.map((path) => `file '${escapeConcatPath(path)}'`).join("\n"), "utf-8");

    const outputPath = join(exportDir, "final.mp4");
    const ffmpegPath = this.ffmpegPath;
    await runFfmpeg(ffmpegPath, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
    await chmod(outputPath, 0o644);

    // 字幕与成片同目录，播放器可外挂；不烧进画面，避免中文字体缺失
    await writeFile(join(exportDir, "final.srt"), buildSrt(cues), "utf-8");
    await writeFile(
      join(exportDir, "composition.html"),
      buildCompositionHtml(clipUrls, { voicedShots, totalShots: clipPaths.length }),
      "utf-8",
    );
    console.log(
      `[Compose] project ${projectId}: ${clipPaths.length} 个镜头，${voicedShots} 个带配音，总长 ${timeline.toFixed(1)}s`,
    );

    const publicBaseUrl = this.config.get<string>("app.publicBaseUrl") || "http://localhost:3000";
    return `${publicBaseUrl}/static/exports/project-${projectId}/final.mp4`;
  }

  private get ffmpegPath(): string {
    return this.config.get<string>("app.ffmpegPath") || "ffmpeg";
  }

  private get ffprobePath(): string {
    return this.config.get<string>("app.ffprobePath") || "ffprobe";
  }

  private get ttsBaseRate(): number {
    return this.config.get<number>("app.ttsBaseRate") ?? 210;
  }

  /**
   * 处理单个镜头：合成台词 → 人声与画面混流 → 统一编码规格。
   * 无论有没有台词都会重编码，保证 concat 时所有片段的编码参数一致。
   */
  private async buildStagedClip(input: {
    clipPath: string;
    plan: DialogueSegment[];
    index: number;
    spec: MediaSpec;
    outPath: string;
    workDir: string;
  }): Promise<{ duration: number; voiced: boolean }> {
    const { clipPath, plan, index, spec, outPath, workDir } = input;
    const clip = await probeMedia(clipPath, this.ffprobePath);
    const clipDuration = clip.duration || 5;
    const lead = Math.max(0, (this.config.get<number>("app.ttsLeadMs") ?? 250) / 1000);
    const bgmVolume = this.config.get<number>("app.ttsBgmVolume") ?? 0.08;
    const maxTempo = this.config.get<number>("app.ttsMaxTempo") ?? 1.35;

    let dialoguePath: string | null = null;
    let dialogueDuration = 0;
    let tempo = 1;

    if (plan.length > 0) {
      try {
        dialoguePath = await this.buildDialogueTrack(plan, join(workDir, `voice-${String(index + 1).padStart(2, "0")}`));
        dialogueDuration = (await probeMedia(dialoguePath, this.ffprobePath)).duration;
      } catch (error) {
        console.warn(`[Compose] 镜头 ${index + 1} 配音失败，跳过人声：${(error as Error).message}`);
        dialoguePath = null;
        dialogueDuration = 0;
      }
    }

    const voiced = Boolean(dialoguePath) && dialogueDuration > 0;
    if (voiced) {
      const available = Math.max(1, clipDuration - lead - 0.15);
      if (dialogueDuration > available) {
        tempo = Math.min(maxTempo, dialogueDuration / available);
      }
    }

    // 加速后仍超出，就延长画面（冻结末帧），确保最后一句不被截断
    const spokenAfterTempo = voiced ? dialogueDuration / tempo : 0;
    const needed = voiced ? lead + spokenAfterTempo + 0.25 : 0;
    const finalDuration = Math.max(clipDuration, needed);
    const extra = Math.max(0, finalDuration - clipDuration);

    const targetSize = `scale=${spec.width}:${spec.height}:force_original_aspect_ratio=decrease,pad=${spec.width}:${spec.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    const videoChain = `[0:v]${targetSize},fps=${spec.fps}${extra > 0.02 ? `,tpad=stop_mode=clone:stop_duration=${extra.toFixed(3)}` : ""}[v]`;
    const args: string[] = ["-y", "-i", clipPath];

    let filter: string;
    if (voiced && dialoguePath) {
      args.push("-i", dialoguePath);
      const tempoChain = tempo > 1.02 ? `atempo=${tempo.toFixed(3)},` : "";
      const voiceChain =
        `[1:a]${tempoChain}` +
        `adelay=${Math.round(lead * 1000)}|${Math.round(lead * 1000)},` +
        `apad=whole_dur=${finalDuration.toFixed(3)},atrim=0:${finalDuration.toFixed(3)}[vo]`;

      if (clip.hasAudio) {
        filter =
          `${videoChain};` +
          `[0:a]volume=${bgmVolume},apad=whole_dur=${finalDuration.toFixed(3)},atrim=0:${finalDuration.toFixed(3)}[bg];` +
          `${voiceChain};` +
          `[bg][vo]amix=inputs=2:duration=longest:normalize=0:dropout_transition=0,alimiter=limit=0.95[a]`;
      } else {
        filter = `${videoChain};${voiceChain};[vo]alimiter=limit=0.95[a]`;
      }
      args.push("-filter_complex", filter, "-map", "[v]", "-map", "[a]");
    } else if (clip.hasAudio) {
      // 没有台词的镜头保留环境原声，不做压缩
      filter = `${videoChain}`;
      args.push("-filter_complex", filter, "-map", "[v]", "-map", "0:a");
    } else {
      // 无音轨的镜头补一条静音，保证拼接时音轨结构一致
      args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
      filter = `${videoChain}`;
      args.push("-filter_complex", filter, "-map", "[v]", "-map", "1:a", "-shortest");
    }

    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      outPath,
    );

    await runFfmpeg(this.ffmpegPath, args);
    if (dialoguePath) await rm(dialoguePath, { force: true }).catch(() => undefined);
    return { duration: finalDuration, voiced };
  }

  /** 把同一镜头的多句台词按顺序拼成一条音轨，句间留停顿 */
  private async buildDialogueTrack(plan: DialogueSegment[], basePath: string): Promise<string> {
    const parts: string[] = [];
    for (let i = 0; i < plan.length; i += 1) {
      const line = plan[i];
      const synth = await this.tts.synthesize({
        text: line.text,
        voice: line.voice.voice,
        rate: line.voice.rate,
        volume: line.voice.volume,
      });
      if (!synth) continue;

      const rawPath = `${basePath}-${i}-raw.${synth.format}`;
      const normPath = `${basePath}-${i}.wav`;
      await writeFile(rawPath, synth.buffer);
      // 逐句应用音量（轻声要压、喊叫要提），再统一成 22050 单声道 + 句尾 320ms 停顿
      await runFfmpeg(this.ffmpegPath, [
        "-y",
        "-i",
        rawPath,
        "-af",
        `volume=${line.voice.volume.toFixed(2)},apad=pad_dur=0.32`,
        "-ar",
        "22050",
        "-ac",
        "1",
        normPath,
      ]);
      await rm(rawPath, { force: true }).catch(() => undefined);
      parts.push(normPath);
    }

    if (parts.length === 0) throw new Error("没有合成出任何台词音频");
    const joined = `${basePath}.wav`;
    if (parts.length === 1) {
      await runFfmpeg(this.ffmpegPath, ["-y", "-i", parts[0], "-c", "copy", joined]);
    } else {
      const listPath = `${basePath}.txt`;
      await writeFile(listPath, parts.map((path) => `file '${escapeConcatPath(path)}'`).join("\n"), "utf-8");
      await runFfmpeg(this.ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", joined]);
      await rm(listPath, { force: true }).catch(() => undefined);
    }
    for (const part of parts) await rm(part, { force: true }).catch(() => undefined);
    return joined;
  }

  private async generateAgnesVideo(
    baseUrl: string,
    apiKey: string,
    model: string,
    prompt: string,
    options: { imageUrl?: string | null; duration?: number | null; ratio?: string | null } | undefined,
    timeoutMs: number = 300_000,
  ): Promise<string> {
    const endpoint = "/videos";
    // Agnes 查询接口在域名根路径 /agnesapi，而不是 /v1 下
    const rootUrl = baseUrl.replace(/\/v1\/?$/, "");
    const body: Record<string, unknown> = {
      model,
      prompt,
      mode: options?.imageUrl ? "keyframe" : "text",
      seconds: String(options?.duration || 5),
      size: "720P",
      aspect_ratio: "16:9",
    };
    if (options?.imageUrl) body.first_frame = options.imageUrl;

    const maxRetries = this.config.get<number>("app.videoMaxRetries") ?? 6;
    const baseDelayMs = this.config.get<number>("app.videoRetryBaseMs") ?? 5000;

    let json: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      if (response.ok) {
        json = (await response.json()) as Record<string, unknown>;
        break;
      }

      const errorText = await response.text().catch(() => "Unknown error");
      // 可重试：队列满(503)、限流(429)、服务不可用(502/504)、网络抖动
      const retryable =
        response.status === 503 ||
        response.status === 429 ||
        response.status === 502 ||
        response.status === 504 ||
        /queue_full|队列已满|rate.?limit|too many|busy|try again/i.test(errorText);
      if (!retryable || attempt >= maxRetries) {
        throw new Error(`Agnes Video API error ${response.status}: ${errorText.substring(0, 200)}`);
      }

      // 退避：优先读 Retry-After，否则 2^n 指数（5s→10s→20s→40s...，封顶 120s）
      const retryAfter = response.headers.get("retry-after");
      let delayMs = Math.min(baseDelayMs * Math.pow(2, attempt), 120_000);
      if (retryAfter) {
        const sec = Number(retryAfter);
        if (Number.isFinite(sec) && sec > 0) delayMs = Math.max(delayMs, sec * 1000);
      }
      // 队列满时服务端可能不返回 Retry-After，加随机抖动避免多镜头同时重试再次撞满
      delayMs += Math.floor(Math.random() * 3000);
      console.warn(
        `[AgnesVideo] 提交被限流/队列满 (HTTP ${response.status})，${Math.round(delayMs / 1000)}s 后重试 ` +
          `(${attempt + 1}/${maxRetries}): ${errorText.substring(0, 120)}`,
      );
      await sleep(delayMs);
    }

    if (!json) throw new Error(`Agnes Video API 提交失败：重试 ${maxRetries} 次仍未成功`);
    // 立即返回 URL 的情况（少见于同步模式）
    const directUrl = extractMediaUrl(json);
    if (directUrl && typeof directUrl === "string" && directUrl.startsWith("http")) return directUrl;

    const videoId = stringValue(json.video_id) || stringValue(json.id) || stringValue(json.task_id);
    if (!videoId) {
      throw new Error(`Agnes Video API returned no video_id: ${JSON.stringify(json).substring(0, 300)}`);
    }

    return this.pollAgnesVideo(rootUrl, apiKey, model, videoId, timeoutMs);
  }

  private async pollAgnesVideo(
    rootUrl: string,
    apiKey: string,
    model: string,
    videoId: string,
    timeoutMs: number,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(3_000);
      const query = `${rootUrl}/agnesapi?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(model)}`;
      const response = await fetch(query, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) continue;
      const json = (await response.json()) as Record<string, unknown>;
      const status = stringValue(json.status);
      if (status === "failed") {
        const err = json.error as Record<string, unknown> | null;
        const message = err instanceof Error
          ? err.message
          : (err && stringValue(err.message)) || JSON.stringify(json).substring(0, 300);
        throw new Error(`Agnes Video task ${videoId} failed: ${message}`);
      }
      const url = extractMediaUrl(json);
      if (status === "completed" && url) return url;
    }
    throw new Error(`Agnes Video task ${videoId} did not finish within ${Math.round(timeoutMs / 1000)}s. Please retry this shot later.`);
  }

  private async pollDashScopeTask(baseUrl: string, apiKey: string, taskId: string, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(10_000);
      const response = await fetch(`${baseUrl}/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) continue;
      const json = (await response.json()) as Record<string, unknown>;
      const status = extractTaskStatus(json);
      if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
        throw new Error(`Video task ${taskId} failed: ${JSON.stringify(json).substring(0, 300)}`);
      }
      const url = extractMediaUrl(json);
      if (status === "SUCCEEDED" && url) return url;
    }
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export interface ComposeOptions {
  /** 与 clipUrls 一一对应的分镜台词原文，缺省则该镜头不配音 */
  dialogues?: (string | null)[];
  /** 角色名 → 角色描述，用于推断音色性别年龄 */
  characterDescriptions?: Record<string, string>;
}

interface MediaSpec {
  width: number;
  height: number;
  fps: number;
}

interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

/** ffprobe 读时长、尺寸、帧率与是否存在音轨 */
async function probeMedia(
  path: string,
  ffprobePath: string,
): Promise<{ duration: number; hasAudio: boolean; width: number; height: number; fps: number }> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffprobePath, [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      path,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) =>
      reject(new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "系统缺少 ffprobe" : error.message)),
    );
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `ffprobe 退出码 ${code}`))));
  });

  const parsed = JSON.parse(output || "{}") as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string }[];
  };
  const streams = parsed.streams || [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const [num, den] = (video?.r_frame_rate || "30/1").split("/").map(Number);
  const fps = den ? Math.round((num / den) * 100) / 100 : 30;

  return {
    duration: Number(parsed.format?.duration || 0),
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
    width: video?.width || 1280,
    height: video?.height || 720,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
  };
}

/** 字幕文本：保留说话人，便于对不上口型时判断是谁在说 */
function buildCueText(plan: DialogueSegment[]): string {
  return plan.map((line) => (line.speaker === "旁白" ? line.text : `${line.speaker}：${line.text}`)).join("\n");
}

function buildSrt(cues: SubtitleCue[]): string {
  const stamp = (seconds: number) => {
    const total = Math.max(0, seconds);
    const hh = Math.floor(total / 3600);
    const mm = Math.floor((total % 3600) / 60);
    const ss = Math.floor(total % 60);
    const ms = Math.round((total - Math.floor(total)) * 1000);
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
  };
  return cues
    .map((cue, index) => `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`)
    .join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCompositionHtml(clipUrls: string[], stats?: { voicedShots: number; totalShots: number }): string {
  const clipsJson = JSON.stringify(clipUrls).replace(/</g, "\\u003c");
  const voiceNote = stats ? ` · ${stats.voicedShots}/${stats.totalShots} 个镜头含配音` : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MiraFrame 合成预览</title>
  <style>
    body{margin:0;background:#101114;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{min-height:100vh;display:grid;place-items:center;padding:24px}
    .wrap{width:min(960px,100%)}
    video{width:100%;max-height:72vh;background:#000;border-radius:8px}
    .bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px}
    button{background:#f8fafc;color:#111827;border:0;border-radius:6px;padding:8px 12px;font-weight:600;cursor:pointer}
    p{margin:0;color:#cbd5e1;font-size:14px}
  </style>
</head>
<body>
  <main>
    <div class="wrap">
      <video id="player" controls autoplay playsinline></video>
      <div class="bar">
        <p id="status"></p>
        <button id="restart">从头播放</button>
      </div>
    </div>
  </main>
  <script>
    const clips = ${clipsJson};
    const player = document.getElementById('player');
    const status = document.getElementById('status');
    let index = 0;
    function load(i) {
      index = Math.max(0, Math.min(i, clips.length - 1));
      player.src = clips[index];
      status.textContent = '合成预览：镜头 ' + (index + 1) + ' / ' + clips.length + '${voiceNote}';
      player.play().catch(() => {});
    }
    player.addEventListener('ended', () => {
      if (index + 1 < clips.length) load(index + 1);
    });
    document.getElementById('restart').addEventListener('click', () => load(0));
    load(0);
  </script>
</body>
</html>`;
}

async function downloadFile(url: string, path: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) {
    throw new Error(`下载镜头视频失败 ${response.status}: ${url}`);
  }
  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(path);
    response.body!.pipeTo(
      new WritableStream({
        write(chunk) {
          return new Promise<void>((chunkResolve, chunkReject) => {
            file.write(Buffer.from(chunk), (err) => err ? chunkReject(err) : chunkResolve());
          });
        },
        close() {
          file.end(resolve);
        },
        abort(reason) {
          file.destroy();
          reject(reason);
        },
      }),
    ).catch(reject);
    file.on("error", reject);
  });
}

function runFfmpeg(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("缺少 ffmpeg，无法合成单个 mp4。请安装 ffmpeg 或设置 FFMPEG_PATH。"));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 合成失败（exit ${code}）：${stderr}`));
    });
  });
}

function escapeConcatPath(path: string): string {
  return path.replace(/'/g, "'\\''");
}
