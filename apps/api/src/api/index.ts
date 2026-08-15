import { Hono, type Context, type MiddlewareHandler } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import type { Env } from "../env";
import { LeverError } from "../error";
import type { AdminIdentity } from "../service/admin-auth";
import type { CompiledEnv } from "../service/resolve-cache";

export interface AppVariables {
  requestId: string;
  /** Set by adminAuth: the live account, its live grants, and the session (§8.1.4). */
  admin: AdminIdentity;
  /** Set by clientKeyAuth on the resolve/stream surface (§6.1). */
  compiledEnv: CompiledEnv;
}

/**
 * The composition-root registry rides in `Bindings`, so every handler reaches
 * its services as `c.env.services.…` instead of receiving them through a
 * factory. `app.ts` installs it in one middleware; tests install their own
 * registry over a `:memory:` database the same way.
 */
export type AppEnv = { Bindings: Env; Variables: AppVariables };

export type LeverContext = Context<AppEnv>;
export type LeverMiddleware = MiddlewareHandler<AppEnv>;

export function createHono(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}

/**
 * The §5.1 envelope. Four members in every JSON response, success and failure
 * alike: `ok` mirrors the status so a client behind a transport it does not own
 * need not trust status rewriting, and `message` is human-facing only — nothing
 * may branch on it and no fixture asserts it.
 */
export interface Envelope {
  ok: boolean;
  message: string;
  data: unknown;
  error: { code: string; details?: unknown } | null;
}

export function ok(message: string, data: unknown = null, status = 200): Response {
  const body: Envelope = { ok: true, message, data, error: null };
  return Response.json(body, { status });
}

export function failure(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  const body: Envelope = {
    ok: false,
    message,
    data: null,
    error: { code, ...(details === undefined ? {} : { details }) },
  };
  return Response.json(body, { status });
}

/**
 * Validates a request target with zod, rendering failures in the §5.2 shape
 * (400 `validation_failed` with treeified issues in `error.details`) via the
 * app-level onError.
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
