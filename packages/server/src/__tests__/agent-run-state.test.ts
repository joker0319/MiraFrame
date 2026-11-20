import { describe, it, expect } from "vitest";
import { buildConversationHistory, type ConversationMessage } from "../agent/agent-run-state.js";

function msg(
  agent: string,
  role: string,
  content: string,
  summary: string | null = null,
  day = 1,
): ConversationMessage {
  return {
    agent,
    role,
    content,
    summary,
    createdAt: new Date(`2026-01-${String(day).padStart(2, "0")}T00:00:00Z`),
  };
}

describe("buildConversationHistory", () => {
  it("没有用户反馈时返回空字符串，不污染 prompt", () => {
    expect(buildConversationHistory([msg("system", "assistant", "开始生成", "任务启动")])).toBe("");
  });

  it("把反馈与系统摘要配成轮次，并排除当前轮避免重复注入", () => {
    const history = buildConversationHistory(
      [
        msg("user", "user", "第一版要冷色调"),
        msg("system", "assistant", "正在生成大纲的正文内容...", "大纲生成完成"),
        msg("user", "user", "把主角改回第一版但保留结尾"),
      ],
      { excludeLatestUser: true },
    );

    expect(history).toContain("第 1 轮");
    expect(history).toContain("第一版要冷色调");
    expect(history).toContain("系统回应摘要：大纲生成完成");
    expect(history).not.toContain("正在生成大纲的正文内容");
    expect(history).not.toContain("把主角改回第一版");
    expect(history).toContain("否定式或指代性表达");
  });

  it("保留原始轮次号，让模型能理解「第二版」这类指代", () => {
    const messages = [
      msg("user", "user", "第一稿", null, 1),
      msg("user", "user", "第二稿", null, 2),
      msg("user", "user", "第三稿", null, 3),
      msg("user", "user", "第四稿", null, 4),
      msg("user", "user", "第五稿（当前）", null, 5),
    ];
    const history = buildConversationHistory(messages, { excludeLatestUser: true, maxRounds: 2 });

    expect(history).toContain("第 3 轮");
    expect(history).toContain("第 4 轮");
    expect(history).not.toContain("第 1 轮");
    expect(history).not.toContain("第五稿（当前）");
  });

  it("同一轮多次播报时只取最后一条摘要", () => {
    const history = buildConversationHistory([
      msg("user", "user", "改一下分镜"),
      msg("system", "assistant", "...", "开始生成分镜"),
      msg("system", "assistant", "...", "分镜生成完成"),
    ]);

    expect(history).toContain("系统回应摘要：分镜生成完成");
    expect(history).not.toContain("开始生成分镜");
  });

  it("反馈过长和总量过大时截断，避免爆 token", () => {
    const longFeedback = "很长的一段反馈".repeat(100);
    const history = buildConversationHistory([msg("user", "user", longFeedback)], { maxChars: 300 });

    expect(history.length).toBeLessThan(400);
    expect(history).toContain("历史已截断");
    expect(history).toContain("否定式或指代性表达");
  });

  it("只有当前一轮且要求排除时，仍保留该轮（避免模型完全失去上下文）", () => {
    const history = buildConversationHistory([msg("user", "user", "唯一一条反馈")], { excludeLatestUser: true });
    expect(history).toContain("唯一一条反馈");
  });
});
