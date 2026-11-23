/**
 * 台词解析与配音编排
 *
 * 分镜里的 dialogue 是给人看的剧本格式，例如：
 *   沈鸢（轻声）：『字条上写的是你……你是来找人说话的？』阿砚（迷茫）：『我……只想把那句话说完。』
 *   祖母（画外音/闪回）：『鸢不在留，在放。』
 *   无台词，只有轻微的布料摩擦声与窗外隐约的风声。
 *
 * 直接丢给 TTS 会把「沈鸢轻声」也念出来，所以这里做三件事：
 *   1. 拆出说话人、语气提示、纯台词文本
 *   2. 按角色稳定分配音色（同角色跨镜头必须同一个声音）
 *   3. 把语气词转成语速/音量微调，并规划镜头内的时间轴
 */

export interface DialogueLine {
  /** 说话人，解析不出时归为「旁白」 */
  speaker: string;
  /** 括号内的语气/状态提示，如「轻声」「画外音/闪回」 */
  tone: string | null;
  /** 去掉说话人与提示后的纯台词，直接送 TTS */
  text: string;
}

export interface VoiceAssignment {
  /** 音色标识，provider 自行解释（macOS 为 say 的语音名） */
  voice: string;
  /** 语速（字/分钟，macOS say 的 -r 参数） */
  rate: number;
  /** 音量增益，1 为原音量 */
  volume: number;
}

export interface DialogueSegment extends DialogueLine {
  voice: VoiceAssignment;
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

/** 整段只是「无台词」的描述，不产生配音 */
const NO_DIALOGUE = /^(无台词|没有台词|无对白|仅音效|只有音效|本镜头无)/;

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

/** 角色名/描述里出现这些词，判定为老人 */
const OLD_FEMALE = /(祖母|奶奶|外婆|姥姥|婆婆|大娘|老妇|老妪|老太太|嬷嬷|阿婆)/;
const OLD_MALE = /(祖父|爷爷|外公|姥爷|阿公|公公|老翁|老者|老汉)/;
/**
 * 中文名没有性别标记，只能靠常见用字与称谓猜。
 * 先匹配描述里的称谓（少女、少年），再落到名字用字；两边都没有时走默认值。
 */
const FEMALE =
  /(少女|姑娘|女子|女人|女孩|娘亲|阿娘|母亲|姐姐|妹妹|丫头|少妇|妇人|妃|婢|女|嫣|鸢|兰|芳|燕|娜|静|丽|莉|婷|洁|琳|莹|倩|雪|薇|蓉|媛|瑾|娟|秀|英|花|月|玉|珠|翠|香|珍|莲|荷|梅)/;
const MALE =
  /(少年|男孩|男子|男人|公子|书生|兄|弟|父亲|叔叔|童子|小厮|郎|哥|伯|父|砚|锋|峰|刚|强|军|伟|勇|杰|涛|鹏|辉|磊|超|明|志|建|国|康|生|山|海|江|川|石|铁|虎|龙|舟|岩|岳)/;

interface VoiceProfile {
  voice: string;
  rate: number;
}

/**
 * macOS 中文音色池。名字必须带语言后缀，`say -v Eddy` 会匹配到英文版并生成近乎空的音频。
 * 这些是 macOS 自带的多语言语音（Elite/Premium），未安装时由 provider 降级。
 */
export const MACOS_VOICES = {
  youngFemale: ["Sandy (中文（中国大陆）)", "Shelley (中文（中国大陆）)", "Flo (中文（中国大陆）)"],
  youngMale: ["Eddy (中文（中国大陆）)", "Reed (中文（中国大陆）)", "Rocko (中文（中国大陆）)"],
  oldFemale: ["Grandma (中文（中国大陆）)"],
  oldMale: ["Grandpa (中文（中国大陆）)"],
  narrator: ["Tingting"],
} as const;

export type VoiceGender = "youngFemale" | "youngMale" | "oldFemale" | "oldMale" | "narrator";

/** 从角色名与描述推断音色类别 */
export function inferVoiceGender(speaker: string, description?: string | null): VoiceGender {
  if (speaker === "旁白" || speaker === "画外音") return "narrator";
  const bag = `${speaker} ${description || ""}`;
  if (OLD_FEMALE.test(bag)) return "oldFemale";
  if (OLD_MALE.test(bag)) return "oldMale";
  if (FEMALE.test(bag)) return "youngFemale";
  if (MALE.test(bag)) return "youngMale";
  return "youngFemale";
}

/** 同一角色必须稳定，用名字哈希在池内选一个，避免每镜头换声音 */
function stablePick(pool: readonly string[], key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) % 100000;
  return pool[hash % pool.length];
}

/** 语气提示对语速的影响（负值放慢，正值加快） */
const TONE_RATE_BIAS: [RegExp, number][] = [
  [/(低声|轻声|喃喃|自语|耳语|呢喃|小声)/, -18],
  [/(大喊|喊|吼|急|惊|怒|嘶)/, 22],
  [/(画外音|旁白|独白)/, -8],
  [/(笑|欣慰|释然)/, -6],
];

/** 语气提示对音量的影响 */
const TONE_VOLUME_BIAS: [RegExp, number][] = [
  [/(低声|轻声|喃喃|自语|耳语|呢喃|小声)/, 0.78],
  [/(大喊|喊|吼|嘶)/, 1.12],
  [/(画外音)/, 0.92],
];

export interface ResolveOptions {
  /** 基础语速，默认 210（中文约每秒 6 字，5 秒镜头能装下 30 字） */
  baseRate?: number;
  /** 角色描述表，用于推断性别年龄 */
  descriptions?: Record<string, string>;
  /** 显式指定：角色名 → 音色名（最高优先级） */
  voiceMap?: Record<string, string>;
  /** 音色池，默认 macOS 中文语音 */
  pools?: typeof MACOS_VOICES;
}

/** 为一个说话人决定音色、语速、音量 */
export function resolveVoice(speaker: string, tone: string | null, options: ResolveOptions = {}): VoiceAssignment {
  const pools = options.pools || MACOS_VOICES;
  const baseRate = options.baseRate ?? 210;
  const explicit = options.voiceMap?.[speaker];
  const category = inferVoiceGender(speaker, options.descriptions?.[speaker]);
  const voice = explicit || stablePick(pools[category], speaker);

  let rate = baseRate;
  let volume = 1;
  if (tone) {
    for (const [pattern, delta] of TONE_RATE_BIAS) if (pattern.test(tone)) rate += delta;
    for (const [pattern, gain] of TONE_VOLUME_BIAS) if (pattern.test(tone)) volume *= gain;
  }
  return { voice, rate: Math.max(120, Math.min(300, rate)), volume: Number(volume.toFixed(2)) };
}

/** 把台词段落绑定音色，得到可送入 TTS 的计划 */
export function planDialogue(raw: string | null | undefined, options: ResolveOptions = {}): DialogueSegment[] {
  return parseDialogue(raw).map((line) => ({
    ...line,
    voice: resolveVoice(line.speaker, line.tone, options),
  }));
}

/** 估算播放时长：中文按每秒 6 字（210 语速）粗算，用于提前判断是否需要加速 */
export function estimateSeconds(text: string, rate: number): number {
  const chars = text.replace(/\s/g, "").length;
  return (chars / 6) * (210 / rate) + 0.25;
}
