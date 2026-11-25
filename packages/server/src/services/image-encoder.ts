import { createCanvas, loadImage } from "canvas";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";

/**
 * 视觉模型入参的准备：把「镜头图」变成一条 data URL。
 *
 * 为什么必须内联：镜头图由图像供应商生成，返回的是它们域名的 URL。
 * 文本/视觉供应商多数跑在自己的内网，访问不到那些 URL，更访问不到本机
 * `/static/`。把图压成 base64 内联是唯一不依赖双方网络互通的做法。
 *
 * 为什么要压：原图常见 1024×1024 PNG，单张 1–2MB；base64 后膨胀 1/3，
 * 6 张就是 10MB 量级的请求体。压到长边 768 / JPEG 0.8 后单张约 80–150KB，
 * 视觉模型判画风与肢体也不需要原始分辨率。
 */

export type ImageRefKind = "data" | "http" | "static" | "file";

export function parseImageRef(ref: string): ImageRefKind {
  const value = ref.trim();
  if (value.startsWith("data:")) return "data";
  if (/^https?:\/\//i.test(value)) return "http";
  if (value.startsWith("/static/")) return "static";
  return "file";
}

/** `/static/xxx` 对应进程工作目录下的 `static/xxx`（与 main.ts 的静态目录一致） */
export function resolveStaticPath(ref: string, cwd: string = process.cwd()): string {
  const relative = ref.replace(/^\/static\//, "");
  const full = normalize(join(cwd, "static", relative));
  const root = normalize(join(cwd, "static"));
  // 静态目录之外的路径一律拒绝：这个值来自数据库，不该成为读任意文件的入口
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`静态路径越界：${ref}`);
  }
  return full;
}

/** 只接受图片，避免把一段 HTML 错误页当成图塞进 base64 */
export function sniffImageMime(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return "image/jpeg";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 6 && buffer.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  return null;
}

export interface EncodeOptions {
  /** 长边上限 */
  maxSide?: number;
  /** JPEG 质量 */
  quality?: number;
  /** 编码后超过这个字节数就降质量重编一次 */
  maxBytes?: number;
}

const DEFAULT_OPTIONS: Required<EncodeOptions> = {
  maxSide: 768,
  quality: 0.8,
  maxBytes: 400 * 1024,
};

/**
 * 图片 → 视觉可用的 data URL（JPEG）。
 * 透明的 PNG 必须铺白底：JPEG 不支持 alpha，不铺底会变成一片黑。
 */
export async function encodeForVision(buffer: Buffer, options?: EncodeOptions): Promise<string> {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const image = await loadImage(buffer);
  const scale = Math.min(1, config.maxSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);

  let quality = config.quality;
  let out = canvas.toBuffer("image/jpeg", { quality });
  // 压过一次还超标（比如满屏噪点），再降一档。两次都降不下来就用结果，
  // 宁可请求体大一点也不要因为一张图让整批审查失败。
  while (out.length > config.maxBytes && quality > 0.4) {
    quality -= 0.15;
    out = canvas.toBuffer("image/jpeg", { quality });
  }

  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

/** data URL 直接复用；其余形态先取字节再统一编码。 */
export async function loadImageBuffer(ref: string, options?: { cwd?: string }): Promise<Buffer> {
  const kind = parseImageRef(ref);
  if (kind === "data") {
    const comma = ref.indexOf(",");
    if (comma === -1) throw new Error("data URL 格式不完整");
    return Buffer.from(ref.slice(comma + 1), "base64");
  }
  if (kind === "http") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(ref, { signal: controller.signal });
      if (!response.ok) throw new Error(`下载图片失败 HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) throw new Error("下载到的图片为空");
      return buffer;
    } finally {
      clearTimeout(timer);
    }
  }
  const path =
    kind === "static"
      ? resolveStaticPath(ref, options?.cwd)
      : isAbsolute(ref)
        ? ref
        : join(options?.cwd ?? process.cwd(), ref);
  return readFile(path);
}
