import { BaseAgent, type AgentContext } from "./base.js";
import type { Phase2StateType } from "../state.js";
import { SHOT_CRITIC_PROMPT } from "../prompts/critic.js";

/**
 * 自动审查阈值与轮次上限。
 * 用环境变量可调，方便不同项目/模型下微调，不必改代码。
 */
const SCORE_THRESHOLD = Number(process.env.CRITIC_SCORE_THRESHOLD ?? 7);
const MAX_ROUNDS = Number(process.env.CRITIC_MAX_ROUNDS ?? 2);

interface CritiqueResult {
  overall_score: number;
  dimensions?: Record<string, number>;
  issues: string[];
  suggestions: string[];
  needs_regenerate?: boolean;
}

/** 从 LLM 回复里抠出 JSON —— 模型经常包 ```json 围栏或加解释文字 */
function parseCritique(raw: string): CritiqueResult {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("LLM 回复中没有 JSON");
  const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<CritiqueResult>;
  return {
    overall_score: Number(parsed.overall_score ?? 0),
    dimensions: parsed.dimensions,
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    needs_regenerate: parsed.needs_regenerate === true,
  };
}

/** 把审查意见拼成一段可以直接喂给生成节点的反馈 */
function buildFeedback(result: CritiqueResult): string {
  const lines: string[] = ["自动审查未通过，请按以下意见修改分镜："];
  if (result.issues.length) lines.push("问题：", ...result.issues.map((i) => `- ${i}`));
  if (result.suggestions.length) lines.push("建议：", ...result.suggestions.map((s) => `- ${s}`));
  return lines.join("\n");
}

/**
 * CriticAgent：对分镜脚本做自动化质量审查。
 *
 * 这是把它从"工作流"变成"Agent"的关键一环：
 * 路由不再只由人（审批按钮）或外部参数决定，而是由模型对产物的评估结果决定。
 */
export class CriticAgent extends BaseAgent {
  constructor() {
    super("critic");
  }

  async critiqueShots(
    ctx: AgentContext,
    state: Phase2StateType,
  ): Promise<Partial<Phase2StateType>> {
    const round = (state.critiqueRound || 0) + 1;

    await ctx.sendMessage(`正在进行分镜自动审查（第 ${round} 轮）...`, {
      progress: 0.58,
      isLoading: true,
      stage: "critique_shots",
    });
    await ctx.sendThinking(
      "reviewing",
      "从叙事、连贯性、镜头语言、可生成性四个维度评估分镜脚本...",
    );

    const artifact = (state.artifactText || "").trim();

    // 没有产物可审（例如从中间阶段恢复运行）→ 不阻断流程，直接转人工审批
    if (!artifact) {
      await ctx.sendMessage("没有可审查的分镜内容，跳过自动审查", { stage: "critique_shots" });
      return {
        currentStage: "critique_shots",
        nextStage: "shots_approval",
        stageHistory: ["critique_shots"],
        critiqueRound: round,
      };
    }

    let result: CritiqueResult;
    try {
      const raw = await ctx.callLlm(
        SHOT_CRITIC_PROMPT,
        `请审查以下分镜脚本：\n\n${artifact}`,
        { maxTokens: 1024, intent: "critique_shots" },
      );
      result = parseCritique(raw);
    } catch (err) {
      // 审查本身失败（调用超时 / 返回格式坏）不能卡死主流程：
      // 降级为"转人工审批"，由人来兜底。这是自动化环节的通用设计原则。
      console.warn("[CriticAgent] 自动审查失败，降级为人工审批：", err);
      await ctx.sendMessage("自动审查不可用，已转人工确认", { stage: "critique_shots" });
      return {
        currentStage: "critique_shots",
        nextStage: "shots_approval",
        stageHistory: ["critique_shots"],
        critiqueRound: round,
      };
    }

    const score = Math.max(0, Math.min(10, result.overall_score || 0));
    const passed = score >= SCORE_THRESHOLD || round >= MAX_ROUNDS;
    const critiqueScores = {
      ...(state.critiqueScores || {}),
      [`shots_round_${round}`]: score,
    };

    await ctx.sendMessage(
      passed
        ? `分镜自动审查通过：${score.toFixed(1)} 分`
        : `分镜自动审查未通过：${score.toFixed(1)} 分（阈值 ${SCORE_THRESHOLD}），将带着意见重写`,
      {
        progress: 0.6,
        summary: result.issues.length ? `发现 ${result.issues.length} 个问题` : undefined,
        stage: "critique_shots",
      },
    );

    return {
      currentStage: "critique_shots",
      // 路由决策在这里产生：通过 → 人工确认；不通过且未超轮次 → 回到 plan_shots 重写
      nextStage: passed ? "shots_approval" : "plan_shots",
      stageHistory: ["critique_shots"],
      critiqueScores,
      critiqueRound: round,
      // 不通过时，把意见写进 feedback —— PlanAgent.runShots 已经在读这个字段
      ...(passed
        ? { feedback: null, feedbackType: null }
        : { feedback: buildFeedback(result), feedbackType: "critique" }),
    };
  }
}
