import { z } from "zod";
import { WS_EVENT_TYPES } from "../constants/events";
import type { WsEventType } from "../types/ws-events";
import { AgentThinkingPhaseSchema, IdSchema, VersionEntityTypeSchema } from "./common";
import { CharacterSchema, ProjectSchema, ShotSchema, StoryOutlineSchema } from "./project";
import { RecoverySummarySchema } from "./agent";
import { ShotConsistencyResultSchema } from "./consistency";

const BaseRunEventSchema = z
  .object({
    run_id: IdSchema,
    project_id: IdSchema.optional(),
    current_stage: z.string().nullish(),
    stage: z.string().nullish(),
    next_stage: z.string().nullish(),
    current_agent: z.string().nullish(),
    progress: z.number().min(0).max(1).optional(),
    recovery_summary: RecoverySummarySchema.nullish(),
    preserved_stages: z.array(z.string()).optional(),
  })
  .passthrough();

export const ConnectedEventSchema: z.ZodTypeAny = z.object({ project_id: IdSchema }).passthrough();

export const ErrorEventSchema: z.ZodTypeAny = z
  .object({ message: z.string().optional(), error: z.string().optional() })
  .passthrough();

export const RunStartedEventSchema = BaseRunEventSchema.extend({
  provider_snapshot: z.record(z.unknown()).nullish(),
}).passthrough();

export const RunProgressEventSchema = BaseRunEventSchema.passthrough();

export const RunMessageEventSchema: z.ZodTypeAny = z
  .object({
    agent: z.string().nullish(),
    role: z.string().nullish(),
    content: z.string(),
    summary: z.string().nullish(),
    progress: z.number().min(0).max(1).nullish(),
    is_loading: z.boolean().nullish(),
  })
  .passthrough();

export const AgentThinkingEventSchema: z.ZodTypeAny = z
  .object({
    agent: z.string(),
    phase: AgentThinkingPhaseSchema,
    content: z.string(),
    details: z.string().optional(),
  })
  .passthrough();

export const RunCompletedEventSchema: z.ZodTypeAny = z
  .object({
    run_id: IdSchema.optional(),
    project_id: IdSchema.optional(),
    current_stage: z.string().nullish(),
    current_agent: z.string().nullish(),
    message: z.string().nullish(),
    video_generation_pending: z.boolean().optional(),
  })
  .passthrough();

export const RunFailedEventSchema: z.ZodTypeAny = z
  .object({
    run_id: IdSchema.optional(),
    project_id: IdSchema.optional(),
    error: z.string().nullish(),
    agent: z.string().optional(),
    current_stage: z.string().nullish(),
  })
  .passthrough();

export const RunAwaitingConfirmEventSchema = BaseRunEventSchema.extend({
  agent: z.string(),
  gate: z.string().optional(),
  question: z.string().optional(),
  auto_mode: z.boolean().optional(),
  story_outline: StoryOutlineSchema.nullish(),
  visual_bible: z.string().nullish(),
  message: z.string().optional(),
  completed: z.boolean().optional(),
  next_step: z.string().optional(),
}).passthrough();

export const RunConfirmedEventSchema = BaseRunEventSchema.partial()
  .extend({ run_id: IdSchema })
  .passthrough();

export const RunCancelledEventSchema: z.ZodTypeAny = z
  .object({
    run_id: IdSchema.optional(),
    project_id: IdSchema.optional(),
    run_ids: z.array(IdSchema).optional(),
    cancelled_count: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const CharacterCreatedEventSchema: z.ZodTypeAny = z
  .object({ character: CharacterSchema })
  .passthrough();
export const CharacterUpdatedEventSchema = CharacterCreatedEventSchema;
export const CharacterDeletedEventSchema: z.ZodTypeAny = z
  .object({ character_id: IdSchema })
  .passthrough();

export const ShotCreatedEventSchema: z.ZodTypeAny = z.object({ shot: ShotSchema }).passthrough();
export const ShotUpdatedEventSchema = ShotCreatedEventSchema;
export const ShotDeletedEventSchema: z.ZodTypeAny = z.object({ shot_id: IdSchema }).passthrough();

export const OutlineUpdatedEventSchema: z.ZodTypeAny = z
  .object({
    project_id: IdSchema,
    story_outline: StoryOutlineSchema.nullish(),
    visual_bible: z.string().nullish(),
    outline_approved: z.boolean().optional(),
  })
  .passthrough();

export const ProjectUpdatedEventSchema = ProjectSchema.partial().passthrough();

export const DataClearedEventSchema: z.ZodTypeAny = z
  .object({ cleared_types: z.array(z.string()).optional() })
  .passthrough();

export const CritiqueResultEventSchema: z.ZodTypeAny = z
  .object({
    stage: z.string(),
    entity_type: z.string(),
    entity_id: IdSchema.nullish(),
    score: z.number(),
    threshold: z.number(),
    passed: z.boolean(),
    round: z.number().int().positive(),
    max_rounds: z.number().int().positive(),
    dimensions: z.record(z.number()),
    issues: z.array(z.string()),
    suggestions: z.array(z.string()),
    will_regenerate: z.boolean(),
  })
  .passthrough();

export const BibleUpdatedEventSchema: z.ZodTypeAny = z
  .object({
    character_id: IdSchema,
    visual_notes: z.string().optional(),
    reference_images_count: z.number().int().nonnegative().optional(),
    has_embedding: z.boolean().optional(),
  })
  .passthrough();

export const VersionCreatedEventSchema: z.ZodTypeAny = z
  .object({
    entity_type: VersionEntityTypeSchema,
    entity_id: IdSchema,
    version: z.number().int().nonnegative(),
    trigger: z.string(),
  })
  .passthrough();

export const VersionRollbackEventSchema: z.ZodTypeAny = z
  .object({
    entity_type: VersionEntityTypeSchema,
    entity_id: IdSchema,
    from_version: z.number().int().nonnegative(),
    to_version: z.number().int().nonnegative(),
  })
  .passthrough();

export const AudioGeneratedEventSchema: z.ZodTypeAny = z
  .object({
    shot_id: IdSchema,
    tts_url: z.string().optional(),
    bgm_type: z.string().optional(),
    duration: z.number().optional(),
  })
  .passthrough();

export const ExportCompletedEventSchema: z.ZodTypeAny = z
  .object({
    export_id: z.string(),
    format: z.string(),
    download_url: z.string().optional(),
    status: z.string(),
    error: z.string().optional(),
  })
  .passthrough();

export const ConsistencyEvalCompletedEventSchema: z.ZodTypeAny = z
  .object({
    project_id: IdSchema,
    source: z.enum(["auto", "manual"]).optional(),
    checked_at: z.string().optional(),
    summary: z
      .object({
        ok: z.number().int().nonnegative(),
        review: z.number().int().nonnegative(),
        drift: z.number().int().nonnegative(),
        unverifiable: z.number().int().nonnegative(),
      })
      .passthrough()
      .optional(),
    shots: z
      .array(
        z
          .object({
            shot_id: IdSchema,
            consistency_result: ShotConsistencyResultSchema,
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const ConsistencyRepairCompletedEventSchema: z.ZodTypeAny = z
  .object({
    project_id: IdSchema,
    source: z.enum(["auto", "manual"]).optional(),
    repaired: z.array(
      z
        .object({
          shot_id: IdSchema,
          order: z.number().int().nonnegative().nullable(),
          references: z.number().int().nonnegative(),
          verdict: z.string().nullish(),
          resolved: z.boolean(),
        })
        .passthrough(),
    ),
    skipped: z.array(z.object({ shot_id: IdSchema, reason: z.string() }).passthrough()),
    failed: z.array(z.object({ shot_id: IdSchema, error: z.string() }).passthrough()),
  })
  .passthrough();

/**
 * 事件名 → 运行时校验器。
 *
 * 这个对象同时被服务端出站校验使用；`Record<WsEventType, ...>` 保证
 * 常量表新增事件但这里漏配会直接编译失败。
 */
export const WS_EVENT_DATA_SCHEMAS: Record<WsEventType, z.ZodTypeAny> = {
  connected: ConnectedEventSchema,
  pong: z.record(z.unknown()),
  echo: z.record(z.unknown()),
  error: ErrorEventSchema,
  run_started: RunStartedEventSchema,
  run_progress: RunProgressEventSchema,
  run_message: RunMessageEventSchema,
  agent_thinking: AgentThinkingEventSchema,
  run_completed: RunCompletedEventSchema,
  run_failed: RunFailedEventSchema,
  run_awaiting_confirm: RunAwaitingConfirmEventSchema,
  run_confirmed: RunConfirmedEventSchema,
  run_cancelled: RunCancelledEventSchema,
  character_created: CharacterCreatedEventSchema,
  character_updated: CharacterUpdatedEventSchema,
  character_deleted: CharacterDeletedEventSchema,
  shot_created: ShotCreatedEventSchema,
  shot_updated: ShotUpdatedEventSchema,
  shot_deleted: ShotDeletedEventSchema,
  outline_updated: OutlineUpdatedEventSchema,
  project_updated: ProjectUpdatedEventSchema,
  data_cleared: DataClearedEventSchema,
  critique_result: CritiqueResultEventSchema,
  bible_updated: BibleUpdatedEventSchema,
  version_created: VersionCreatedEventSchema,
  version_rollback: VersionRollbackEventSchema,
  audio_generated: AudioGeneratedEventSchema,
  export_completed: ExportCompletedEventSchema,
  consistency_eval_completed: ConsistencyEvalCompletedEventSchema,
  consistency_repair_completed: ConsistencyRepairCompletedEventSchema,
};

export interface WsContractIssue {
  path: string;
  message: string;
}

export function validateWsEventData(
  event: WsEventType,
  data: unknown,
): { ok: true } | { ok: false; issues: WsContractIssue[] } {
  const result = WS_EVENT_DATA_SCHEMAS[event].safeParse(data);
  if (result.success) return { ok: true };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

// 运行时 map 与事件常量表必须等长；启动/测试时能直接发现漏项。
export const WS_EVENT_SCHEMA_COVERAGE =
  WS_EVENT_TYPES.length === Object.keys(WS_EVENT_DATA_SCHEMAS).length;
