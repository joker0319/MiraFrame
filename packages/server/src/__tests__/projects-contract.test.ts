import { describe, expect, it, vi } from "vitest";
import { ProjectsController } from "../modules/projects/projects.controller";

/**
 * 回归：控制器接线必须真的走 DTO。
 *
 * DTO 单测只能证明 serializer 正确，证明不了 handler 有没有调用它；
 * 之前 getLatestRun 就漏了，REST 仍返回 camelCase，前端 normalizer 一删就炸。
 */
describe("ProjectsController 的输出契约", () => {
  it("latest run 返回 snake_case，而不是 Drizzle 行", async () => {
    const runRow = {
      id: 9,
      projectId: 1,
      status: "running",
      currentAgent: "plan_outline",
      awaitingGate: "outline_approval",
      progress: 0.2,
      routeDecision: null,
      patchPlan: null,
      error: null,
      resourceType: null,
      resourceId: null,
      threadId: "thread-1-9",
      providerSnapshot: null,
      createdAt: new Date("2026-11-28T00:00:00.000Z"),
      updatedAt: new Date("2026-11-28T00:00:00.000Z"),
    };

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [runRow],
            }),
          }),
        }),
      }),
    };

    const controller = new ProjectsController(
      db as never,
      { sendToProject: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await controller.getLatestRun("1");

    expect(result).toMatchObject({
      id: 9,
      project_id: 1,
      awaiting_gate: "outline_approval",
      current_agent: "plan_outline",
      created_at: "2026-11-28T00:00:00.000Z",
    });
    expect(result).not.toHaveProperty("projectId");
    expect(result).not.toHaveProperty("awaitingGate");
  });
});
