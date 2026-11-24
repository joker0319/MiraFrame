import { describe, expect, it } from "vitest";
import type { AgentContext } from "../agents/base.js";
import { createOutlineToolKit, runToolLoop } from "../tools/index.js";
import { createAssetsToolKit } from "../tools/mcp/index.js";

/**
 * 最有说服力的一条：Agent 真的通过 MCP 工具拿到项目里的真实文件，再据此完成大纲。
 *
 * 链路全程真实，只有「模型决策」是预设的 tool_calls：
 *   ToolLoop → ToolRegistry → MCP client（JSON-RPC over stdio）
 *   → 子进程 server → 真实文件系统 → 结果回填 messages → 模型继续
 */
describe("ToolLoop × MCP 工具", () => {
  it("模型先查真实素材、再写大纲落库，且工具结果确实回填给了模型", async () => {
    const saved: Array<Record<string, unknown>> = [];
    const modelSaw: string[] = [];
    const offeredTools: string[][] = [];
    let round = 0;

    const ctx = {
      projectId: 1,
      runId: 1,
      threadId: "mcp-loop",
      sendMessage: async () => {},
      sendThinking: async () => {},
      callLlm: async () => "{}",
      callLlmWithTools: async (messages: Array<{ role: string; content: string }>, tools: Array<{ name: string }>) => {
        offeredTools.push(tools.map((tool) => tool.name));
        // 把模型「看到的」全部记下来，用于断言工具结果真的进了上下文
        modelSaw.push(messages.map((message) => message.content).join("\n"));

        round += 1;
        if (round === 1) {
          return {
            content: "",
            toolCalls: [{ id: "call-1", name: "list_project_assets", arguments: { path: "docs" } }],
          };
        }
        if (round === 2) {
          return {
            content: "",
            toolCalls: [
              {
                id: "call-2",
                name: "write_outline_draft",
                arguments: {
                  outline: { title: "参考素材大纲", logline: "测试 MCP 回填", acts: [{ act: 1, title: "起", summary: "开场" }] },
                },
              },
            ],
          };
        }
        if (round === 3) {
          return { content: "", toolCalls: [{ id: "call-3", name: "save_outline", arguments: {} }] };
        }
        return { content: "大纲已完成", toolCalls: [] };
      },
      saveOutline: async (outline: Record<string, unknown>) => {
        saved.push(outline);
      },
      createCharacter: async () => ({ id: 0 }),
      createShot: async () => ({ id: 0 }),
      generateCharacterImage: async () => {},
      generateShotFrames: async () => {},
      generateShotVideos: async () => {},
      composeProjectVideo: async () => {},
    } as unknown as AgentContext;

    const assets = await createAssetsToolKit({ enabled: true });
    expect(assets, "MCP server 应该能拉起").not.toBeNull();

    const kit = createOutlineToolKit(ctx);
    for (const tool of assets!.tools) kit.registry.register(tool);

    try {
      const result = await runToolLoop({
        ctx,
        registry: kit.registry,
        system: "你是专业编剧，可以先用素材工具了解项目里已有的参考资料。",
        user: "写一个关于雨夜星灯的故事",
        intent: "outline",
        maxRounds: 6,
      });

      // 1. 本地工具与 MCP 工具同时出现在模型可见的工具清单里
      expect(offeredTools[0]).toEqual(
        expect.arrayContaining(["write_outline_draft", "save_outline", "list_project_assets"]),
      );
      expect(offeredTools[0]).toContain("read_text_asset");

      // 2. 远端工具被真实执行，并按本地工具的约定记录轨迹
      expect(result.toolCalls).toEqual([
        "list_project_assets(ok)",
        "write_outline_draft(ok)",
        "save_outline(ok)",
      ]);

      // 3. 工具返回值真的回填进了下一轮模型上下文（不是被丢弃）
      expect(modelSaw[1]).toContain("architecture-walkthrough.md");
      expect(modelSaw[1]).toContain("docs");

      // 4. 主流程照常落库
      expect(saved).toHaveLength(1);
      expect(saved[0].title).toBe("参考素材大纲");
    } finally {
      await assets!.close();
    }
  }, 30000);

  it("MCP 不可用时同一套节点代码照常跑（降级不影响主流程）", async () => {
    const kit = createOutlineToolKit({
      saveOutline: async () => {},
      sendMessage: async () => {},
    });
    expect(kit.registry.names()).toEqual(["write_outline_draft", "save_outline", "report_progress"]);
    expect(await createAssetsToolKit({ enabled: false })).toBeNull();
  });
});
