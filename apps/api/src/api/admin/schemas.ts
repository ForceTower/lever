import { z } from "zod";

/** Project and environment keys share the §3.2 slug charset. */
export const slugSchema = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/, "must be a slug of [a-z0-9-], 1-64 chars");

export const displayNameSchema = z.string().min(1).max(256);

/** Destructive deletes echo the entity's key (§8.2). */
export const confirmBodySchema = z.strictObject({ confirm: z.string() });
