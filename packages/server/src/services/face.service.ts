import { Injectable, OnModuleInit } from "@nestjs/common";
import * as faceapi from "@vladmandic/face-api/dist/face-api.node-wasm.js";
import * as canvas from "canvas";
import * as path from "node:path";
import { readFile } from "node:fs/promises";

/**
 * 人脸检测与特征提取。
 *
 * 两个必须在 Node 里手动补的坑（否则模型永远加载不出来）：
 * 1. 后端初始化 —— face-api 的 wasm 构建在没有 setBackend/ready 时会直接抛
 *    「highest priority backend 'wasm' has not yet been initialized」。这里显式切到
 *    cpu 后端：tfjs-node 没有作为 face-api 的兄弟依赖被 pnpm 解析到，wasm 又需要
 *    手动注册二进制路径，cpu 最稳。
 * 2. 媒体类型注入 —— face-api 用 tfjs env 里的 Image/Canvas 做 instanceof 判断，
 *    只改 globalThis 不生效，必须走 env.monkeyPatch。
 */
@Injectable()
export class FaceService implements OnModuleInit {
  private ready = false;
  private loadError: string | null = null;

  private backend = "none";

  async onModuleInit() {
    try {
      const tf = (faceapi as unknown as { tf: any }).tf;

      // 优先 wasm：纯 JS 的 cpu 后端跑一次 SSD 要 4.5s，wasm 快 3-5 倍
      this.backend = await this.initBackend(tf);

      (faceapi as unknown as { env: any }).env.monkeyPatch({
        Canvas: canvas.Canvas,
        Image: canvas.Image,
        ImageData: canvas.ImageData,
        Video: undefined,
      });

      const modelPath = path.join(process.cwd(), "node_modules/@vladmandic/face-api/model");
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelPath);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(modelPath);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(modelPath);

      this.ready = true;
      console.log(`FaceService: models loaded (backend=${this.backend})`);
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
      console.warn("FaceService: failed to load models:", this.loadError);
    }
  }

  private async initBackend(tf: any): Promise<string> {
    try {
      // face-api 的 bundle 会 require 同一份 backend-wasm，这里只需告诉它 .wasm 在哪
      const wasm = await import("@tensorflow/tfjs-backend-wasm");
      const setWasmPaths = (wasm as unknown as { setWasmPaths?: (p: string) => void }).setWasmPaths;
      if (setWasmPaths) {
        setWasmPaths(path.join(process.cwd(), "node_modules/@tensorflow/tfjs-backend-wasm/dist/"));
      }
      const ok = await tf.setBackend("wasm");
      await tf.ready();
      if (ok) return "wasm";
    } catch (error) {
      console.warn("FaceService: wasm 后端不可用，回退 cpu ——", (error as Error).message?.slice(0, 120));
    }
    await tf.setBackend("cpu");
    await tf.ready();
    return "cpu";
  }

  isReady(): boolean {
    return this.ready;
  }

  getError(): string | null {
    return this.loadError;
  }

  getBackend(): string {
    return this.backend;
  }

  /**
   * 检测图片中的所有人脸并输出 128 维特征向量。
   * @param source 本地文件路径或图片二进制
   * @param maxSide 检测前把长边缩到这个值；1024→640 可省一半时间且不掉召回
   */
  async detect(
    source: string | Buffer,
    options: { maxSide?: number; minConfidence?: number } = {},
  ): Promise<DetectedFace[]> {
    if (!this.ready) {
      throw new Error(this.loadError ? `FaceService 未就绪: ${this.loadError}` : "FaceService 未就绪");
    }

    const buffer = typeof source === "string" ? await readFile(source) : source;
    const img = await canvas.loadImage(buffer);
    const { maxSide = 640 } = options;
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const c = canvas.createCanvas(width, height);
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);

    const detections = await faceapi
      .detectAllFaces(
        c as unknown as HTMLCanvasElement,
        new faceapi.SsdMobilenetv1Options({ minConfidence: options.minConfidence ?? 0.3 }),
      )
      .withFaceLandmarks()
      .withFaceDescriptors();

    return detections.map((d) => ({
      // 缩放回原图坐标，方便日后做高亮框
      box: {
        x: d.detection.box.x / scale,
        y: d.detection.box.y / scale,
        width: d.detection.box.width / scale,
        height: d.detection.box.height / scale,
      },
      score: d.detection.score,
      descriptor: Array.from(d.descriptor) as number[],
    }));
  }

  /**
   * 兼容旧调用方（sidecar）：接收 base64，返回便于序列化的扁平结构。
   * 新代码请直接用 detect()。
   */
  async detectFaces(imageBase64: string, minDetScore = 0.5): Promise<FaceDetectResult> {
    try {
      const faces = await this.detect(Buffer.from(imageBase64, "base64"), { minConfidence: minDetScore });
      return {
        faces: faces.map((f) => ({
          bbox: [f.box.x, f.box.y, f.box.width, f.box.height],
          det_score: f.score,
          embedding: f.descriptor,
        })),
        count: faces.length,
        error: null,
      };
    } catch (error) {
      return { faces: [], count: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export interface FaceDetectResult {
  faces: Array<{ bbox: number[]; det_score: number; embedding: number[] | null }>;
  count: number;
  error: string | null;
}

export interface DetectedFace {
  box: { x: number; y: number; width: number; height: number };
  score: number;
  descriptor: number[];
}

/** 两个特征向量的欧氏距离：同一人通常 < 0.45，不同人通常 > 0.6 */
export function faceDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}
