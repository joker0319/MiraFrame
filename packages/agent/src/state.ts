import { Annotation } from "@langchain/langgraph";
import type { Phase2Stage } from "@miraframe/shared";

export const Phase2State = Annotation.Root({
  projectId: Annotation<string>(),
  runId: Annotation<string>(),
  threadId: Annotation<string>(),
  currentStage: Annotation<Phase2Stage>(),
  nextStage: Annotation<Phase2Stage | null>(),
  stageHistory: Annotation<string[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  approvalHistory: Annotation<Record<string, string>>(),
  critiqueScores: Annotation<Record<string, number>>(),
  critiqueRound: Annotation<number>(),
  /** 最近一次生成的产物文本（供 CriticAgent 审查）：分镜阶段由 PlanAgent 写入 */
  artifactText: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  artifactLineage: Annotation<Record<string, string[]>>(),
  /** Director（Supervisor）生成的执行计划：本轮要执行的阶段序列，白名单受控 */
  executionPlan: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  /** Director 的决策理由，前端可视化 */
  planRationale: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  routeStage: Annotation<string | null>(),
  routeMode: Annotation<"full" | "incremental">(),
  feedback: Annotation<string | null>(),
  feedbackType: Annotation<string | null>(),
  entityType: Annotation<string | null>(),
  entityId: Annotation<number | null>(),
  revisionMode: Annotation<"stage" | "asset" | null>(),
});

export type Phase2StateType = typeof Phase2State.State;
