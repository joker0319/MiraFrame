import { z } from "zod";
import { IdSchema, IsoDateSchema, ReviewStateSchema } from "./common";
import { ShotConsistencyResultSchema } from "./consistency";

/**
 * 模型产物允许暂时不完整（例如 fallback 只拿到 `{raw}`），
 * 所以 StoryOutline 的校验比类型更宽：字段可缺，未知字段保留。
 * 真正要求完整字段的地方是前端渲染逻辑，它自己做了缺省。
 */
export const StoryOutlineActSchema: z.ZodTypeAny = z
  .object({
    act: z.number(),
    title: z.string(),
    summary: z.string(),
  })
  .passthrough();

export const StoryOutlineSchema: z.ZodTypeAny = z
  .object({
    logline: z.string().optional(),
    genre: z.array(z.string()).optional(),
    themes: z.array(z.string()).optional(),
    setting: z.string().optional(),
    tone: z.string().optional(),
    acts: z.array(StoryOutlineActSchema).optional(),
    emotional_arc: z.string().optional(),
  })
  .passthrough();

export const ProjectProviderEntrySchema: z.ZodTypeAny = z
  .object({
    selected_key: z.string(),
    source: z.enum(["project", "default"]),
    resolved_key: z.string(),
    valid: z.boolean(),
    status: z.string(),
    reason_code: z.string().optional(),
    reason_message: z.string().optional(),
    capabilities: z
      .object({
        generate: z.boolean().optional(),
        stream: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const ProjectProviderSettingsSchema: z.ZodTypeAny = z
  .object({
    text: ProjectProviderEntrySchema,
    image: ProjectProviderEntrySchema,
    video: ProjectProviderEntrySchema,
  })
  .passthrough();

export const ProjectSchema: z.ZodObject<z.ZodRawShape> = z
  .object({
    id: IdSchema,
    title: z.string(),
    story: z.string().nullish(),
    style: z.string().nullish(),
    summary: z.string().nullish(),
    story_outline: StoryOutlineSchema.nullish(),
    visual_bible: z.string().nullish(),
    outline_approved: z.boolean().optional(),
    video_url: z.string().nullish(),
    status: z.string().nullish(),
    target_shot_count: z.number().int().nullish(),
    character_hints: z.array(z.string()).nullish(),
    creation_mode: z.string().nullish(),
    reference_images: z.array(z.string()).nullish(),
    exports: z.array(z.string()).nullish(),
    created_at: IsoDateSchema,
    updated_at: IsoDateSchema,
    provider_settings: ProjectProviderSettingsSchema.nullish(),
    universe_id: IdSchema.nullish(),
    chapter_number: z.number().int().nullish(),
    chapter_title: z.string().nullish(),
  })
  .passthrough();

export const CharacterSchema: z.ZodTypeAny = z
  .object({
    id: IdSchema,
    project_id: IdSchema,
    name: z.string(),
    description: z.string().nullish(),
    image_url: z.string().nullish(),
    reference_images: z.array(z.string()).nullish(),
    has_embedding: z.boolean().optional(),
    visual_notes: z.string().nullish(),
    approval_state: ReviewStateSchema.optional(),
    approval_version: z.number().int().nonnegative().optional(),
    approved_at: IsoDateSchema.nullish(),
    approved_name: z.string().nullish(),
    approved_description: z.string().nullish(),
    approved_image_url: z.string().nullish(),
  })
  .passthrough();

export const CharacterBibleSchema: z.ZodTypeAny = z
  .object({
    id: IdSchema,
    visual_notes: z.string().nullish(),
    reference_images: z.array(z.string()).nullish(),
    has_embedding: z.boolean().optional(),
  })
  .passthrough();

export const ShotSchema: z.ZodTypeAny = z
  .object({
    id: IdSchema,
    project_id: IdSchema,
    order: z.number().int().nonnegative(),
    description: z.string().nullish(),
    prompt: z.string().nullish(),
    image_prompt: z.string().nullish(),
    image_url: z.string().nullish(),
    video_url: z.string().nullish(),
    duration: z.number().nullish(),
    camera: z.string().nullish(),
    motion_note: z.string().nullish(),
    scene: z.string().nullish(),
    action: z.string().nullish(),
    expression: z.string().nullish(),
    lighting: z.string().nullish(),
    dialogue: z.string().nullish(),
    sfx: z.string().nullish(),
    tts_url: z.string().nullish(),
    bgm_type: z.string().nullish(),
    consistency_result: ShotConsistencyResultSchema.nullish(),
    seed: z.number().nullish(),
    character_ids: z.array(IdSchema).optional(),
    approval_state: ReviewStateSchema.optional(),
    approval_version: z.number().int().nonnegative().optional(),
    approved_at: IsoDateSchema.nullish(),
    approved_description: z.string().nullish(),
    approved_prompt: z.string().nullish(),
    approved_image_prompt: z.string().nullish(),
    approved_duration: z.number().nullish(),
    approved_camera: z.string().nullish(),
    approved_motion_note: z.string().nullish(),
    approved_scene: z.string().nullish(),
    approved_action: z.string().nullish(),
    approved_expression: z.string().nullish(),
    approved_lighting: z.string().nullish(),
    approved_dialogue: z.string().nullish(),
    approved_sfx: z.string().nullish(),
    approved_character_ids: z.array(IdSchema).nullish(),
  })
  .passthrough();
