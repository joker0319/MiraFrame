import { z } from "zod";
import { IdSchema } from "./common";

const providerOverride = z.string().nullish();

/** 建项目：只有 title 必填，其余沿用旧接口的可选语义。 */
export const CreateProjectSchema: z.ZodObject<z.ZodRawShape> = z
  .object({
    title: z.string().min(1).max(200),
    story: z.string().nullish(),
    style: z.string().nullish(),
    target_shot_count: z.number().int().positive().nullish(),
    character_hints: z.array(z.string()).nullish(),
    creation_mode: z.string().nullish(),
    reference_images: z.array(z.string()).nullish(),
    universe_id: IdSchema.nullish(),
    chapter_number: z.number().int().nullish(),
    chapter_title: z.string().nullish(),
    text_provider_override: providerOverride,
    image_provider_override: providerOverride,
    video_provider_override: providerOverride,
  })
  .passthrough();

export const UpdateProjectSchema = CreateProjectSchema.partial()
  .extend({
    summary: z.string().nullish(),
    status: z.string().nullish(),
    video_url: z.string().nullish(),
    outline_approved: z.boolean().nullish(),
    exports: z.array(z.string()).nullish(),
  })
  .passthrough();

export const RevisionEntityTypeSchema: z.ZodTypeAny = z.enum([
  "outline",
  "character",
  "characters",
  "shots",
  "shot",
  "project_video",
]);

export const RevisionFeedbackTypeSchema: z.ZodTypeAny = z.enum([
  "rewrite",
  "regenerate",
  "regenerate_image",
  "regenerate_video",
  "style",
  "motion",
  "dialogue",
  "script",
]);

export const ProjectRevisionSchema: z.ZodTypeAny = z
  .object({
    content: z.string().trim().min(1),
    feedback_type: RevisionFeedbackTypeSchema.optional(),
    entity_type: RevisionEntityTypeSchema.optional(),
    entity_id: IdSchema.optional(),
  })
  .passthrough();

export const FeedbackSchema: z.ZodTypeAny = z
  .object({
    content: z.string().min(1),
    run_id: IdSchema.optional(),
    feedback_type: z.string().optional(),
    entity_type: z.string().optional(),
    entity_id: IdSchema.optional(),
  })
  .passthrough();

export const GenerateRequestSchema: z.ZodTypeAny = z
  .object({
    auto_mode: z.boolean().optional(),
    target_stage: z.string().optional(),
  })
  .passthrough();

export const ResumeRequestSchema: z.ZodTypeAny = z
  .object({
    confirm: z.boolean().optional(),
    feedback: z.string().optional(),
  })
  .passthrough();

export const ApproveOutlineRequestSchema: z.ZodTypeAny = z
  .object({
    feedback: z.string().optional(),
  })
  .passthrough();

export const CharacterUpdateSchema: z.ZodTypeAny = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullish(),
    image_url: z.string().nullish(),
    visual_notes: z.string().nullish(),
    reference_images: z.array(z.string()).nullish(),
  })
  .passthrough();

export const ShotUpdateSchema: z.ZodTypeAny = z
  .object({
    order: z.number().int().nonnegative().optional(),
    description: z.string().nullish(),
    prompt: z.string().nullish(),
    image_prompt: z.string().nullish(),
    duration: z.number().positive().nullish(),
    camera: z.string().nullish(),
    motion_note: z.string().nullish(),
    scene: z.string().nullish(),
    action: z.string().nullish(),
    expression: z.string().nullish(),
    lighting: z.string().nullish(),
    dialogue: z.string().nullish(),
    sfx: z.string().nullish(),
    seed: z.number().int().nullish(),
    character_ids: z.array(IdSchema).optional(),
  })
  .passthrough();

export const BibleUpdateSchema: z.ZodTypeAny = z
  .object({
    visual_notes: z.string().nullish(),
    reference_images: z.array(z.string()).optional(),
  })
  .passthrough();

export const AddReferenceImageSchema: z.ZodTypeAny = z
  .object({
    image_url: z.string().min(1),
  })
  .passthrough();

export const RegenerateShotRequestSchema: z.ZodTypeAny = z
  .object({
    type: z.enum(["image", "video"]).optional(),
  })
  .passthrough();

export const ConfigUpdateSchema = z
  .object({
    configs: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .passthrough();

export const TestConnectionSchema = z
  .object({
    service: z.enum(["llm", "image", "video"]).optional(),
    config_overrides: z.record(z.union([z.string(), z.null()])).optional(),
  })
  .passthrough();
