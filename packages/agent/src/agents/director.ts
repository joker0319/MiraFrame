import { BaseAgent, type AgentContext } from "./base.js";
import type { Phase2StateType } from "../state.js";
import { DIRECTOR_SYSTEM_PROMPT, DIRECTOR_FEEDBACK_PROMPT } from "../prompts/director.js";

/**
 * 可编排的阶段白名单 —— Director 只能从中挑选，保证不会发明新阶段，
 * 也不会选中没有被图实现的阶段（这是"动态化但守住恢复机制"的关键约束）。
 */
const ALLOWED_STAGES = [
  "plan_outline",
  "plan_characters",
  "plan_shots",
  "critique_shots",
  "render_shot_images",
  "compose_videos",
] as const;

type AllowedStage = (typeof ALLOWED_STAGES)[number];

const ALLOWED_SET = new Set<string>(ALLOWED_STAGES);

/** 默认全链路：任何解析失败时都退回到这条久经考验的路径 */
const DEFAULT_PLAN: AllowedStage[] = [
  "plan_outline",
  "plan_characters",
  "plan_shots",
  "critique_shots",
  "render_shot_images",
  "compose_videos",
];

export interface DirectorPlan {
  steps: AllowedStage[];
  rationale: string;
}

/** 从 LLM 回复里抠出 JSON（兼容 ```json 围栏与前后解释文字） */
export function parseDirectorPlan(raw: string): DirectorPlan {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Director 回复中没有 JSON");
  const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
  return { steps: rawSteps.filter((s): s is AllowedStage => typeof s === "string"), rationale };
}

/**
 * 校验并规范化计划 —— Supervisor 的安全带。
 *
 * 设计取舍：为了不击穿 4 个审批门与 checkpoint 恢复机制，模型只能裁剪
 * plan_characters（"短篇跳过角色图阶段"）；大纲、质检、渲染、成片是质量
 * 与交付的必需环节，强制保留。这样动态路由只需处理一个分支点，图的其余
 * 部分完全不动 —— 这是"能动态但不失控"的关键。
 */
export function validatePlan(parsed: DirectorPlan): DirectorPlan {
  const seen = new Set<string>();
  const steps: AllowedStage[] = parsed.steps.filter((stage) => {
    if (!ALLOWED_SET.has(stage) || seen.has(stage)) return false;
    seen.add(stage);
    return true;
  });

  // 必需阶段：模型漏写会被补回；plan_characters 是唯一可裁剪项。
  const required: AllowedStage[] = ["plan_outline", "critique_shots", "render_shot_images", "compose_videos"];
  const present = new Set<AllowedStage>(steps);
  // 至少要有一个创作阶段，否则视为无效计划
  const hasGenerate = steps.some((s) => s === "plan_outline" || s === "plan_shots" || s === "plan_characters");
  if (!hasGenerate) {
    return { steps: [...DEFAULT_PLAN], rationale: parsed.rationale || "计划无效，回退默认全链路" };
  }
  for (const stage of required) if (!present.has(stage)) steps.push(stage);

  // 按流水线顺序重排（用最终 steps 集合），compose_videos 自然落在末尾
  const finalSet = new Set<AllowedStage>(steps);
  return {
    steps: [...DEFAULT_PLAN].filter((s) => finalSet.has(s)),
    rationale: parsed.rationale,
  };
}

/** 默认计划（供测试与兜底复用） */
export function defaultPlan(): DirectorPlan {
  return { steps: [...DEFAULT_PLAN], rationale: "默认全链路" };
}

/**
 * DirectorAgent（Supervisor）：把"下一步走哪"的决策权从 graph.ts 的代码
 * 转移到模型。开工前生成执行计划，反馈时重新规划；计划写入 state 后由
 * 条件路由消费。4 个审批门与 interrupt 恢复机制保持不变。
 */
export class DirectorAgent extends BaseAgent {
  constructor() {
    super("director");
  }

  async plan(ctx: AgentContext, state: Phase2StateType): Promise<Partial<Phase2StateType>> {
    const isFeedback = Boolean(state.feedback && state.feedback.trim());

    await ctx.sendThinking("planning", "正在规划本轮执行路径...");

    let plan: DirectorPlan;
    try {
      const systemPrompt = DIRECTOR_SYSTEM_PROMPT;
      const userPrompt = isFeedback
        ? DIRECTOR_FEEDBACK_PROMPT.replace("{feedback}", state.feedback || "")
            .replace("{entityType}", state.entityType || "未指定")
            .replace("{feedbackType}", state.feedbackType || "未指定")
        : "请根据当前项目输入生成本轮执行计划。";

      const raw = await this.callLlm(ctx, systemPrompt, userPrompt, {
        maxTokens: 1024,
        intent: "director-plan",
      });
      plan = validatePlan(parseDirectorPlan(raw));
    } catch (err) {
      console.warn("[Director] 计划生成失败，回退默认链路:", err instanceof Error ? err.message : err);
      plan = defaultPlan();
    }

    await ctx.sendThinking(
      "planning",
      `执行计划：${plan.steps.join(" → ")}`,
      plan.rationale,
    );
    await ctx.sendMessage(`已规划执行路径：${plan.steps.length} 个阶段`, {
      stage: "director",
      summary: plan.rationale,
    });

    return {
      executionPlan: plan.steps,
      planRationale: plan.rationale,
    };
  }
}
