import { Injectable, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { extractMediaUrl, extractTaskId, extractTaskStatus } from "./image.service";

@Injectable()
export class VideoService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

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

  async composeVideo(projectId: number, clipUrls: string[]): Promise<string> {
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

    const concatListPath = join(workDir, "concat.txt");
    await writeFile(concatListPath, clipPaths.map((path) => `file '${escapeConcatPath(path)}'`).join("\n"), "utf-8");

    const outputPath = join(exportDir, "final.mp4");
    const ffmpegPath = this.config.get<string>("app.ffmpegPath") || "ffmpeg";
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
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
    await chmod(outputPath, 0o644);
    await writeFile(join(exportDir, "composition.html"), buildCompositionHtml(clipUrls), "utf-8");
    const publicBaseUrl = this.config.get<string>("app.publicBaseUrl") || "http://localhost:3000";
    return `${publicBaseUrl}/static/exports/project-${projectId}/final.mp4`;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCompositionHtml(clipUrls: string[]): string {
  const clipsJson = JSON.stringify(clipUrls).replace(/</g, "\\u003c");
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
      status.textContent = '合成预览：镜头 ' + (index + 1) + ' / ' + clips.length;
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
