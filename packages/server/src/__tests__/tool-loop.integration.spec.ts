import { describe, it, expect } from "vitest";
import { TextService } from "../services/text.service.js";
import { createOutlineToolKit, runToolLoop } from "@miraframe/agent";

/**
 * 端到端验证工具循环：fake provider 模拟模型决策，
 * 真实走完 TextService → ToolLoop → ToolRegistry → ctx.saveOutline。
 */
describe("ToolLoop × fake provider 集成", () => {
  it("模型自主完成 写草稿 → 落库 → 收尾 三轮决策", async () => {
    const config = { get: (key: string) => (key === "app.textProvider" ? "fake" : undefined) } as never;
    const textService = new TextService(config);

    const saved: Array<{ outline: Record<string, unknown>; visualBible: string | null | undefined }> = [];
    const ctx = {
      projectId: 1,
      runId: 1,
      threadId: "integration",
      sendMessage: async () => {},
      sendThinking: async () => {},
      callLlm: async () => "{}",
      callLlmWithTools: async (messages: never[], tools: never[], opts: never) =>
        textService.generateWithTools(messages, tools, opts),
      saveOutline: async (outline: Record<string, unknown>, visualBible?: string | null) => {
        saved.push({ outline, visualBible });
      },
      createCharacter: async () => ({ id: 0 }),
      createShot: async () => ({ id: 0 }),
      generateCharacterImage: async () => {},
      generateShotFrames: async () => {},
      generateShotVideos: async () => {},
      composeProjectVideo: async () => {},
    } as never;

    const kit = createOutlineToolKit(ctx);
    const result = await runToolLoop({
      ctx,
      registry: kit.registry,
      system: "你是专业编剧，必须使用工具完成大纲。",
      user: "写一个关于雨夜星灯的故事",
      intent: "outline",
    });

    expect(result.usedNative).toBe(true);
    expect(result.toolCalls).toEqual(["write_outline_draft(ok)", "save_outline(ok)"]);
    expect(kit.trace).toEqual(["write_outline_draft(draft-1)", "save_outline(draft-1)"]);
    expect(saved).toHaveLength(1);
    expect(saved[0].outline.title).toBe("雨夜星灯");
    expect(saved[0].visualBible).toContain("治愈系");
  });
});
