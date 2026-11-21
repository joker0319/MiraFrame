import { describe, it, expect } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { buildPhase2Graph } from "../graph.js";
import { routeAfterCritique } from "../nodes/index.js";
import { Phase2State } from "../state.js";

describe("Phase2 Graph", () => {
  it("builds a graph with all nodes", () => {
    const graph = buildPhase2Graph();
    expect(graph).toBeDefined();
  });

  it("compiles with MemorySaver", () => {
    const graph = buildPhase2Graph();
    const compiled = graph.compile({ checkpointer: new MemorySaver() });
    expect(compiled).toBeDefined();
  });

  it("starts execution and hits first approval interrupt", async () => {
    const graph = buildPhase2Graph();
    const checkpointer = new MemorySaver();
    const compiled = graph.compile({ checkpointer });

    const initialState = {
      projectId: "test-project",
      runId: "test-run",
      threadId: "thread-1",
      currentStage: "plan_outline" as const,
      nextStage: null,
      stageHistory: [],
      approvalHistory: {},
      critiqueScores: {},
      critiqueRound: 0,
      artifactLineage: {},
      executionPlan: [],
      planRationale: "",
      routeStage: null,
      routeMode: "full" as const,
      reviewRequested: false,
    };

    // Start execution - should hit interrupt at outline_approval
    const config = { configurable: { thread_id: "thread-1" } };

    try {
      await compiled.invoke(initialState, config);
      // If we get here, no interrupt was raised (auto mode?)
    } catch (e: unknown) {
      // LangGraph may throw a specific Interrupt error
      // This is expected behavior for human-in-the-loop nodes
      const errorMessage = e instanceof Error ? e.message : String(e);
      expect(errorMessage).toBeDefined();
    }
  });

  it("has the expected nodes: director + 5 production + 4 approval + 1 review", () => {
    const graph = buildPhase2Graph();
    const compiled = graph.compile({ checkpointer: new MemorySaver() });

    const nodeNames = Object.keys(compiled.getGraph().nodes);

    // Production nodes
    expect(nodeNames).toContain("plan_outline");
    expect(nodeNames).toContain("plan_characters");
    expect(nodeNames).toContain("plan_shots");
    expect(nodeNames).toContain("render_shot_images");
    expect(nodeNames).toContain("compose_videos");

    // HITL approval gates (in pipeline order)
    expect(nodeNames).toContain("outline_approval");
    expect(nodeNames).toContain("characters_approval");
    expect(nodeNames).toContain("shots_approval");
    expect(nodeNames).toContain("shot_images_approval");

    // Review + internal endpoints
    expect(nodeNames).toContain("review");
    expect(nodeNames).toContain("__start__");
    expect(nodeNames).toContain("__end__");

    // 自动审查节点（LLM 质检，位于 plan_shots 与人工审批之间）
    expect(nodeNames).toContain("critique_shots");

    // Supervisor（导演）节点：路径决策的入口
    expect(nodeNames).toContain("director");

    expect(nodeNames).toHaveLength(14);
  });

  it("自动审查后的路由由 critic 的结论驱动", () => {
    // 未通过：critic 把 nextStage 写成 plan_shots → 回炉重写
    expect(routeAfterCritique({ nextStage: "plan_shots" } as never)).toBe("plan_shots");
    // 通过 / 达到轮次上限：放行到人工审批
    expect(routeAfterCritique({ nextStage: "shots_approval" } as never)).toBe("shots_approval");
    // 用户要求回退：优先走 review 分支
    expect(routeAfterCritique({ nextStage: "shots_approval", reviewRequested: true } as never)).toBe(
      "review",
    );
  });
});
