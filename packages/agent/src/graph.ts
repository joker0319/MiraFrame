import { StateGraph, END, START } from "@langchain/langgraph";
import { Phase2State } from "./state.js";
import * as nodes from "./nodes/index.js";

export function buildPhase2Graph() {
  const graph = new StateGraph(Phase2State)
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

    // Entry point — supports resuming from a requested stage.
    .addConditionalEdges(START, nodes.routeFromStart, {
      plan_outline: "plan_outline",
      plan_characters: "plan_characters",
      plan_shots: "plan_shots",
      critique_shots: "critique_shots",
      render_shot_images: "render_shot_images",
      compose_videos: "compose_videos",
      review: "review",
    })

    // Production → Approval linear flow
    .addEdge("plan_outline", "outline_approval")
    .addEdge("plan_characters", "characters_approval")

    // Shots → 自动审查 → （通过）人工审批 / （不通过）回到 shots 重写
    .addEdge("plan_shots", "critique_shots")
    .addConditionalEdges("critique_shots", nodes.routeAfterCritique, {
      shots_approval: "shots_approval",
      plan_shots: "plan_shots",
      review: "review",
    })

    // Render shot images → frames preview approval
    .addEdge("render_shot_images", "shot_images_approval")

    // Compose videos → end (the final video is the deliverable, no further gate)
    .addEdge("compose_videos", END)

    // Approval → next stage or review
    .addConditionalEdges("outline_approval", nodes.routeAfterOutlineApproval, {
      plan_characters: "plan_characters",
      plan_outline: "plan_outline",
      review: "review",
    })
    .addConditionalEdges("characters_approval", nodes.routeAfterCharactersApproval, {
      plan_shots: "plan_shots",
      review: "review",
    })
    .addConditionalEdges("shots_approval", nodes.routeAfterShotsApproval, {
      render_shot_images: "render_shot_images",
      review: "review",
    })
    .addConditionalEdges("shot_images_approval", nodes.routeAfterShotImagesApproval, {
      compose_videos: "compose_videos",
      render_shot_images: "render_shot_images",
      review: "review",
    })

    // Review → target stage
    .addConditionalEdges("review", nodes.routeAfterReview, {
      plan_outline: "plan_outline",
      plan_characters: "plan_characters",
      compose_videos: "compose_videos",
    });

  return graph;
}

export const phase2Graph = buildPhase2Graph();
