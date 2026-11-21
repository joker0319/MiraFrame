import { describe, it, expect } from "vitest";
import {
  DirectorAgent,
  parseDirectorPlan,
  validatePlan,
  defaultPlan,
} from "../agents/director.js";
import {
  routeAfterDirector,
  routeAfterOutlineApproval,
  __nextEnabledForTest,
} from "../nodes/index.js";
import type { AgentContext } from "../agents/base.js";
import type { Phase2StateType } from "../state.js";

function mockCtx(callLlm: (system: string, user: string) => Promise<string>): AgentContext {
  const thinking: string[] = [];
  return {
    projectId: 0,
    runId: 0,
    threadId: "test",
    sendMessage: async () => { void 0; },
    sendThinking: async (_phase, content) => { thinking.push(content); },
    callLlm,
    saveOutline: async () => { void 0; },
    createCharacter: async () => ({ id: 1 }),
    createShot: async () => ({ id: 1 }),
    generateCharacterImage: async () => { void 0; },
    generateShotFrames: async () => { void 0; },
    generateShotVideos: async () => { void 0; },
    composeProjectVideo: async () => { void 0; },
  };
}

function mockState(overrides?: Partial<Phase2StateType>): Phase2StateType {
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
    executionPlan: [],
    planRationale: "",
    artifactLineage: {},
    routeStage: null,
    routeMode: "full",
    reviewRequested: false,
    ...overrides,
  } as Phase2StateType;
}

describe("Director 计划解析与校验（白名单安全带）", () => {
  it("解析 ```json 围栏包裹的计划", () => {
    const raw = '好的，计划如下：\n```json\n{"steps":["plan_outline","compose_videos"],"rationale":"短篇"}\n```';
    const parsed = parseDirectorPlan(raw);
    expect(parsed.steps).toEqual(["plan_outline", "compose_videos"]);
    expect(parsed.rationale).toBe("短篇");
  });

  it("过滤非法阶段、去重、补回必需阶段、compose_videos 结尾", () => {
    const result = validatePlan({
      steps: ["plan_outline", "evil_stage", "plan_outline", "plan_shots"] as never,
      rationale: "含非法阶段",
    });
    expect(result.steps).toEqual([
      "plan_outline", "plan_shots", "critique_shots", "render_shot_images", "compose_videos",
    ]);
    expect(result.steps).not.toContain("evil_stage");
    expect(result.steps.at(-1)).toBe("compose_videos");
  });

  it("空计划或缺少生成阶段时回退默认全链路", () => {
    const result = validatePlan({ steps: [], rationale: "" });
    expect(result.steps).toEqual(defaultPlan().steps);
  });

  it("保留跳过角色阶段的合法计划", () => {
    const result = validatePlan({
      steps: ["plan_outline", "plan_shots", "critique_shots", "render_shot_images", "compose_videos"] as never,
      rationale: "短篇跳过角色图",
    });
    expect(result.steps).not.toContain("plan_characters");
    expect(result.steps.at(-1)).toBe("compose_videos");
  });
});

describe("DirectorAgent 规划", () => {
  it("用模型输出作为计划并可视化理由", async () => {
    const agent = new DirectorAgent();
    const ctx = mockCtx(async () =>
      JSON.stringify({
        steps: ["plan_outline", "plan_shots", "compose_videos"],
        rationale: "样片只需大纲和分镜",
      }),
    );
    const result = await agent.plan(ctx, mockState());
    // 模型想跳过角色阶段，但质检/渲染/成片被安全带补回
    expect(result.executionPlan).toEqual([
      "plan_outline", "plan_shots", "critique_shots", "render_shot_images", "compose_videos",
    ]);
    expect(result.executionPlan).not.toContain("plan_characters");
    expect(result.planRationale).toContain("样片");
  });

  it("LLM 抛错时回退默认链路而不是中断", async () => {
    const agent = new DirectorAgent();
    const ctx = mockCtx(async () => {
      throw new Error("model down");
    });
    const result = await agent.plan(ctx, mockState());
    expect(result.executionPlan).toEqual(defaultPlan().steps);
  });
});

describe("按计划动态路由（路径决策权交给模型）", () => {
  it("Director 之后从计划的首个阶段起步，而非固定大纲", () => {
    const state = mockState({
      executionPlan: ["plan_shots", "render_shot_images", "compose_videos"],
    });
    expect(routeAfterDirector(state)).toBe("plan_shots");
  });

  it("跳过角色阶段：大纲审批后直接到分镜", () => {
    const state = mockState({
      executionPlan: ["plan_outline", "plan_shots", "compose_videos"],
      approvalHistory: { outline: "approved" },
    });
    expect(routeAfterOutlineApproval(state)).toBe("plan_shots");
  });

  it("未跳过角色阶段：大纲审批后仍到角色（旧链路不回归）", () => {
    const state = mockState({
      executionPlan: defaultPlan().steps,
      approvalHistory: { outline: "approved" },
    });
    expect(routeAfterOutlineApproval(state)).toBe("plan_characters");
  });

  it("空计划（恢复态）沿默认链路向后找下一阶段", () => {
    const state = mockState({ executionPlan: [] });
    expect(__nextEnabledForTest(state, "plan_outline")).toBe("plan_characters");
  });

  it("被驳回时仍回大纲，不受计划影响", () => {
    const state = mockState({
      executionPlan: ["plan_outline", "plan_shots", "compose_videos"],
      approvalHistory: { outline: "rejected" },
    });
    expect(routeAfterOutlineApproval(state)).toBe("plan_outline");
  });
});
