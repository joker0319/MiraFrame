import { z } from "zod";
import { IdSchema, IsoDateSchema } from "./common";
import { ProjectProviderSettingsSchema } from "./project";

export const AgentRunSchema: z.ZodTypeAny = z
  .object({
    id: IdSchema,
    project_id: IdSchema,
    status: z.string(),
    current_agent: z.string().nullish(),
    awaiting_gate: z.string().nullish(),
    progress: z.number().min(0).max(1).optional(),
    error: z.string().nullish(),
    thread_id: z.string().nullish(),
    resource_type: z.string().nullish(),
    resource_id: IdSchema.nullish(),
    provider_snapshot: ProjectProviderSettingsSchema.nullish(),
    created_at: IsoDateSchema,
    updated_at: IsoDateSchema,
  })
  .passthrough();

export const MessageSchema: z.ZodTypeAny = z
  .object({
    id: IdSchema,
    project_id: IdSchema,
    run_id: IdSchema.nullish(),
    agent: z.string(),
    role: z.string(),
    content: z.string(),
    summary: z.string().nullish(),
    progress: z.number().min(0).max(1).nullish(),
    is_loading: z.boolean().optional(),
    created_at: IsoDateSchema,
  })
  .passthrough();

export const RecoveryStageSchema: z.ZodTypeAny = z
  .object({
    name: z.string(),
    status: z.enum(["completed", "current", "pending", "blocked"]),
    artifact_count: z.number().int().nonnegative(),
  })
  .passthrough();

export const RecoverySummarySchema: z.ZodTypeAny = z
  .object({
    project_id: IdSchema,
    run_id: IdSchema,
    thread_id: z.string(),
    current_stage: z.string(),
    next_stage: z.string(),
    preserved_stages: z.array(z.string()),
    stage_history: z.array(RecoveryStageSchema),
    resumable: z.boolean(),
  })
  .passthrough();

export const RecoveryControlSchema: z.ZodTypeAny = z
  .object({
    state: z.enum(["active", "recoverable"]),
    detail: z.string(),
    available_actions: z.array(z.string()),
    thread_id: z.string().optional(),
    active_run: AgentRunSchema.nullish(),
    recovery_summary: RecoverySummarySchema.nullish(),
  })
  .passthrough();
