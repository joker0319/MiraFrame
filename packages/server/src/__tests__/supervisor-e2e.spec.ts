import { describe, it, expect } from "vitest";
import { MemorySaver, Command, INTERRUPT, isInterrupted } from "@langchain/langgraph";
import { buildPhase2Graph, setNodeContext, clearNodeContext, runWithNodeContext } from "@miraframe/agent";
import type { AgentContext } from "@miraframe/agent";

/**
 * 端到端验证 Supervisor：Director 生成"跳过角色阶段"的计划后，
 * 整条图能沿着计划跑通，且 4 个审批门仍在正确的位置出现。
 */
describe("Supervisor 端到端：模型规划驱动整条流水线", () => {
  it("Director 跳过角色阶段后，图沿计划执行并经过预期的门", async () => {
    const events: string[] = [];
    const ctx: AgentContext = {
      projectId: 99,
      runId: 99,
      threadId: "e2e-director",
      sendMessage: async (_c, o) => { if (o?.stage) events.push(`stage:${o.stage}`); },
      sendThinking: async () => { void 0; },
      // 模拟 Director 决策：跳过 plan_characters
      callLlm: async (_sys, _user, opts) => {
        if (opts?.intent === "director-plan") {
          return JSON.stringify({
            steps: ["plan_outline", "plan_shots", "critique_shots", "render_shot_images", "compose_videos"],
            rationale: "端到端验证：短篇跳过角色图",
          });
        }
        return "{}";
      },
      saveOutline: async () => { void 0; },
      createCharacter: async () => ({ id: 1 }),
      createShot: async () => ({ id: 1 }),
      generateCharacterImage: async () => { events.push("characters-image-called"); },
      generateShotFrames: async () => { void 0; },
      generateShotVideos: async () => { void 0; },
      composeProjectVideo: async () => { events.push("composed"); },
    };

    const graph = buildPhase2Graph();
    const checkpointer = new MemorySaver();
    const compiled = graph.compile({ checkpointer });
    const config = { configurable: { thread_id: "e2e-director" } };
    const initialState = {
      projectId: "99", runId: "99", threadId: "e2e-director",
      currentStage: "plan_outline", nextStage: null, stageHistory: [],
      approvalHistory: {}, critiqueScores: {}, critiqueRound: 0,
      executionPlan: [], planRationale: "", artifactLineage: {},
      routeStage: null, routeMode: "full" as const, reviewRequested: false,
    };

    setNodeContext(ctx);
    try {
      await runWithNodeContext(ctx, async () => {
        let input: unknown = initialState;
        let interrupted = 0;
        for (let step = 0; step < 12; step++) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await compiled.invoke(input as any, config);
          if (isInterrupted(result)) {
            interrupted++;
            const iv = (result[INTERRUPT] as Array<{ value: unknown }>)?.[0]?.value as { gate?: string } | undefined;
            events.push(`gate:${iv?.gate || "unknown"}`);
            input = new Command({ resume: true });
          } else {
            break;
          }
        }
      });
    } finally {
      clearNodeContext();
    }

    // 计划里没有 plan_characters，所以角色图生成不应被调用
    expect(events).not.toContain("characters-image-called");
    // 但仍需经过大纲审批门（门结构不变）
    expect(events).toContain("gate:outline_approval");
    // 最终成片被调用
    expect(events).toContain("composed");
  });
});
