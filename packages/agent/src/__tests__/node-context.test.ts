import { describe, it, expect } from "vitest";
import { runWithNodeContext } from "../nodes/index.js";
import { planOutlineNode, critiqueShotsNode } from "../nodes/index.js";
import type { AgentContext, CritiqueReport } from "../agents/base.js";
import type { Phase2StateType } from "../state.js";

/**
 * 并发上下文治理（P1-4）。
 *
 * 以前节点上下文有一个模块级 `_nodeCtx` 兜底，processor 的 BullMQ worker
 * 是 concurrency: 8，后一个 job 会覆盖前一个 job 的 ctx；取不到时还会返回
 * mock ctx（callLlm 吐 "{}"），产物静默变空但任务显示成功。
 * 这一组测试锁定新的语义：只有 ALS 一条来源，缺上下文必须显式报错。
 */

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    projectId: 1,
    runId: 1,
    threadId: "thread-1",
    sendMessage: async () => { void 0; },
    sendThinking: async () => { void 0; },
    callLlm: async () => "{}",
    saveOutline: async () => { void 0; },
    createCharacter: async () => ({ id: 1 }),
    createShot: async () => ({ id: 1 }),
    generateCharacterImage: async () => { void 0; },
    generateShotFrames: async () => { void 0; },
    generateShotVideos: async () => { void 0; },
    composeProjectVideo: async () => { void 0; },
    ...overrides,
  };
}

function makeState(overrides: Partial<Phase2StateType> = {}): Phase2StateType {
  return {
    projectId: "test",
    runId: "test",
    threadId: "test",
    currentStage: "plan_outline",
    nextStage: null,
    stageHistory: [],
    approvalHistory: {},
    critiqueScores: {},
    critiqueRound: 0,
    artifactLineage: {},
    executionPlan: [],
    planRationale: "",
    routeStage: null,
    routeMode: "full",
    reviewRequested: false,
    ...overrides,
  } as Phase2StateType;
}

describe("节点上下文：只走 AsyncLocalStorage", () => {
  it("没有 runWithNodeContext 包裹时显式报错，而不是静默产出空结果", async () => {
    await expect(planOutlineNode(makeState())).rejects.toThrow(/拿不到 AgentContext/);
  });

  it("错误信息里点明必须包 runWithNodeContext，便于排查", async () => {
    await expect(planOutlineNode(makeState())).rejects.toThrow(/runWithNodeContext/);
  });

  it("并发跑 8 个 job 时，各节点只看到自己的 ctx，不串号", async () => {
    const reports: Array<{ projectId: number; report: CritiqueReport }> = [];
    const count = 8;

    const jobs = Array.from({ length: count }, (_, i) => {
      const id = i + 1;
      const ctx = makeCtx({
        projectId: id,
        runId: id * 10,
        threadId: `thread-${id}`,
        // 故意让每个 job 的 LLM 延迟不同，制造交错
        callLlm: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5 + ((count - id) * 3)));
          return JSON.stringify({
            overall_score: 6 + id * 0.1,
            issues: [`项目 ${id} 的问题`],
            suggestions: [`项目 ${id} 的建议`],
          });
        },
        reportCritique: async (report) => {
          reports.push({ projectId: id, report });
        },
      });

      return runWithNodeContext(ctx, () =>
        critiqueShotsNode(
          makeState({
            critiqueRound: 0,
            critiqueScores: {},
            artifactText: JSON.stringify([{ order: 1, description: `项目 ${id} 的分镜` }]),
          }),
        ),
      );
    });

    const results = await Promise.all(jobs);

    expect(reports).toHaveLength(count);
    for (const { projectId, report } of reports) {
      // 每个报告都必须是「跑自己的那个 job」产出的
      expect(report.issues).toEqual([`项目 ${projectId} 的问题`]);
      expect(report.suggestions).toEqual([`项目 ${projectId} 的建议`]);
      expect(report.score).toBeCloseTo(6 + projectId * 0.1, 5);
    }
    // 状态也各归各的：第 N 个 job 的分数只落在自己的 critiqueScores 里
    results.forEach((result, index) => {
      const id = index + 1;
      expect(result.critiqueScores).toEqual({ shots_round_1: Math.max(0, Math.min(10, 6 + id * 0.1)) });
    });
  });

  it("并发时某个 job 缺少上下文，只影响它自己", async () => {
    const okCtx = makeCtx({ projectId: 7 });
    const state = makeState({ artifactText: '[{"order":1,"description":"分镜"}]' });

    const good = runWithNodeContext(okCtx, () => critiqueShotsNode(state));
    const bad = critiqueShotsNode(state);

    await expect(bad).rejects.toThrow(/拿不到 AgentContext/);
    await expect(good).resolves.toBeDefined();
  });
});
