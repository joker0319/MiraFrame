import { describe, it, expect } from "vitest";
import { OutlineAgent } from "../agents/outline.js";
import { PlanAgent } from "../agents/plan.js";
import { CriticAgent } from "../agents/critic.js";
import { BaseAgent } from "../agents/base.js";
import { ReviewRuleEngine } from "../agents/review.js";
import type { AgentContext, CritiqueReport } from "../agents/base.js";
import type { Phase2StateType } from "../state.js";

function mockCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    projectId: 0,
    runId: 0,
    threadId: "test",
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
    artifactLineage: {},
    executionPlan: [],
    planRationale: "",
    routeStage: null,
    routeMode: "full",
    reviewRequested: false,
    ...overrides,
  } as Phase2StateType;
}

describe("OutlineAgent", () => {
  it("has correct name", () => {
    const agent = new OutlineAgent();
    expect(agent.name).toBe("outline");
  });

  it("is a BaseAgent", () => {
    const agent = new OutlineAgent();
    expect(agent).toBeInstanceOf(BaseAgent);
  });

  it("run returns state update with currentStage", async () => {
    const agent = new OutlineAgent();
    const ctx = mockCtx();
    const state = mockState();
    const result = await agent.run(ctx, state);
    expect(result.currentStage).toBe("plan_outline");
    expect(result.nextStage).toBe("outline_approval");
  });
});

describe("PlanAgent", () => {
  it("has correct name", () => {
    const agent = new PlanAgent();
    expect(agent.name).toBe("plan");
  });

  it("runCharacters returns state update", async () => {
    const agent = new PlanAgent();
    const ctx = mockCtx();
    const state = mockState();
    const result = await agent.runCharacters(ctx, state);
    expect(result.currentStage).toBe("plan_characters");
    expect(result.nextStage).toBe("characters_approval");
  });

  it("runShots returns state update", async () => {
    const agent = new PlanAgent();
    const ctx = mockCtx();
    const state = mockState();
    const result = await agent.runShots(ctx, state);
    expect(result.currentStage).toBe("plan_shots");
    // 分镜生成后先进入自动审查节点，再决定是转人工还是回炉
    expect(result.nextStage).toBe("critique_shots");
    // 生成的文本要交给下游 CriticAgent，否则审查环节拿不到产物
    expect(result.artifactText).toBeTruthy();
  });

  it("把持久化血缘写回 state，让 artifactLineage 不再是空转字段", async () => {
    const lineage = { "character:1": ["shot:3", "shot:7"], "character:2": ["shot:3"] };
    const ctx = mockCtx({ getArtifactLineage: async () => lineage });
    const result = await new PlanAgent().runShots(ctx, mockState());
    expect(result.artifactLineage).toEqual(lineage);
  });
});

describe("CriticAgent", () => {
  it("has correct name", () => {
    const agent = new CriticAgent();
    expect(agent.name).toBe("critic");
  });

  it("通过阈值时：记录分数并转人工审批", async () => {
    const agent = new CriticAgent();
    const ctx = mockCtx({
      callLlm: async () =>
        '{"overall_score": 8.5, "dimensions": {"narrative": 9}, "issues": [], "suggestions": [], "needs_regenerate": false}',
    });
    const state = mockState({
      critiqueRound: 0,
      critiqueScores: {},
      artifactText: '[{"order":1,"description":"开场"}]',
    });

    const result = await agent.critiqueShots(ctx, state);

    expect(result.critiqueRound).toBe(1);
    expect(result.critiqueScores).toEqual({ shots_round_1: 8.5 });
    expect(result.currentStage).toBe("critique_shots");
    expect(result.nextStage).toBe("shots_approval");
    expect(result.feedback).toBeNull();
  });

  it("低于阈值时：把意见写进 feedback 并回到 plan_shots 重写", async () => {
    const agent = new CriticAgent();
    const ctx = mockCtx({
      callLlm: async () =>
        '{"overall_score": 5, "issues": ["第3镜与第1镜场景矛盾"], "suggestions": ["统一场景描述"], "needs_regenerate": true}',
    });
    const state = mockState({
      critiqueRound: 0,
      critiqueScores: {},
      artifactText: '[{"order":1,"description":"开场"}]',
    });

    const result = await agent.critiqueShots(ctx, state);

    expect(result.nextStage).toBe("plan_shots");
    expect(result.feedbackType).toBe("critique");
    expect(result.feedback).toContain("第3镜与第1镜场景矛盾");
    expect(result.feedback).toContain("统一场景描述");
  });

  it("达到最大轮次时：即使分数低也放行到人工审批（防止死循环）", async () => {
    const agent = new CriticAgent();
    const ctx = mockCtx({
      callLlm: async () => '{"overall_score": 3, "issues": ["结构性问题"]}',
    });
    const state = mockState({
      critiqueRound: 1, // 下一轮就是第 2 轮 = MAX_ROUNDS
      critiqueScores: { shots_round_1: 3 },
      artifactText: '[{"order":1,"description":"开场"}]',
    });

    const result = await agent.critiqueShots(ctx, state);

    expect(result.critiqueRound).toBe(2);
    expect(result.nextStage).toBe("shots_approval");
  });

  it("没有产物可审时：跳过审查直接转人工", async () => {
    const agent = new CriticAgent();
    const ctx = mockCtx();
    const state = mockState({ critiqueRound: 0, critiqueScores: {} });

    const result = await agent.critiqueShots(ctx, state);

    expect(result.nextStage).toBe("shots_approval");
  });

  it("LLM 调用失败时：降级为人工审批而不是中断流程", async () => {
    const agent = new CriticAgent();
    const ctx = mockCtx({
      callLlm: async () => {
        throw new Error("LLM timeout");
      },
    });
    const state = mockState({
      critiqueRound: 0,
      critiqueScores: {},
      artifactText: '[{"order":1,"description":"开场"}]',
    });

    const result = await agent.critiqueShots(ctx, state);

    expect(result.nextStage).toBe("shots_approval");
  });

  it("把评审结论通过 reportCritique 上报，带上阈值/轮次/路由结果", async () => {
    const agent = new CriticAgent();
    const reports: CritiqueReport[] = [];
    const ctx = mockCtx({
      callLlm: async () =>
        '{"overall_score": 8.5, "dimensions": {"narrative": 9}, "issues": [], "suggestions": ["可加强转场"]}',
      reportCritique: async (report) => {
        reports.push(report);
      },
    });
    const state = mockState({
      critiqueRound: 0,
      critiqueScores: {},
      artifactText: '[{"order":1,"description":"开场"}]',
    });

    await agent.critiqueShots(ctx, state);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      stage: "critique_shots",
      entityType: "shots",
      score: 8.5,
      passed: true,
      round: 1,
      willRegenerate: false,
      dimensions: { narrative: 9 },
      suggestions: ["可加强转场"],
    });
    // 阈值/轮次上限要跟随环境变量实际值，前端才能解释「为什么没过」
    expect(reports[0].threshold).toBe(Number(process.env.CRITIC_SCORE_THRESHOLD ?? 7));
    expect(reports[0].maxRounds).toBe(Number(process.env.CRITIC_MAX_ROUNDS ?? 2));
  });

  it("低于阈值时上报 willRegenerate=true，让前端显示「将重写」", async () => {
    const agent = new CriticAgent();
    const reports: CritiqueReport[] = [];
    const ctx = mockCtx({
      callLlm: async () => '{"overall_score": 5, "issues": ["场景矛盾"], "suggestions": ["统一场景"]}',
      reportCritique: async (report) => {
        reports.push(report);
      },
    });
    const state = mockState({
      critiqueRound: 0,
      critiqueScores: {},
      artifactText: '[{"order":1,"description":"开场"}]',
    });

    await agent.critiqueShots(ctx, state);

    expect(reports[0]).toMatchObject({
      passed: false,
      willRegenerate: true,
      issues: ["场景矛盾"],
    });
  });

  it("上报失败不影响评审结论（前端少张卡片，流程照走）", async () => {
    const agent = new CriticAgent();
    const ctx = mockCtx({
      callLlm: async () => '{"overall_score": 8, "issues": [], "suggestions": []}',
      reportCritique: async () => {
        throw new Error("ws down");
      },
    });
    const state = mockState({
      critiqueRound: 0,
      critiqueScores: {},
      artifactText: '[{"order":1,"description":"开场"}]',
    });

    const result = await agent.critiqueShots(ctx, state);

    expect(result.nextStage).toBe("shots_approval");
    expect(result.critiqueScores).toEqual({ shots_round_1: 8 });
  });
});

describe("ReviewRuleEngine", () => {
  it("has correct name", () => {
    const engine = new ReviewRuleEngine();
    expect(engine.name).toBe("review");
  });

  it("routes back to the correct stage", async () => {
    const engine = new ReviewRuleEngine();
    const ctx = mockCtx();
    const state = mockState({ currentStage: "outline_approval" });
    const result = await engine.run(ctx, state);
    expect(result.routeStage).toBe("plan_outline");
    expect(result.routeMode).toBe("incremental");
    expect(result.reviewRequested).toBe(false);
  });
});

const TOOL_FIXTURE = {
  title: "工具测试大纲",
  logline: "一段用于验证工具调用的梗概",
  visual_bible: "水彩风格",
  acts: [{ act: 1, title: "第一幕", summary: "开端" }],
};

describe("OutlineAgent 工具驱动（function calling）", () => {
  it("模型自主决定先写草稿再落库，节点不再硬编码顺序", async () => {
    const saved: Array<{ outline: Record<string, unknown>; visualBible?: string | null }> = [];
    const decisions: string[] = [];

    const ctx = mockCtx({
      saveOutline: async (outline, visualBible) => {
        saved.push({ outline, visualBible });
      },
      callLlmWithTools: async (messages) => {
        const toolResults = messages.filter((m) => m.role === "tool").map((m) => m.content);
        const hasDraft = toolResults.some((text) => text.includes("草稿已记录"));
        const hasSaved = toolResults.some((text) => text.includes("大纲已保存"));

        if (!hasDraft) {
          decisions.push("write_outline_draft");
          return {
            content: "",
            toolCalls: [{ id: "c1", name: "write_outline_draft", arguments: { outline: TOOL_FIXTURE } }],
          };
        }
        if (!hasSaved) {
          decisions.push("save_outline");
          return {
            content: "",
            toolCalls: [{ id: "c2", name: "save_outline", arguments: { draftId: "draft-1" } }],
          };
        }
        return { content: "全部完成", toolCalls: [] };
      },
    });

    const result = await new OutlineAgent().run(ctx, mockState());

    expect(decisions).toEqual(["write_outline_draft", "save_outline"]);
    expect(saved).toHaveLength(1);
    expect(saved[0].outline).toEqual(TOOL_FIXTURE);
    expect(saved[0].visualBible).toBe("水彩风格");
    expect(result.nextStage).toBe("outline_approval");
  });

  it("工具执行失败时错误回填给模型，模型可以自我修正", async () => {
    let calls = 0;
    let sawError = false;
    let saved = 0;

    const ctx = mockCtx({
      saveOutline: async () => {
        saved++;
      },
      callLlmWithTools: async (messages) => {
        calls++;
        const toolResults = messages.filter((m) => m.role === "tool").map((m) => m.content);
        if (toolResults.some((text) => text.startsWith("ERROR:"))) sawError = true;
        const hasDraft = toolResults.some((text) => text.includes("草稿已记录"));
        const hasSaved = toolResults.some((text) => text.includes("大纲已保存"));

        if (calls === 1) {
          return {
            content: "",
            toolCalls: [{ id: "bad", name: "write_outline_draft", arguments: { outline: "这不是 JSON" } }],
          };
        }
        if (!hasDraft) {
          return {
            content: "",
            toolCalls: [{ id: "good", name: "write_outline_draft", arguments: { outline: TOOL_FIXTURE } }],
          };
        }
        if (!hasSaved) {
          return {
            content: "",
            toolCalls: [{ id: "save", name: "save_outline", arguments: {} }],
          };
        }
        return { content: "完成", toolCalls: [] };
      },
    });

    await new OutlineAgent().run(ctx, mockState());

    expect(sawError).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(saved).toBe(1);
  });

  it("模型没有 function calling 通道时自动降级为 JSON 协议", async () => {
    let saved = 0;

    const ctx = mockCtx({
      saveOutline: async () => {
        saved++;
      },
      callLlm: async (_system, prompt) => {
        if (prompt.includes("请输出下一步的 JSON 工具调用")) {
          if (!prompt.includes("草稿已记录")) {
            return JSON.stringify({ tool: "write_outline_draft", arguments: { outline: TOOL_FIXTURE } });
          }
          if (!prompt.includes("大纲已保存")) {
            return JSON.stringify({ tool: "save_outline", arguments: {} });
          }
        }
        return JSON.stringify({ done: true, summary: "完成" });
      },
    });

    await new OutlineAgent().run(ctx, mockState());

    expect(saved).toBe(1);
  });
});

describe("ReviewRuleEngine 模型路由决策", () => {
  it("模型根据反馈自主决定回退阶段（而非只按 currentStage 查表）", async () => {
    const engine = new ReviewRuleEngine();
    const ctx = mockCtx({
      callLlm: async () =>
        JSON.stringify({
          targetStage: "render_shot_images",
          mode: "incremental",
          rationale: "反馈只涉及色调，脚本无需重做",
        }),
    });
    const state = mockState({
      currentStage: "shots_approval",
      feedback: "把画面调暖一点",
      feedbackType: "style",
    });
    const result = await engine.run(ctx, state);
    // 规则查表会给 render_shot_images 吗？不会——查表 shots_approval → plan_shots
    // 这里被模型改成了 render_shot_images，证明决策权在模型
    expect(result.routeStage).toBe("render_shot_images");
    expect(result.routeMode).toBe("incremental");
  });

  it("模型输出非法阶段时回退规则映射", async () => {
    const engine = new ReviewRuleEngine();
    const ctx = mockCtx({
      callLlm: async () => JSON.stringify({ targetStage: "hack_stage", mode: "full" }),
    });
    const state = mockState({ currentStage: "shots_approval" });
    const result = await engine.run(ctx, state);
    expect(result.routeStage).toBe("plan_shots");
    expect(result.routeMode).toBe("incremental");
  });

  it("LLM 不可用时回退规则映射且不崩溃", async () => {
    const engine = new ReviewRuleEngine();
    const ctx = mockCtx({
      callLlm: async () => {
        throw new Error("offline");
      },
    });
    const state = mockState({ currentStage: "outline_approval" });
    const result = await engine.run(ctx, state);
    expect(result.routeStage).toBe("plan_outline");
  });
});
