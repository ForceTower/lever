import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import { LeverError } from "../error";
import type { CompiledEnv } from "../service/resolve-cache";

export interface AppVariables {
  requestId: string;
  /** Set by adminAuth; becomes `versions.author` on publish (§8.1). */
  adminName: string;
  /** Set by clientKeyAuth on the resolve/stream surface (§6.1). */
  compiledEnv: CompiledEnv;
}

export type AppEnv = { Variables: AppVariables };

export function createHono(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}

/**
 * Validates a request target with zod, rendering failures in the §5 error
 * shape (400 `validation_failed` with treeified issues) via the app-level
 * onError.
 */
export function zValidator<Schema extends z.ZodType>(
  target: "json" | "query" | "param",
  schema: Schema,
) {
  return validator(target, (value): z.output<Schema> => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new LeverError(400, "validation_failed", "request validation failed", {
        details: z.treeifyError(parsed.error),
      });
    }
    return parsed.data;
  });
}
