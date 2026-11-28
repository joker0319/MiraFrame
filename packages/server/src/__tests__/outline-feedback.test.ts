import { describe, expect, it, vi } from "vitest";
import { GenerationController } from "../modules/generation/generation.controller";

/**
 * 大纲门的“按反馈重生成”必须走 revision：反馈进 feedback 字段，
 * 不能拼进 project.story，也不能把新 run 的 targetStage 丢掉。
 */
describe("approve-outline 的反馈分支", () => {
  it("调用 submitRevision 并保留 feedback，不再读写 story", async () => {
    const update = vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    }));
    const db = { update };
    const agentService = {
      submitRevision: vi.fn(async () => 42),
      startGeneration: vi.fn(async () => 99),
    };
    const wsGateway = { sendToProject: vi.fn() };
    const redis = { publish: vi.fn() };

    const controller = new GenerationController(
      agentService as never,
      redis as never,
      db as never,
      wsGateway as never,
    );
    const result = await controller.approveOutline("7", { feedback: "  节奏更悬疑  " });

    expect(result).toMatchObject({
      status: "regenerating",
      action: "regenerate",
      run_id: 42,
      feedback: "  节奏更悬疑  ",
    });
    expect(agentService.submitRevision).toHaveBeenCalledWith({
      projectId: 7,
      content: "节奏更悬疑",
      entityType: "outline",
      feedbackType: "regenerate",
    });
    expect(agentService.startGeneration).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(wsGateway.sendToProject).toHaveBeenCalledWith(7, "outline_updated", {
      project_id: 7,
      outline_approved: false,
    });
  });
});
