import { z } from "zod";
import { IdSchema } from "./common";

const ExpectedStatusSchema = z.enum(["consistent", "review", "drift", "missing", "no_reference"]);
const VerdictSchema = z.enum(["ok", "review", "drift", "unverifiable"]);

const BoxSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .passthrough();

export const ConsistencyExpectedSchema: z.ZodTypeAny = z
  .object({
    characterId: IdSchema,
    name: z.string(),
    status: ExpectedStatusSchema,
    distance: z.number().nullable(),
  })
  .passthrough();

export const ConsistencyExtraFaceSchema: z.ZodTypeAny = z
  .object({
    box: BoxSchema.optional(),
    score: z.number(),
    nearestCharacterId: IdSchema.nullable(),
    nearestName: z.string().nullable(),
    distance: z.number().nullable(),
    kind: z.enum(["other_character", "lookalike", "unknown"]),
  })
  .passthrough();

export const ConsistencyShotSchema: z.ZodObject<z.ZodRawShape> = z
  .object({
    shotId: IdSchema,
    order: z.number().int().nonnegative(),
    expected: z.array(ConsistencyExpectedSchema),
    extraFaces: z.array(ConsistencyExtraFaceSchema),
    verdict: VerdictSchema,
    message: z.string(),
  })
  .passthrough();

export const ShotConsistencyResultSchema = ConsistencyShotSchema.extend({
  checkedAt: z.string(),
}).passthrough();

export const ConsistencyReportSchema: z.ZodTypeAny = z
  .object({
    projectId: IdSchema,
    checkedAt: z.string().optional(),
    thresholds: z
      .object({
        ok: z.number(),
        drift: z.number(),
        matchLimit: z.number(),
      })
      .passthrough(),
    characters: z.array(
      z
        .object({
          characterId: IdSchema,
          name: z.string(),
          referenceFaces: z.number().int().nonnegative(),
        })
        .passthrough(),
    ),
    shots: z.array(ConsistencyShotSchema),
    summary: z
      .object({
        ok: z.number().int().nonnegative(),
        review: z.number().int().nonnegative(),
        drift: z.number().int().nonnegative(),
        unverifiable: z.number().int().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();

export const ShotRepairResultSchema: z.ZodTypeAny = z
  .object({
    shotId: IdSchema,
    imageUrl: z.string(),
    references: z.number().int().nonnegative(),
    before: ConsistencyShotSchema.extend({ checkedAt: z.string().optional() }).nullable(),
    after: ConsistencyShotSchema.extend({ checkedAt: z.string().optional() }).nullable(),
  })
  .passthrough();
