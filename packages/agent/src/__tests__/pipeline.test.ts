import { describe, it, expect } from "vitest";
import { MemorySaver, Command, INTERRUPT, isInterrupted } from "@langchain/langgraph";
import { buildPhase2Graph } from "../graph.js";
import { runWithNodeContext } from "../nodes/index.js";
import type { AgentContext } from "../agents/base.js";

/**
 * 图级 E2E：不用 DB / 真模型，靠 fake context 把整条流水线跑一遍。
 *
 * 它要守住的是「节点之间的接线」而不是单个 Agent 的推理质量：
 * - director 规划 → 大纲 → 角色 → 分镜 → 自动审查 → 四个门
 * - 每次 confirm 后能从 checkpoint 继续，而不是从头再来
 * - 最后真的走到 compose，且只调用一次
 *
 * 这层测试以前是缺的：graph.test 只验证到第一个 interrupt，
 * 所以「拒绝/回退路由漏登记」这类断链只能靠人工跑才能发现。
 */
function makePipelineCtx() {
  let composeCalls = 0;

  const ctx: AgentContext = {
    projectId: 1,
    runId: 1,
    threadId: "pipeline-e2e",
    sendMessage: async () => {},
    sendThinking: async () => {},
    // 所有节点都返回 {}：走各自的 fallback/default 路径，正好覆盖降级分支
    callLlm: async () => "{}",
    saveOutline: async () => {},
    createCharacter: async () => ({ id: 1 }),
    createShot: async () => ({ id: 1 }),
    generateCharacterImage: async () => {},
    generateShotFrames: async () => {},
    generateShotVideos: async () => {},
    composeProjectVideo: async () => {
      composeCalls += 1;
    },
  };

  return {
    ctx,
    get composeCalls() {
      return composeCalls;
    },
  };
}

const initialState = {
  projectId: "1",
  runId: "1",
  threadId: "pipeline-e2e",
  currentStage: "plan_outline" as const,
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

describe("Phase2 pipeline E2E", () => {
  it("从大纲一路跑到成片，只经过四个门且 compose 只执行一次", async () => {
    const compiled = buildPhase2Graph().compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "pipeline-e2e" } };
    const harness = makePipelineCtx();

    let result = await runWithNodeContext(harness.ctx, () => compiled.invoke(initialState, config));

    const gates: string[] = [];
    for (let step = 0; step < 10 && isInterrupted(result); step += 1) {
      const interrupts = (result as unknown as Record<string, unknown>)[INTERRUPT] as Array<{
        value: { gate?: string };
      }>;
      gates.push(interrupts[0]?.value?.gate ?? "unknown");

      result = await runWithNodeContext(harness.ctx, () =>
        compiled.invoke(new Command({ resume: true }), config),
      );
    }

    expect(isInterrupted(result)).toBe(false);
    expect(gates).toEqual([
      "outline_approval",
      "characters_approval",
      "shots_approval",
      "shot_images_approval",
    ]);
    expect(harness.composeCalls).toBe(1);
  });
});
