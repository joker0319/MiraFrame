import { Injectable, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EdgeTTS, Communicate } from "edge-tts-universal";
import type { VoiceAssignment } from "./dialogue";

export type TtsProvider = "macos" | "edge" | "none";

export interface TtsRequest {
  text: string;
  voice?: string;
  /** 字/分钟，macOS say 的 -r 参数 */
  rate?: number;
  volume?: number;
}

export interface TtsResult {
  buffer: Buffer;
  format: "wav" | "mp3";
  /** 实际使用的音色（可能因降级与请求值不同） */
  voice: string;
}

/**
 * 语音合成。两台引擎：
 *
 * - macos：调用系统 say 命令，离线、零成本，中文音色齐全，适合本地演示。
 *   代价是只能在 macOS 上跑，音质不如神经网络 TTS。
 * - edge：微软 Edge 的在线 TTS，音质好且免费，但端点需要 Sec-MS-GEC 令牌校验，
 *   目前固定返回 403（2026-11 实测直连与代理均失败），保留实现以便端点恢复后直接切换。
 *
 * 用 TTS_PROVIDER 选择，设为 none 则整个配音环节跳过。
 */
@Injectable()
export class TtsService {
  private voiceCache: { at: number; voices: string[] } | null = null;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  get provider(): TtsProvider {
    const raw = (this.config.get<string>("app.ttsProvider") || "macos").toLowerCase();
    if (raw === "edge" || raw === "none" || raw === "macos") return raw;
    return "macos";
  }

  get enabled(): boolean {
    return this.provider !== "none" && this.config.get<boolean>("app.ttsEnabled") !== false;
  }

  private get timeoutMs(): number {
    return this.config.get<number>("app.ttsTimeoutMs") ?? 30_000;
  }

  private get fallbackVoice(): string {
    return this.config.get<string>("app.ttsVoiceFallback") || "Tingting";
  }

  /** 合成一段台词，返回可直接交给 ffmpeg 的音频 */
  async synthesize(request: TtsRequest): Promise<TtsResult | null> {
    const text = request.text?.trim();
    if (!text || !this.enabled) return null;

    if (this.provider === "macos") {
      return this.synthesizeMacos(text, request);
    }
    return this.synthesizeEdge(text, request);
  }

  /** 按 planDialogue 产出的音色档案批量合成，同一镜头的多句台词会按顺序拼接 */
  async synthesizeMany(segments: { text: string; voice: VoiceAssignment }[]): Promise<(TtsResult | null)[]> {
    const results: (TtsResult | null)[] = [];
    for (const segment of segments) {
      results.push(
        await this.synthesize({
          text: segment.text,
          voice: segment.voice.voice,
          rate: segment.voice.rate,
          volume: segment.voice.volume,
        }),
      );
    }
    return results;
  }

  /**
   * macOS say。
   * 关键细节：音色名必须带语言后缀。`say -v Sandy` 会命中英文版并输出近乎空的音频，
   * 必须写 `Sandy (中文（中国大陆）)`。
   */
  private async synthesizeMacos(text: string, request: TtsRequest): Promise<TtsResult | null> {
    const rate = Math.round(request.rate ?? 210);
    const requested = request.voice || this.fallbackVoice;
    const candidates = [requested, this.fallbackVoice].filter((voice, index, list) => list.indexOf(voice) === index);

    for (const voice of candidates) {
      const outPath = join(tmpdir(), `miraframe-tts-${randomUUID()}.wav`);
      try {
        await this.runSay(voice, rate, text, outPath);
        const buffer = await readFile(outPath);
        // 音色不存在时 say 会静默产出空文件或 0.02s 的占位音频，据此判断并换下一个
        if (buffer.length < 4096) throw new Error(`音色 ${voice} 产出音频过短`);
        return { buffer, format: "wav", voice };
      } catch (error) {
        if (voice === candidates[candidates.length - 1]) {
          throw new Error(`macOS 语音合成失败：${(error as Error).message}`);
        }
      } finally {
        await rm(outPath, { force: true }).catch(() => undefined);
      }
    }
    return null;
  }

  private runSay(voice: string, rate: number, text: string, outPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "say",
        ["-v", voice, "-r", String(rate), "-o", outPath, "--data-format=LEI16@22050", text],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`say 超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);

      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 2000) stderr = stderr.slice(-2000);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "系统缺少 say 命令（仅 macOS 可用）" : error.message));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `say 退出码 ${code}`));
      });
    });
  }

  /** 微软 Edge 在线 TTS，端点恢复后把 TTS_PROVIDER 改成 edge 即可启用 */
  private async synthesizeEdge(text: string, request: TtsRequest): Promise<TtsResult> {
    const voice = request.voice || "zh-CN-XiaoxiaoNeural";
    const ratePercent = request.rate ? `${Math.round(((request.rate - 210) / 210) * 100)}%` : "+0%";
    const tts = new EdgeTTS(text, voice, {
      rate: ratePercent.startsWith("-") ? ratePercent : `+${ratePercent.replace("+", "")}`,
      volume: "+0%",
    });

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Edge TTS 超时（${this.timeoutMs}ms）`)), this.timeoutMs).unref?.();
    });

    const result = await Promise.race([tts.synthesize(), timeout]);
    return { buffer: Buffer.from(await result.audio.arrayBuffer()), format: "mp3", voice };
  }

  /** 流式合成，供将来的实时预览使用 */
  async *streamSpeech(text: string, voice = "zh-CN-XiaoxiaoNeural", rate = "+0%"): AsyncGenerator<Buffer> {
    const communicate = new Communicate(text, { voice, rate });
    for await (const chunk of communicate.stream()) {
      if (chunk.type === "audio" && chunk.data) yield chunk.data;
    }
  }

  /** 自检：返回当前引擎与可用音色，供设置页展示 */
  async probe(): Promise<{ provider: TtsProvider; available: boolean; voices: string[]; message: string }> {
    if (this.provider === "none") {
      return { provider: "none", available: false, voices: [], message: "配音已关闭（TTS_PROVIDER=none）" };
    }
    if (this.provider === "edge") {
      try {
        const sample = await this.synthesize({ text: "测试", voice: "zh-CN-XiaoxiaoNeural" });
        return {
          provider: "edge",
          available: Boolean(sample),
          voices: ["zh-CN-XiaoxiaoNeural"],
          message: sample ? "Edge TTS 可用" : "Edge TTS 无输出",
        };
      } catch (error) {
        return { provider: "edge", available: false, voices: [], message: `Edge TTS 不可用：${(error as Error).message}` };
      }
    }

    const voices = await this.listMacosVoices();
    return {
      provider: "macos",
      available: voices.length > 0,
      voices,
      message: voices.length > 0 ? `可用 ${voices.length} 个中文音色` : "未找到中文音色",
    };
  }

  /** 读取系统中文音色列表，结果缓存 10 分钟 */
  async listMacosVoices(): Promise<string[]> {
    if (this.voiceCache && Date.now() - this.voiceCache.at < 600_000) return this.voiceCache.voices;

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("say", ["-v", "?"], { stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.on("error", reject);
      child.on("close", () => resolve(stdout));
    }).catch(() => "");

    const voices = output
      .split("\n")
      .map((line) => line.match(/^(.+?)\s{2,}(zh_CN)\s+#/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => match[1].trim());

    this.voiceCache = { at: Date.now(), voices };
    return voices;
  }

  static CHINESE_VOICES = [
    { name: "zh-CN-XiaoxiaoNeural", label: "晓晓 (女声 — 温暖)", gender: "Female" },
    { name: "zh-CN-YunxiNeural", label: "云希 (男声 — 新闻)", gender: "Male" },
    { name: "zh-CN-YunjianNeural", label: "云健 (男声 — 运动)", gender: "Male" },
    { name: "zh-CN-XiaoyiNeural", label: "晓伊 (女声 — 活泼)", gender: "Female" },
    { name: "zh-CN-YunyangNeural", label: "云扬 (男声 — 专业)", gender: "Male" },
  ];
}
