import { z } from "zod";
import { ConfigValueSchema } from "./common";

export const ConfigItemSchema: z.ZodTypeAny = z
  .object({
    key: z.string(),
    value: ConfigValueSchema,
    is_sensitive: z.boolean(),
    is_masked: z.boolean(),
    source: z.enum(["db", "env", "default"]),
  })
  .passthrough();

export const ConfigListSchema: z.ZodTypeAny = z.array(ConfigItemSchema);
