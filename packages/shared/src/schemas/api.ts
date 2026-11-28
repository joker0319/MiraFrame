import { z } from "zod";
import { IdSchema } from "./common";

export const GenerateRunResponseSchema = z
  .object({ run_id: IdSchema, status: z.string() })
  .passthrough();

export const ResumeRunResponseSchema = z.object({ status: z.string() }).passthrough();

export const CancelRunResponseSchema = z
  .object({
    status: z.string(),
    cancelled: z.number().int().nonnegative().optional(),
    run_id: IdSchema.optional(),
  })
  .passthrough();

export const ApproveOutlineResponseSchema = z
  .object({
    status: z.string(),
    action: z.enum(["started", "regenerate"]).optional(),
    run_id: IdSchema.optional(),
    resumed: z.boolean().optional(),
    feedback: z.string().optional(),
  })
  .passthrough();

export const RevisionResponseSchema = z
  .object({
    status: z.string(),
    run_id: IdSchema.optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export const FeedbackResponseSchema = z.object({ status: z.string() }).passthrough();

export const UploadReferenceResponseSchema = z
  .object({ url: z.string(), reference_images: z.array(z.string()) })
  .passthrough();

export const RegenerateCharacterResponseSchema = z
  .object({
    status: z.string(),
    character_id: IdSchema,
    project_id: IdSchema,
    run_id: IdSchema,
  })
  .passthrough();

export const RegenerateShotResponseSchema = z
  .object({
    status: z.string(),
    shot_id: IdSchema,
    project_id: IdSchema,
    type: z.enum(["image", "video"]),
    run_id: IdSchema,
  })
  .passthrough();

export const ComputeEmbeddingResponseSchema = z
  .object({ status: z.string(), character_id: IdSchema })
  .passthrough();
