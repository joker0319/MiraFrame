import { StateGraph, END, START } from "@langchain/langgraph";
import { Phase2State } from "./state.js";
import * as nodes from "./nodes/index.js";

/** LangGraph 的 addConditionalEdges 要求目的地是节点名联合类型，不能用宽泛的 string。 */
type GraphEdgeTarget =
  | "director"
  | "plan_outline"
  | "plan_characters"
  | "plan_shots"
  | "critique_shots"
  | "render_shot_images"
  | "compose_videos"
  | "outline_approval"
  | "characters_approval"
  | "shots_approval"
  | "shot_images_approval"
  | "review";

/**
 * 条件边的目的地登记表。
 *
 * 单独抽出来有两个原因：
 * 1. LangGraph 在运行时才校验「路由函数返回值是不是已登记的目的地」，
 *    以前漏登记 `plan_characters` / `plan_shots` 时，只有真的点「拒绝」或
 *    泛化反馈才跑到一半抛 `Branch condition returned unknown destination`；
 * 2. 抽成常量后测试可以直接断言「所有可能的返回值都在表里」，
 *    把运行时错误提前成结构测试失败。
 */
export const DIRECTOR_ROUTES: Record<string, GraphEdgeTarget> = {
  plan_outline: "plan_outline",
  plan_characters: "plan_characters",
  plan_shots: "plan_shots",
  critique_shots: "critique_shots",
  render_shot_images: "render_shot_images",
  compose_videos: "compose_videos",
  review: "review",
};

export const CRITIQUE_ROUTES: Record<string, GraphEdgeTarget> = {
  shots_approval: "shots_approval",
  plan_shots: "plan_shots",
  review: "review",
};

export const OUTLINE_APPROVAL_ROUTES: Record<string, GraphEdgeTarget> = {
  plan_characters: "plan_characters",
  // Director 可裁掉角色阶段 → 大纲审批后直接进分镜
  plan_shots: "plan_shots",
  plan_outline: "plan_outline",
  review: "review",
};

export const CHARACTERS_APPROVAL_ROUTES: Record<string, GraphEdgeTarget> = {
  // 拒绝角色设定 → 回到角色节点重做，不能漏登记
  plan_characters: "plan_characters",
  plan_shots: "plan_shots",
  review: "review",
};

export const SHOTS_APPROVAL_ROUTES: Record<string, GraphEdgeTarget> = {
  // 拒绝分镜 → 回到分镜节点重写（会再次经过 critique_shots）
  plan_shots: "plan_shots",
  render_shot_images: "render_shot_images",
  review: "review",
};

export const SHOT_IMAGES_APPROVAL_ROUTES: Record<string, GraphEdgeTarget> = {
  compose_videos: "compose_videos",
  render_shot_images: "render_shot_images",
  review: "review",
};

/** review 的合法目标必须与 ReviewRuleEngine 的 VALID_TARGETS 完全一致。 */
export const REVIEW_ROUTES: Record<string, GraphEdgeTarget> = {
  plan_outline: "plan_outline",
  plan_characters: "plan_characters",
  plan_shots: "plan_shots",
  render_shot_images: "render_shot_images",
  compose_videos: "compose_videos",
};

/** 供测试遍历：条件边 source → 目的地表 */
export const ROUTE_DESTINATIONS: Record<string, Record<string, GraphEdgeTarget>> = {
  director: DIRECTOR_ROUTES,
  critique_shots: CRITIQUE_ROUTES,
  outline_approval: OUTLINE_APPROVAL_ROUTES,
  characters_approval: CHARACTERS_APPROVAL_ROUTES,
  shots_approval: SHOTS_APPROVAL_ROUTES,
  shot_images_approval: SHOT_IMAGES_APPROVAL_ROUTES,
  review: REVIEW_ROUTES,
};

export function buildPhase2Graph() {
  const graph = new StateGraph(Phase2State)
    // Supervisor node — plans the execution path before any production work
    .addNode("director", nodes.directorNode)
    // Production nodes
    .addNode("plan_outline", nodes.planOutlineNode)
    .addNode("plan_characters", nodes.planCharactersNode)
    .addNode("plan_shots", nodes.planShotsNode)
    .addNode("critique_shots", nodes.critiqueShotsNode)
    .addNode("render_shot_images", nodes.renderShotImagesNode)
    .addNode("compose_videos", nodes.composeVideosNode)

    // Approval nodes
    .addNode("outline_approval", nodes.outlineApprovalNode)
    .addNode("characters_approval", nodes.charactersApprovalNode)
    .addNode("shots_approval", nodes.shotsApprovalNode)
    .addNode("shot_images_approval", nodes.shotImagesApprovalNode)

    // Review node
    .addNode("review", nodes.reviewNode)

    // Entry point → Director (Supervisor) plans the path first.
    // routeAfterDirector may target any production stage from the plan, so all are mapped.
    .addEdge(START, "director")
    .addConditionalEdges("director", nodes.routeAfterDirector, DIRECTOR_ROUTES)

    // Production → Approval linear flow
    .addEdge("plan_outline", "outline_approval")
    .addEdge("plan_characters", "characters_approval")

    // Shots → 自动审查 → （通过）人工审批 / （不通过）回到 shots 重写
    .addEdge("plan_shots", "critique_shots")
    .addConditionalEdges("critique_shots", nodes.routeAfterCritique, CRITIQUE_ROUTES)

    // Render shot images → frames preview approval
    .addEdge("render_shot_images", "shot_images_approval")

    // Compose videos → end (the final video is the deliverable, no further gate)
    .addEdge("compose_videos", END)

    // Approval → next stage or review
    .addConditionalEdges(
      "outline_approval",
      nodes.routeAfterOutlineApproval,
      OUTLINE_APPROVAL_ROUTES,
    )
    .addConditionalEdges(
      "characters_approval",
      nodes.routeAfterCharactersApproval,
      CHARACTERS_APPROVAL_ROUTES,
    )
    .addConditionalEdges("shots_approval", nodes.routeAfterShotsApproval, SHOTS_APPROVAL_ROUTES)
    .addConditionalEdges(
      "shot_images_approval",
      nodes.routeAfterShotImagesApproval,
      SHOT_IMAGES_APPROVAL_ROUTES,
    )

    // Review → target stage
    .addConditionalEdges("review", nodes.routeAfterReview, REVIEW_ROUTES);

  return graph;
}

export const phase2Graph = buildPhase2Graph();
