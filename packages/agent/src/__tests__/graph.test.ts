import { describe, it, expect } from "vitest";
import { MemorySaver, Command, INTERRUPT, isInterrupted } from "@langchain/langgraph";
import {
  buildPhase2Graph,
  CHARACTERS_APPROVAL_ROUTES,
  CRITIQUE_ROUTES,
  DIRECTOR_ROUTES,
  OUTLINE_APPROVAL_ROUTES,
  REVIEW_ROUTES,
  SHOT_IMAGES_APPROVAL_ROUTES,
  SHOTS_APPROVAL_ROUTES,
} from "../graph.js";
import {
  routeAfterCharactersApproval,
  routeAfterCritique,
  routeAfterDirector,
  routeAfterOutlineApproval,
  routeAfterReview,
  routeAfterShotImagesApproval,
  routeAfterShotsApproval,
  runWithNodeContext,
} from "../nodes/index.js";
import { VALID_TARGETS } from "../agents/review.js";
import type { AgentContext } from "../agents/base.js";

/** 图执行时节点要从 ALS 取上下文，这里给一份最小可用的 fake context */
function makeCtx(): AgentContext {
  return {
    projectId: 1,
    runId: 1,
    threadId: "thread-1",
    sendMessage: async () => {
      void 0;
    },
    sendThinking: async () => {
      void 0;
    },
    callLlm: async () => "{}",
    saveOutline: async () => {
      void 0;
    },
    createCharacter: async () => ({ id: 1 }),
    createShot: async () => ({ id: 1 }),
    generateCharacterImage: async () => {
      void 0;
    },
    generateShotFrames: async () => {
      void 0;
    },
    generateShotVideos: async () => {
      void 0;
    },
    composeProjectVideo: async () => {
      void 0;
    },
  };
}

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
      };

    // Start execution - should hit interrupt at outline_approval.
    // 上下文只能通过 ALS 传入：没有 runWithNodeContext 包裹时节点会直接抛错，
    // 所以这里必须真的包一层，而不是靠 try/catch 把异常吞掉。
    const config = { configurable: { thread_id: "thread-1" } };

    const result = await runWithNodeContext(makeCtx(), () => compiled.invoke(initialState, config));

    expect(isInterrupted(result)).toBe(true);
    const interrupts = (result as unknown as Record<string, unknown>)[INTERRUPT] as Array<{
      value: unknown;
    }>;
    const interruptValue = interrupts[0].value as { gate?: string };
    expect(interruptValue.gate).toBe("outline_approval");
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
  });

  it("所有路由函数的返回值都能在条件边登记表里找到", () => {
    // 这类不一致以前只在运行时暴露：路由函数返回了合法目标，但 graph.ts 没登记，
    // 于是流程跑到一半抛 "Branch condition returned unknown destination"。
    const cases: Array<[Record<string, string>, string, string]> = [
      [
        DIRECTOR_ROUTES,
        routeAfterDirector({ executionPlan: [], currentStage: "plan_outline" } as never),
        "director",
      ],
      [
        DIRECTOR_ROUTES,
        routeAfterDirector({
          executionPlan: ["plan_shots"],
          currentStage: "plan_outline",
        } as never),
        "director",
      ],
      [CRITIQUE_ROUTES, routeAfterCritique({ nextStage: "plan_shots" } as never), "critique_shots"],
      [
        CRITIQUE_ROUTES,
        routeAfterCritique({ nextStage: "shots_approval" } as never),
        "critique_shots",
      ],
      [
        OUTLINE_APPROVAL_ROUTES,
        routeAfterOutlineApproval({ approvalHistory: { outline: "approved" } } as never),
        "outline_approval",
      ],
      [
        OUTLINE_APPROVAL_ROUTES,
        routeAfterOutlineApproval({ approvalHistory: { outline: "rejected" } } as never),
        "outline_approval",
      ],
      [
        CHARACTERS_APPROVAL_ROUTES,
        routeAfterCharactersApproval({ approvalHistory: { characters: "approved" } } as never),
        "characters_approval",
      ],
      [
        CHARACTERS_APPROVAL_ROUTES,
        routeAfterCharactersApproval({ approvalHistory: { characters: "rejected" } } as never),
        "characters_approval",
      ],
      [
        SHOTS_APPROVAL_ROUTES,
        routeAfterShotsApproval({ approvalHistory: { shots: "approved" } } as never),
        "shots_approval",
      ],
      [
        SHOTS_APPROVAL_ROUTES,
        routeAfterShotsApproval({ approvalHistory: { shots: "rejected" } } as never),
        "shots_approval",
      ],
      [
        SHOT_IMAGES_APPROVAL_ROUTES,
        routeAfterShotImagesApproval({ approvalHistory: { frames: "approved" } } as never),
        "shot_images_approval",
      ],
      [
        SHOT_IMAGES_APPROVAL_ROUTES,
        routeAfterShotImagesApproval({ approvalHistory: { frames: "rejected" } } as never),
        "shot_images_approval",
      ],
      [REVIEW_ROUTES, routeAfterReview({ routeStage: null } as never), "review"],
    ];
    for (const [destinations, target, source] of cases) {
      expect(destinations, `${source} → ${target} 缺少登记`).toHaveProperty(target);
    }
  });

  it("review 的合法目标和条件边登记表完全一致", () => {
    expect(new Set(Object.keys(REVIEW_ROUTES))).toEqual(VALID_TARGETS);
    // 逐项断言，失败时能直接看出是哪个目标漏了
    for (const target of VALID_TARGETS) {
      expect(REVIEW_ROUTES).toHaveProperty(target);
    }
  });

  it("角色门拒绝后回到 plan_characters 并再次中断，而不是抛 unknown destination", async () => {
    const compiled = buildPhase2Graph().compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "reject-characters" } };
    const initialState = {
      projectId: "1",
      runId: "1",
      threadId: "reject-characters",
      currentStage: "plan_characters" as const,
      nextStage: null,
      stageHistory: [],
      approvalHistory: {},
      critiqueScores: {},
      critiqueRound: 0,
      artifactText: "",
      artifactLineage: {},
      executionPlan: [],
      planRationale: "",
      routeStage: null,
      routeMode: "full" as const,
      };

    const first = await runWithNodeContext(makeCtx(), () => compiled.invoke(initialState, config));
    expect(isInterrupted(first)).toBe(true);

    const second = await runWithNodeContext(makeCtx(), () =>
      compiled.invoke(new Command({ resume: { confirm: false } }), config),
    );
    expect(isInterrupted(second)).toBe(true);
    const interrupts = (second as unknown as Record<string, unknown>)[INTERRUPT] as Array<{
      value: unknown;
    }>;
    expect((interrupts[0].value as { gate?: string }).gate).toBe("characters_approval");
  });
});
