/**
 * 台词解析与字幕排期
 *
 * 分镜里的 dialogue 是给人看的剧本格式，例如：
 *   沈鸢（轻声）：『字条上写的是你……你是来找人说话的？』阿砚（迷茫）：『我……只想把那句话说完。』
 *   祖母（画外音/闪回）：『鸢不在留，在放。』
 *   无台词，只有轻微的布料摩擦声与窗外隐约的风声。
 *
 * 这份解析放在 shared 里，因为前后端都要用同一套规则：
 *   - 服务端拿它拆说话人、语气，决定音色与语速（TTS）
 *   - 前端拿它拆纯台词，切成字幕条叠在播放器上
 * 两边各写一份的话，配音念的字和字幕显示的字迟早会对不上。
 */

export interface DialogueLine {
  /** 说话人，解析不出时归为「旁白」 */
  speaker: string;
  /** 括号内的语气/状态提示，如「轻声」「画外音/闪回」 */
  tone: string | null;
  /** 去掉说话人与提示后的纯台词 */
  text: string;
}

/** 「角色（提示）：」的标记，角色名限定 12 字以内，避免吞掉整句 */
const SPEAKER_MARK = /([\u4e00-\u9fa5A-Za-z·]{1,12})\s*(?:[（(]([^）)]{0,40})[）)])?\s*[：:]/g;

/** 这些词后面跟冒号时通常是镜头说明，不是说话人 */
const NON_SPEAKER = new Set([
  "画面",
  "镜头",
  "场景",
  "时间",
  "地点",
  "音效",
  "提示",
  "备注",
  "注",
  "字幕",
  "转场",
]);

/** 整段只是「无台词」的描述，不产生配音也不产生字幕 */
const NO_DIALOGUE = /^(无台词|没有台词|无对白|仅音效|只有音效|本镜头无)/;

/** 去掉引号、行内舞台提示，只留能念的字 */
function cleanLine(input: string): string {
  let out = input.trim();
  // 包裹在最外层的引号可能有多种
  out = out.replace(/^[\s『「“"《]+/, "").replace(/[\s』」”"》]+$/, "");
  // 台词内部夹着的成对引号直接抹掉，避免 TTS 念出书名号停顿
  out = out.replace(/[『』「」]/g, "");
  // 形如「（转头看向窗外）沈鸢……」，去掉开头的纯提示
  out = out.replace(/^[（(][^）)]{0,60}[）)]\s*/, "");
  // 只剩标点或括号说明时不算台词
  if (/^[\s，。、；：！？…—\-（）()【】]*$/.test(out)) return "";
  return out.trim();
}

/**
 * 解析分镜台词。
 * 完全不说话的镜头返回空数组；解析不出说话人但有内容的，按旁白处理。
 */
export function parseDialogue(raw: string | null | undefined): DialogueLine[] {
  if (!raw) return [];
  const text = String(raw).replace(/\r/g, "").trim();
  if (!text || NO_DIALOGUE.test(text)) return [];

  const marks: { speaker: string; tone: string | null; start: number; end: number }[] = [];
  SPEAKER_MARK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SPEAKER_MARK.exec(text)) !== null) {
    const speaker = match[1].trim();
    const tone = match[2]?.trim() || null;
    if (NON_SPEAKER.has(speaker)) continue;
    marks.push({ speaker, tone, start: match.index, end: match.index + match[0].length });
  }

  if (marks.length === 0) {
    const plain = cleanLine(text);
    return plain ? [{ speaker: "旁白", tone: null, text: plain }] : [];
  }

  const lines: DialogueLine[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const nextStart = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const body = text.slice(marks[i].end, nextStart);
    const cleaned = cleanLine(body);
    if (cleaned) {
      lines.push({ speaker: marks[i].speaker, tone: marks[i].tone, text: cleaned });
    }
  }
  return lines;
}

/** 估算播放时长：中文按每秒 6 字（210 语速）粗算，用于提前判断是否需要加速 */
export function estimateSeconds(text: string, rate = 210): number {
  const chars = text.replace(/\s/g, "").length;
  return (chars / 6) * (210 / rate) + 0.25;
}

export interface SubtitleCue {
  /** 相对视频起点的开始秒数 */
  start: number;
  /** 相对视频起点的结束秒数 */
  end: number;
  /** 最终显示在画面上的文字 */
  text: string;
  /** 说话人，旁白时为空字符串 */
  speaker: string;
}

export interface SubtitleSegmentInput {
  /** 原始 dialogue 文本，允许带「角色（语气）：」前缀 */
  dialogue: string | null | undefined;
  /** 这一段在视频里的真实时长；缺省时按台词长度估算 */
  duration?: number | null;
}

export interface SubtitlePlanOptions {
  /**
   * 整段视频的真实总时长。
   * 传了就会把各段时长按比例缩放到它上面 —— 成片会因为某镜头台词过长被冻结末帧延长，
   * 各镜头 duration 累加并不等于成片时长，只能靠这个把误差摊回去。
   */
  totalDuration?: number;
  /** 单条字幕最多字数，超出按标点切断 */
  maxChars?: number;
  /** 单条字幕最短停留秒数 */
  minSeconds?: number;
  /** 相邻两条字幕之间的空隙秒数 */
  gapSeconds?: number;
  /** 是否在字幕前带「说话人：」，默认带（旁白不带） */
  withSpeaker?: boolean;
}

/** 断句优先级：句末标点 > 停顿标点 > 长度硬切 */
const BREAK_AFTER = /[。！？!?…]+/;
const SOFT_BREAK_AFTER = /[，、；：,;:—]+/;

/**
 * 把一句台词切成若干字幕条。
 * 中文没有空格，只能按标点断；找不到标点时才硬切，避免一屏塞三段话。
 */
export function splitSubtitleChunks(text: string, maxChars = 18): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    // 在窗口内找一个最靠后的句末标点，其次找软标点
    const hard = lastBreakIndex(window, BREAK_AFTER);
    const soft = lastBreakIndex(window, SOFT_BREAK_AFTER);
    const cut = hard > 0 ? hard : soft > 0 ? soft : maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

/** 返回窗口内最后一个可断句位置（含标点），没有则 -1 */
function lastBreakIndex(window: string, pattern: RegExp): number {
  const global = new RegExp(pattern.source, "g");
  let last = -1;
  let match: RegExpExecArray | null;
  while ((match = global.exec(window)) !== null) {
    const end = match.index + match[0].length;
    // 太靠前断开会留下一个孤零零的字，不如继续往后找
    if (end >= 2) last = end;
  }
  return last;
}

/**
 * 规划字幕时间轴。
 *
 * 规则：同一段里按字数比例分配时长，字数少的条有最短停留兜底；
 * 多段则按段时长依次累加。台词总量超出视频时长时不硬撑 ——
 * 等比压缩，因为真实场景里服务端已经先给配音加了速。
 */
export function planSubtitleCues(
  segments: SubtitleSegmentInput[],
  options: SubtitlePlanOptions = {},
): SubtitleCue[] {
  const maxChars = Math.max(6, options.maxChars ?? 18);
  const minSeconds = Math.max(0.2, options.minSeconds ?? 1.1);
  const gapSeconds = Math.max(0, options.gapSeconds ?? 0.06);
  const withSpeaker = options.withSpeaker !== false;

  const prepared = segments.map((segment) => {
    const lines = parseDialogue(segment.dialogue);
    const items = lines.flatMap((line) =>
      splitSubtitleChunks(line.text, maxChars).map((text) => ({
        text: withSpeaker && line.speaker !== "旁白" ? `${line.speaker}：${text}` : text,
        speaker: line.speaker === "旁白" ? "" : line.speaker,
      })),
    );
    const estimated = items.reduce((sum, item) => sum + estimateSeconds(item.text), 0);
    const declared = segment.duration && segment.duration > 0 ? segment.duration : 0;
    return { items, duration: declared || estimated };
  });

  const declaredTotal = prepared.reduce((sum, segment) => sum + segment.duration, 0);
  const target = options.totalDuration && options.totalDuration > 0 ? options.totalDuration : 0;
  const scale = target > 0 && declaredTotal > 0 ? target / declaredTotal : 1;

  const cues: SubtitleCue[] = [];
  let timeline = 0;
  for (const segment of prepared) {
    const segStart = timeline;
    const segEnd = segStart + segment.duration * scale;
    timeline = segEnd;
    if (segment.items.length === 0) continue;

    const gap = Math.min(gapSeconds, (segEnd - segStart) / (segment.items.length * 4));
    const usable = Math.max(0, segEnd - segStart - gap * (segment.items.length - 1));
    const durations = allocate(
      segment.items.map((item) => item.text.length),
      usable,
      minSeconds,
    );

    let cursor = segStart;
    segment.items.forEach((item, index) => {
      const start = cursor;
      const end = Math.min(segEnd, start + durations[index]);
      if (end - start >= 0.15) {
        cues.push({ start, end, text: item.text, speaker: item.speaker });
      }
      cursor = end + gap;
    });
  }
  return cues;
}

/**
 * 按字数权重分配可用时长，并保证每条不低于 floor。
 * 抬高低谷的时长要从高峰那里等比例扣，否则总长会溢出到下一段。
 */
function allocate(weights: number[], usable: number, minSeconds: number): number[] {
  if (weights.length === 0 || usable <= 0) return weights.map(() => 0);

  // 每条加一点固定开销，避免「嗯」这种单字条短到看不见
  const adjusted = weights.map((weight) => Math.max(1, weight) + 1.2);
  const totalWeight = adjusted.reduce((sum, value) => sum + value, 0);
  const raw = adjusted.map((weight) => (usable * weight) / totalWeight);

  const floor = Math.min(minSeconds, usable / weights.length);
  const deficits = raw.reduce((sum, value) => sum + Math.max(0, floor - value), 0);
  const surplus = raw.reduce((sum, value) => sum + Math.max(0, value - floor), 0);
  if (deficits <= 0 || surplus <= 0) return raw;

  const shrink = Math.min(1, deficits / surplus);
  return raw.map((value) => (value < floor ? floor : value - (value - floor) * shrink));
}
