import { Controller, Post, Param, Body, HttpCode, HttpStatus, Inject } from "@nestjs/common";
import Redis from "ioredis";
import { REDIS_CLIENT } from "../../redis";
import { AgentService } from "../../agent/agent.service";
import { DRIZZLE, type Db, schema } from "../../db";
import { desc, eq } from "drizzle-orm";
import { WsGateway } from "../../ws";
import {
  ApproveOutlineRequestSchema,
  ApproveOutlineResponseSchema,
  CancelRunResponseSchema,
  FeedbackResponseSchema,
  GenerateRequestSchema,
  GenerateRunResponseSchema,
  ResumeRequestSchema,
  ResumeRunResponseSchema,
} from "@miraframe/shared";
import type {
  ApproveOutlineRequest,
  GenerateRequest,
  ResumeRequest,
  StoryOutline,
} from "@miraframe/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { assertContract } from "../../contracts/assert";

@Controller("api/v1/projects/:projectId")
export class GenerationController {
  constructor(
    @Inject(AgentService) private readonly agentService: AgentService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(WsGateway) private readonly wsGateway: WsGateway,
  ) {}

  @Post("generate")
  @HttpCode(HttpStatus.ACCEPTED)
  async generate(
    @Param("projectId") projectId: string,
    @Body(new ZodValidationPipe(GenerateRequestSchema)) body: GenerateRequest,
  ) {
    const runId = await this.agentService.startGeneration({
      projectId: parseInt(projectId),
      mode: "full",
      autoMode: body.auto_mode || false,
      targetStage: body.target_stage,
    });

    return assertContract(
      GenerateRunResponseSchema,
      { run_id: runId, status: "queued" },
      "GenerateRunResponse",
    );
  }

  @Post("generate/cancel")
  @HttpCode(HttpStatus.OK)
  async cancelLatest(@Param("projectId") projectIdParam: string) {
    const projectId = parseInt(projectIdParam);
    const recentRuns = await this.db
      .select({ id: schema.agentRuns.id, status: schema.agentRuns.status })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.projectId, projectId))
      .orderBy(desc(schema.agentRuns.createdAt))
      .limit(5);
    const cancellableRun = recentRuns.find((run) => run.status === "running" || run.status === "queued");
    if (!cancellableRun) {
      return assertContract(
        CancelRunResponseSchema,
        { status: "cancelled", cancelled: 0 },
        "CancelRunResponse",
      );
    }

    await this.agentService.cancelGeneration(projectId, cancellableRun.id);
    return assertContract(
      CancelRunResponseSchema,
      { status: "cancelled", cancelled: 1, run_id: cancellableRun.id },
      "CancelRunResponse",
    );
  }

  @Post("generate/:runId/cancel")
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ) {
    await this.agentService.cancelGeneration(parseInt(projectId), parseInt(runId));
    return assertContract(
      CancelRunResponseSchema,
      { status: "cancelled" },
      "CancelRunResponse",
    );
  }

  @Post("generate/:runId/resume")
  @HttpCode(HttpStatus.ACCEPTED)
  async resume(
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
    @Body(new ZodValidationPipe(ResumeRequestSchema)) body: ResumeRequest,
  ) {
    // Use injected Redis client (no manual connection)
    await this.redis.publish(
      `generation:${projectId}:${runId}`,
      JSON.stringify({
        action: body.confirm ? "confirm" : "cancel",
        feedback: body.feedback,
      }),
    );
    this.wsGateway.sendToProject(parseInt(projectId), "run_confirmed", {
      run_id: parseInt(runId),
      project_id: parseInt(projectId),
    });
    return assertContract(ResumeRunResponseSchema, { status: "resumed" }, "ResumeRunResponse");
  }

  @Post("approve-outline")
  @HttpCode(HttpStatus.ACCEPTED)
  async approveOutline(
    @Param("projectId") projectIdParam: string,
    @Body(new ZodValidationPipe(ApproveOutlineRequestSchema)) body: ApproveOutlineRequest,
  ) {
    const projectId = parseInt(projectIdParam);

    // If feedback is provided, regenerate outline instead of approving.
    // 走 revision 流程而不是把反馈拼进 story：story 是用户的原始创作输入，
    // 拼进去会永久污染它，而且新 run 拿不到 feedback 字段，Director/记忆都看不见。
    if (body.feedback && body.feedback.trim().length > 0) {
      await this.db
        .update(schema.projects)
        .set({ outlineApproved: false, updatedAt: new Date() })
        .where(eq(schema.projects.id, projectId));

      const runId = await this.agentService.submitRevision({
        projectId,
        content: body.feedback.trim(),
        entityType: "outline",
        feedbackType: "regenerate",
      });

      this.wsGateway.sendToProject(projectId, "outline_updated", {
        project_id: projectId,
        outline_approved: false,
      });

      return assertContract(
        ApproveOutlineResponseSchema,
        {
          status: "regenerating",
          action: "regenerate",
          run_id: runId,
          feedback: body.feedback,
        },
        "ApproveOutlineResponse",
      );
    }
    try {
      const [project] = await this.db
        .update(schema.projects)
        .set({ outlineApproved: true, updatedAt: new Date() })
        .where(eq(schema.projects.id, projectId))
        .returning({
          storyOutline: schema.projects.storyOutline,
          visualBible: schema.projects.visualBible,
          outlineApproved: schema.projects.outlineApproved,
        });

      this.wsGateway.sendToProject(projectId, "outline_updated", {
        project_id: projectId,
        story_outline: (project?.storyOutline as StoryOutline | null) ?? null,
        visual_bible: project?.visualBible ?? null,
        outline_approved: true,
      });
      this.wsGateway.sendToProject(projectId, "project_updated", {
        outline_approved: true,
      });

      const runId = await this.agentService.startGeneration({
        projectId,
        mode: "full",
        autoMode: false,
        targetStage: "plan_characters",
      });

      return assertContract(
        ApproveOutlineResponseSchema,
        {
          status: "approved",
          action: "started",
          run_id: runId,
          resumed: false,
        },
        "ApproveOutlineResponse",
      );
    } catch (error) {
      console.error("[generation] approve-outline failed:", error);
      throw error;
    }
  }

  @Post("generate/:runId/feedback")
  @HttpCode(HttpStatus.OK)
  async feedback(
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
    @Body() body: { feedback: string; feedback_type?: string },
  ) {
    await this.agentService.sendFeedback(
      parseInt(projectId),
      parseInt(runId),
      body.feedback,
      body.feedback_type,
    );
    return assertContract(
      FeedbackResponseSchema,
      { status: "feedback_received" },
      "FeedbackResponse",
    );
  }
}
