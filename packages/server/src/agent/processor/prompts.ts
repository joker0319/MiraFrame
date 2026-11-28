/**
 * 镜头出图/出视频的提示词拼装。
 *
 * 纯字符串逻辑，和 DB/服务无关；从 processor 抽出来后可独立单测，
 * 也避免 processor 继续膨胀。
 */

export function buildShotImagePrompt(
  shot: {
    order?: number;
    description?: string | null;
    camera?: string | null;
    scene?: string | null;
    action?: string | null;
    lighting?: string | null;
  },
  visualBible?: string | null,
  style?: string | null,
): string {
  return [
    `Create a storyboard key frame for shot ${shot.order || ""}.`,
    `Style: ${style || "anime comic drama"}.`,
    visualBible ? `Visual bible: ${visualBible}.` : null,
    shot.scene ? `Scene: ${shot.scene}.` : null,
    shot.description ? `Description: ${shot.description}.` : null,
    shot.action ? `Action: ${shot.action}.` : null,
    shot.camera ? `Camera: ${shot.camera}.` : null,
    shot.lighting ? `Lighting: ${shot.lighting}.` : null,
    "Single cinematic frame, consistent character designs, production-ready composition.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildShotVideoPrompt(
  shot: {
    order?: number;
    description?: string | null;
    camera?: string | null;
    action?: string | null;
    dialogue?: string | null;
    motionNote?: string | null;
  },
  imagePrompt?: string | null,
): string {
  return [
    `Generate a short comic-drama video clip for shot ${shot.order || ""}.`,
    imagePrompt ? `Key frame prompt: ${imagePrompt}.` : null,
    shot.description ? `Story action: ${shot.description}.` : null,
    shot.action ? `Movement: ${shot.action}.` : null,
    shot.motionNote ? `Motion note: ${shot.motionNote}.` : null,
    shot.camera ? `Camera: ${shot.camera}.` : null,
    shot.dialogue ? `Dialogue context: ${shot.dialogue}.` : null,
    "Keep motion gentle, coherent, and suitable for later montage composition.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function isPlayableVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov)(\?|#|$)/i.test(url) || (url.includes(".oss-") && url.includes(".mp4"));
}
