import { describe, expect, it } from "vitest";
import {
  estimateSeconds,
  parseDialogue,
  planSubtitleCues,
  splitSubtitleChunks,
} from "../utils/dialogue";

describe("parseDialogue（shared 版）", () => {
  it("拆出说话人、语气与纯台词，不把舞台提示念出来", () => {
    const lines = parseDialogue(
      "沈鸢（轻声）：『字条上写的是你……你是来找人说话的？』阿砚（迷茫）：『我……只想把那句话说完。』",
    );
    expect(lines).toEqual([
      {
        speaker: "沈鸢",
        tone: "轻声",
        text: "字条上写的是你……你是来找人说话的？",
      },
      { speaker: "阿砚", tone: "迷茫", text: "我……只想把那句话说完。" },
    ]);
  });

  it("「无台词」描述与空值都不产生台词", () => {
    expect(parseDialogue("无台词，只有轻微的布料摩擦声与窗外隐约的风声。")).toEqual([]);
    expect(parseDialogue(null)).toEqual([]);
    expect(parseDialogue("   ")).toEqual([]);
  });

  it("没有说话人标记时按旁白处理", () => {
    expect(parseDialogue("临安城的雨落了整夜。")).toEqual([
      { speaker: "旁白", tone: null, text: "临安城的雨落了整夜。" },
    ]);
  });
});

describe("splitSubtitleChunks", () => {
  it("短句不切", () => {
    expect(splitSubtitleChunks("起风了。", 18)).toEqual(["起风了。"]);
  });

  it("长句优先在句末标点断，其次在逗号断", () => {
    const chunks = splitSubtitleChunks(
      "我明白不是替你说尽遗憾，而是让我学会放下，把那句话好好说完。",
      14,
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 14)).toBe(true);
    expect(chunks.join("")).toContain("我明白");
    expect(chunks.join("")).toContain("把那句话好好说完");
  });

  it("完全没有标点时按长度硬切，不丢字", () => {
    const source = "啊".repeat(41);
    const chunks = splitSubtitleChunks(source, 18);
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe(source);
  });
});

describe("planSubtitleCues", () => {
  it("单镜头单句铺满视频时长，说话人带在前面", () => {
    const cues = planSubtitleCues([{ dialogue: "沈鸢（轻声）：『起风了。』", duration: 5 }]);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("沈鸢：起风了。");
    expect(cues[0].speaker).toBe("沈鸢");
    expect(cues[0].start).toBe(0);
    expect(cues[0].end).toBeCloseTo(5, 2);
  });

  it("旁白不带说话人前缀", () => {
    const cues = planSubtitleCues([{ dialogue: "临安城的雨落了整夜。", duration: 4 }]);
    expect(cues[0].text).toBe("临安城的雨落了整夜。");
    expect(cues[0].speaker).toBe("");
  });

  it("withSpeaker=false 时只留纯台词", () => {
    const cues = planSubtitleCues([{ dialogue: "沈鸢：『去吧，阿砚。』", duration: 4 }], {
      withSpeaker: false,
    });
    expect(cues[0].text).toBe("去吧，阿砚。");
  });

  it("多角色长句拆成多条，按字数分配时长且不重叠", () => {
    const cues = planSubtitleCues([
      {
        dialogue: "沈鸢：『去吧，阿砚。』阿砚：『我……只想把那句话好好说完，不让风把它吹散。』",
        duration: 8,
      },
    ]);
    // 阿砚那句超过一屏字数，会按标点切成多条；沈鸢那句短，保持一条
    expect(cues.length).toBeGreaterThanOrEqual(3);
    expect(cues[0].text).toContain("沈鸢");
    expect(cues[0].start).toBe(0);
    expect(cues.at(-1)?.text).toContain("阿砚");
    for (let i = 1; i < cues.length; i += 1) {
      expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end);
    }
    const firstSpan = cues[0].end - cues[0].start;
    const restSpan = cues.slice(1).reduce((sum, cue) => sum + cue.end - cue.start, 0);
    expect(restSpan).toBeGreaterThan(firstSpan);
    expect(cues.at(-1)?.end).toBeCloseTo(8, 2);
  });

  it("没给 duration 时按语速估算，estimateSeconds 仍是同一套公式", () => {
    const cues = planSubtitleCues([{ dialogue: "沈鸢：『起风了。』" }]);
    expect(cues).toHaveLength(1);
    expect(cues[0].end).toBeGreaterThan(0);
    expect(cues[0].end).toBeLessThan(estimateSeconds("沈鸢：起风了。", 210) * 1.5);
  });

  it("多段按镜头顺序累加时间轴，无台词的段不产字幕但占时间", () => {
    const cues = planSubtitleCues([
      { dialogue: "沈鸢：『起风了。』", duration: 4 },
      { dialogue: "无台词，只有风声。", duration: 3 },
      { dialogue: "阿砚：『我听见了。』", duration: 4 },
    ]);
    expect(cues).toHaveLength(2);
    expect(cues[0].end).toBeCloseTo(4, 2);
    expect(cues[1].start).toBeGreaterThanOrEqual(7);
    expect(cues[1].end).toBeCloseTo(11, 2);
  });

  it("totalDuration 把各段时长等比缩放到成片真实时长", () => {
    const cues = planSubtitleCues(
      [
        { dialogue: "沈鸢：『起风了。』", duration: 5 },
        { dialogue: "阿砚：『我听见了。』", duration: 5 },
      ],
      { totalDuration: 12 },
    );
    expect(cues[0].end).toBeCloseTo(6, 2);
    expect(cues[1].start).toBeGreaterThanOrEqual(6);
    expect(cues[1].end).toBeCloseTo(12, 2);
  });

  it("台词远长于视频时长时压缩但不越界", () => {
    const long = `沈鸢：『${"字条上写的是你，你是来找人说话的吗".repeat(6)}。』`;
    const cues = planSubtitleCues([{ dialogue: long, duration: 2 }]);
    expect(cues.length).toBeGreaterThan(2);
    expect(cues[0].start).toBeGreaterThanOrEqual(0);
    expect(cues[cues.length - 1].end).toBeLessThanOrEqual(2 + 1e-6);
  });

  it("空段列表返回空", () => {
    expect(planSubtitleCues([])).toEqual([]);
    expect(planSubtitleCues([{ dialogue: null, duration: 5 }])).toEqual([]);
  });
});
