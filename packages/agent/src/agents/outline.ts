import { BaseAgent, type AgentContext } from "./base.js";
import type { Phase2StateType } from "../state.js";
import { OUTLINE_FEEDBACK_PROMPT, OUTLINE_SYSTEM_PROMPT } from "../prompts/outline.js";
import { createOutlineToolKit, runToolLoop } from "../tools/index.js";
import { createAssetsToolKit } from "../tools/mcp/index.js";

export class OutlineAgent extends BaseAgent {
  constructor() {
    super("outline");
  }

  async run(ctx: AgentContext, state: Phase2StateType): Promise<Partial<Phase2StateType>> {
    await this.sendMessage(ctx, "开始生成故事大纲...", { progress: 0.05, isLoading: true, stage: "plan_outline" });
    await this.sendThinking(ctx, "planning", "分析故事要素：主题、世界观、情感弧线...");

    const userPrompt = state.feedback
      ? OUTLINE_FEEDBACK_PROMPT
        .replace("{originalOutline}", "请参考项目上下文中的 Approved outline JSON；如果没有原大纲，则根据 Story brief 生成。")
        .replace("{feedback}", state.feedback)
      : "请根据提供的故事创想生成一份详细的故事大纲。必须全部使用中文输出。";

    const toolkit = createOutlineToolKit(ctx);

    // MCP 素材库工具是可选增强：拉不起子进程就直接跳过，大纲生成照常进行。
    // 注册进同一个 registry 后，模型能在写大纲前自主查看项目里真实存在的参考素材。
    const assets = await createAssetsToolKit();
    if (assets) {
      for (const tool of assets.tools) {
        if (toolkit.registry.has(tool.definition.name)) {
          console.warn(`[OutlineAgent] MCP 工具 ${tool.definition.name} 与本地工具重名，保留本地实现`);
          continue;
        }
        try {
          toolkit.registry.register(tool);
        } catch (error) {
          console.warn(
            `[OutlineAgent] MCP 工具注册失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    let loop: Awaited<ReturnType<typeof runToolLoop>>;
    try {
      loop = await runToolLoop({
        ctx,
        registry: toolkit.registry,
        system: OUTLINE_SYSTEM_PROMPT,
        user: userPrompt,
        intent: "outline",
        maxRounds: 6,
        onCall: async (call, result) => {
          await this.sendThinking(
            ctx,
            "decision",
            `模型决定调用工具 ${call.name}`,
            result.substring(0, 300),
          );
        },
      });
    } finally {
      await assets?.close();
    }

    // 模型通过工具落库；若它没遵守协议直接返回了大纲 JSON，保留旧的兜底解析路径
    let storyOutline = toolkit.getSavedOutline();
    let visualBible = toolkit.getVisualBible();
    if (!storyOutline) {
      console.warn("[OutlineAgent] 模型未完成 save_outline，使用文本结果兜底");
      try {
        storyOutline = JSON.parse(extractJson(loop.finalText)) as Record<string, unknown>;
      } catch {
        storyOutline = { raw: loop.finalText };
      }
      visualBible =
        typeof storyOutline.visual_bible === "string"
          ? storyOutline.visual_bible
          : typeof storyOutline.visualBible === "string"
            ? storyOutline.visualBible
            : null;
      await ctx.saveOutline(storyOutline, visualBible);
    }

    await this.sendMessage(ctx, formatOutlineMessage(storyOutline, visualBible), {
      progress: 0.2,
      summary: "大纲生成完成",
      stage: "plan_outline",
    });

    return {
      currentStage: "plan_outline",
      nextStage: "outline_approval",
      stageHistory: ["plan_outline"],
      reviewRequested: false,
    };
  }
}

function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  const braceMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (braceMatch) return braceMatch[1].trim();

  return text.trim();
}

function formatOutlineMessage(outline: Record<string, unknown>, visualBible?: string | null): string {
  const lines = ["故事大纲已生成"];
  const title = stringValue(outline.title);
  const logline = stringValue(outline.logline || outline.summary);
  const acts = Array.isArray(outline.acts)
    ? outline.acts.map(formatAct)
    : Array.isArray(outline.chapters)
      ? outline.chapters.map(formatAct)
      : [];

  if (title) lines.push(`\n标题：${title}`);
  if (logline) lines.push(`\n一句话梗概：${logline}`);
  if (acts.length) {
    lines.push("\n剧情段落：");
    acts.slice(0, 6).forEach((act, index) => lines.push(`${index + 1}. ${act}`));
  }
  if (visualBible) lines.push(`\n视觉风格：${visualBible}`);

  if (lines.length === 1) lines.push(`\n${JSON.stringify(outline, null, 2)}`);
  return lines.join("\n");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function formatAct(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  const title = stringValue(record.title);
  const summary = stringValue(record.summary || record.description);
  const act = record.act || record.order || record.index;

  if (title && summary) return `${act ? `第${act}幕：` : ""}${title} - ${summary}`;
  if (title) return `${act ? `第${act}幕：` : ""}${title}`;
  if (summary) return summary;
  return JSON.stringify(record);
}
