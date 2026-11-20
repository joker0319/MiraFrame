import type { AgentContext } from "../agents/base.js";
import { ToolRegistry } from "./registry.js";
import type { AgentTool } from "./types.js";

const OUTLINE_INPUT_SCHEMA = {
  type: "object" as const,
  description: "完整故事大纲，键名与编剧规范一致（logline / genre / themes / setting / tone / visual_bible / acts / emotional_arc）",
  properties: {
    logline: { type: "string", description: "一句话梗概" },
    genre: { type: "array", items: { type: "string" }, description: "题材标签" },
    themes: { type: "array", items: { type: "string" }, description: "主题词" },
    setting: { type: "string", description: "世界观与背景设定" },
    tone: { type: "string", description: "故事基调" },
    visual_bible: { type: "string", description: "视觉风格描述" },
    acts: {
      type: "array",
      description: "剧情分幕，每幕含 act / title / summary",
      items: {
        type: "object",
        properties: {
          act: { type: "number" },
          title: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
    emotional_arc: { type: "string", description: "情感弧线" },
  },
  additionalProperties: true,
};

export interface OutlineToolKit {
  registry: ToolRegistry;
  /** 工具执行轨迹，用于前端展示"模型做了什么决策" */
  trace: string[];
  getDraft: () => Record<string, unknown> | null;
  getSavedOutline: () => Record<string, unknown> | null;
  getVisualBible: () => string | null;
}

interface Draft {
  id: string;
  outline: Record<string, unknown>;
  note?: string;
}

/**
 * 大纲阶段给模型用的工具集。
 *
 * 关键变化：过去 OutlineAgent 里 hardcode 了"生成 → 解析 → 落库"三步；
 * 现在这三步变成模型可以自主选择和排序的工具，节点只提供能力、不做调度。
 */
export function createOutlineToolKit(ctx: Pick<AgentContext, "saveOutline" | "sendMessage">): OutlineToolKit {
  const drafts: Draft[] = [];
  const trace: string[] = [];
  let savedOutline: Record<string, unknown> | null = null;
  let savedVisualBible: string | null = null;

  const resolveOutline = (value: unknown): Record<string, unknown> => {
    if (typeof value === "string") {
      const parsed = JSON.parse(extractJson(value)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("大纲必须是 JSON 对象");
      }
      return parsed as Record<string, unknown>;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("大纲必须是 JSON 对象");
    }
    return value as Record<string, unknown>;
  };

  const writeDraft: AgentTool = {
    definition: {
      name: "write_outline_draft",
      description:
        "把一份故事大纲草稿写入工作区并返回 draftId。你可以多次调用来修订草稿；只有调用 save_outline 才会真正落库。",
      inputSchema: {
        type: "object",
        properties: {
          outline: OUTLINE_INPUT_SCHEMA,
          note: { type: "string", description: "本次修订说明，可选" },
        },
        required: ["outline"],
        additionalProperties: false,
      },
    },
    execute: async (args) => {
      const outline = resolveOutline(args.outline);
      const id = `draft-${drafts.length + 1}`;
      drafts.push({ id, outline, note: typeof args.note === "string" ? args.note : undefined });
      trace.push(`write_outline_draft(${id})`);
      const title = typeof outline.title === "string" ? outline.title : "";
      return `草稿已记录：${id}${title ? `，标题「${title}」` : ""}。你可以继续修订，或调用 save_outline(draftId="${id}") 落库。`;
    },
  };

  const saveOutlineTool: AgentTool = {
    definition: {
      name: "save_outline",
      description:
        "把指定草稿正式保存为项目故事大纲，并通知前端。这是大纲阶段唯一的落库入口，必须在 write_outline_draft 之后调用。",
      inputSchema: {
        type: "object",
        properties: {
          draftId: { type: "string", description: "要保存的草稿 ID；不传则保存最新草稿" },
          visual_bible: { type: "string", description: "可选的视觉风格覆盖值" },
        },
        additionalProperties: false,
      },
    },
    execute: async (args) => {
      if (drafts.length === 0) {
        throw new Error("工作区还没有草稿，请先调用 write_outline_draft");
      }
      const requestedId = typeof args.draftId === "string" ? args.draftId : null;
      const draft = requestedId ? drafts.find((item) => item.id === requestedId) : drafts[drafts.length - 1];
      if (!draft) {
        throw new Error(`找不到草稿 ${requestedId}，可用：${drafts.map((item) => item.id).join(", ")}`);
      }

      const outline = draft.outline;
      const bible =
        typeof args.visual_bible === "string" && args.visual_bible.trim()
          ? args.visual_bible
          : typeof outline.visual_bible === "string"
            ? outline.visual_bible
            : typeof outline.visualBible === "string"
              ? outline.visualBible
              : null;

      await ctx.saveOutline(outline, bible);
      savedOutline = outline;
      savedVisualBible = bible;
      trace.push(`save_outline(${draft.id})`);
      return `大纲已保存并推送前端（来源 ${draft.id}）。`;
    },
  };

  const reportProgress: AgentTool = {
    definition: {
      name: "report_progress",
      description: "向用户播报当前进度或决策理由。适合在关键决策前调用，让用户看得见模型在做什么。",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "要播报的中文消息" },
          progress: { type: "number", description: "可选，0~1 的进度值" },
        },
        required: ["message"],
        additionalProperties: false,
      },
    },
    execute: async (args) => {
      const message = typeof args.message === "string" ? args.message : "";
      if (!message) throw new Error("message 不能为空");
      const progress = typeof args.progress === "number" ? args.progress : undefined;
      await ctx.sendMessage(message, { progress, stage: "plan_outline" });
      trace.push(`report_progress(${message.slice(0, 24)})`);
      return "已向用户播报。";
    },
  };

  const registry = new ToolRegistry().register(writeDraft).register(saveOutlineTool).register(reportProgress);

  return {
    registry,
    trace,
    getDraft: () => (drafts.length ? drafts[drafts.length - 1].outline : null),
    getSavedOutline: () => savedOutline,
    getVisualBible: () => savedVisualBible,
  };
}

function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const braces = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  return braces ? braces[1].trim() : text.trim();
}
