import { BaseAgent, type AgentContext } from "./base.js";
import type { Phase2StateType } from "../state.js";
import { REVIEW_ROUTE_SYSTEM_PROMPT, REVIEW_ROUTE_USER_PROMPT } from "../prompts/review-route.js";

/**
 * 阶段 → 回退目标的规则映射。
 * 它的角色从"决策者"降级为"模型失效时的兜底 + 模型输出的白名单"。
 */
const FALLBACK_ROUTE: Record<string, string> = {
  outline_approval: "plan_outline",
  characters_approval: "plan_characters",
  shots_approval: "plan_shots",
  shot_images_approval: "render_shot_images",
};

export const VALID_TARGETS = new Set([
  "plan_outline",
  "plan_characters",
  "plan_shots",
  "render_shot_images",
  "compose_videos",
]);

interface RouteDecision {
  targetStage?: string;
  mode?: string;
  rationale?: string;
}

/** 从 LLM 回复里抠 JSON，兼容 ```json 围栏 */
export function parseRouteDecision(raw: string): RouteDecision {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Review 回复中没有 JSON");
  return JSON.parse(text.slice(start, end + 1)) as RouteDecision;
}

/**
 * ReviewAgent（原 ReviewRuleEngine）：把用户反馈路由回合适的阶段。
 *
 * 升级点：回退目标不再由 currentStage 查表写死，而是由模型根据反馈内容
 * 自主决定；查表结果只在模型失效时兜底。这让"改完回哪"成为模型决策。
 */
export class ReviewRuleEngine extends BaseAgent {
  constructor() {
    super("review");
  }

  async run(ctx: AgentContext, state: Phase2StateType): Promise<Partial<Phase2StateType>> {
    await this.sendMessage(ctx, "正在处理反馈...", { isLoading: true });

    const fallbackTarget = FALLBACK_ROUTE[state.currentStage] || "plan_outline";
    let targetStage = fallbackTarget;
    let routeMode: "full" | "incremental" = "incremental";
    let rationale = "按默认规则回退";

    try {
      const userPrompt = REVIEW_ROUTE_USER_PROMPT.replace(
        "{currentStage}",
        state.currentStage || "",
      )
        .replace("{feedbackType}", state.feedbackType || "未指定")
        .replace("{feedback}", state.feedback || "无具体反馈");

      const raw = await this.callLlm(ctx, REVIEW_ROUTE_SYSTEM_PROMPT, userPrompt, {
        maxTokens: 512,
        intent: "review-route",
      });
      const decision = parseRouteDecision(raw);
      if (decision.targetStage && VALID_TARGETS.has(decision.targetStage)) {
        targetStage = decision.targetStage;
        routeMode = decision.mode === "full" ? "full" : "incremental";
        rationale = decision.rationale || "由导演根据反馈决策";
        await this.sendThinking(
          ctx,
          "decision",
          `根据反馈回到 ${targetStage}（${routeMode}）`,
          rationale,
        );
      }
    } catch (err) {
      console.warn("[Review] 模型路由失败，回退规则:", err instanceof Error ? err.message : err);
    }

    return {
      currentStage: "review",
      routeStage: targetStage as Partial<Phase2StateType>["routeStage"],
      routeMode,
    };
  }
}
