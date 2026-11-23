import { describe, expect, it } from "vitest";
import { inferVoiceGender, parseDialogue, planDialogue, resolveVoice } from "../services/dialogue";

describe("parseDialogue", () => {
  it("拆出两个说话人，剥离语气与引号", () => {
    const lines = parseDialogue(
      "沈鸢（轻声）：『字条上写的是你……你是来找人说话的？』阿砚（迷茫）：『我……只想把那句话说完。』",
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ speaker: "沈鸢", tone: "轻声", text: "字条上写的是你……你是来找人说话的？" });
    expect(lines[1]).toMatchObject({ speaker: "阿砚", tone: "迷茫", text: "我……只想把那句话说完。" });
    // 角色名与舞台指示绝不能进入 TTS 文本
    expect(lines[0].text).not.toContain("沈鸢");
    expect(lines[0].text).not.toContain("轻声");
  });

  it("无台词的音效描述不产生配音", () => {
    expect(parseDialogue("无台词，只有轻微的布料摩擦声与窗外隐约的风声。")).toEqual([]);
    expect(parseDialogue("无台词。只有风吹过风筝线轴的声音，以及远处孩童隐约的笑声。")).toEqual([]);
  });

  it("支持画外音/闪回这类复合提示", () => {
    const lines = parseDialogue("祖母（画外音/闪回）：『鸢不在留，在放。』沈鸢（低声自语）：『我明白……不是替你说尽遗憾，是让我学会放下。』");
    expect(lines).toHaveLength(2);
    expect(lines[0].tone).toBe("画外音/闪回");
    expect(lines[0].text).toBe("鸢不在留，在放。");
  });

  it("去掉台词前的动作提示括号", () => {
    const lines = parseDialogue("阿砚（对着江流/天空，轻声而清晰）：『娘，爸……我听见了。』");
    expect(lines[0].text).toBe("娘，爸……我听见了。");
  });

  it("名字后没有语气括号也能解析", () => {
    const lines = parseDialogue("沈鸢：『去吧，阿砚。』");
    expect(lines[0]).toMatchObject({ speaker: "沈鸢", tone: null, text: "去吧，阿砚。" });
  });

  it("镜头说明里的冒号不会被当成说话人", () => {
    const lines = parseDialogue("画面：江水缓缓流动。沈鸢：『起风了。』");
    expect(lines.map((line) => line.speaker)).toEqual(["沈鸢"]);
  });

  it("完全无格式的文本按旁白处理", () => {
    const lines = parseDialogue("临安城的雨落了整夜。");
    expect(lines).toHaveLength(1);
    expect(lines[0].speaker).toBe("旁白");
    expect(lines[0].text).toBe("临安城的雨落了整夜。");
  });

  it("空值与空串安全返回", () => {
    expect(parseDialogue(null)).toEqual([]);
    expect(parseDialogue("   ")).toEqual([]);
  });
});

describe("音色分配", () => {
  it("按名字与描述推断性别年龄", () => {
    expect(inferVoiceGender("祖母")).toBe("oldFemale");
    expect(inferVoiceGender("爷爷")).toBe("oldMale");
    expect(inferVoiceGender("沈鸢")).toBe("youngFemale");
    expect(inferVoiceGender("阿砚")).toBe("youngMale");
    expect(inferVoiceGender("旁白")).toBe("narrator");
  });

  it("描述可补足名字里没有的性别信息", () => {
    expect(inferVoiceGender("阿鸢", "临安纸鸢铺的少女")).toBe("youngFemale");
    expect(inferVoiceGender("无名", "披甲的少年将军")).toBe("youngMale");
  });

  it("同一角色多次调用得到同一音色", () => {
    const a = resolveVoice("沈鸢", null);
    const b = resolveVoice("沈鸢", "轻声");
    expect(a.voice).toBe(b.voice);
  });

  it("显式映射优先级最高", () => {
    const voice = resolveVoice("沈鸢", "轻声", { voiceMap: { 沈鸢: "Tingting" } });
    expect(voice.voice).toBe("Tingting");
  });

  it("轻声会放慢语速并降低音量，喊叫反之", () => {
    const soft = resolveVoice("沈鸢", "轻声");
    const shout = resolveVoice("沈鸢", "大喊");
    expect(soft.rate).toBeLessThan(shout.rate);
    expect(soft.volume).toBeLessThan(shout.volume);
  });

  it("音色名带语言后缀，避免 say 选到英文版", () => {
    const { voice } = resolveVoice("沈鸢", null);
    expect(voice === "Tingting" || voice.includes("中文")).toBe(true);
  });
});

describe("planDialogue", () => {
  it("给每句台词绑定音色", () => {
    const plan = planDialogue("沈鸢（轻声）：『你来了。』阿砚：『嗯。』");
    expect(plan).toHaveLength(2);
    expect(plan[0].voice.voice).toContain("中文");
    expect(plan[0].voice.rate).toBeGreaterThan(0);
  });
});
