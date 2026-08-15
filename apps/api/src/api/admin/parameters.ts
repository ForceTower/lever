import { z } from "zod";
import { jsonValueSchema, parameterTypeSchema } from "../../service/snapshot";
import { createHono, ok, zValidator } from "../index";
import { requirePermission } from "../middleware";

export const parameterRoutes = createHono();

const parameterKeySchema = z
  .string()
  .regex(/^[a-zA-Z0-9_]{1,64}$/, "must be [a-zA-Z0-9_], 1-64 chars");
const descriptionSchema = z.string().max(1024);

const createBodySchema = z.strictObject({
  key: parameterKeySchema,
  type: parameterTypeSchema,
  defaultValue: jsonValueSchema,
  description: descriptionSchema.optional(),
});

const patchBodySchema = z.strictObject({
  key: parameterKeySchema.optional(),
  type: parameterTypeSchema.optional(),
  defaultValue: jsonValueSchema.optional(),
  description: descriptionSchema.nullable().optional(),
});

// The whole ordered list, replaced atomically — partial reorders are a footgun
// the API refuses to offer (§8.2). An empty list clears every conditional value.
const conditionalValuesBodySchema = z.array(
  z.strictObject({ conditionId: z.string(), value: jsonValueSchema }),
);

parameterRoutes.get(
  "/environments/:envId/parameters",
  requirePermission("config:read"),
  async (c) =>
    ok("Parameters", await c.env.services.parameters.listByEnvironment(c.req.param("envId"))),
);

parameterRoutes.post(
  "/environments/:envId/parameters",
  requirePermission("config:write"),
  zValidator("json", createBodySchema),
  async (c) =>
    ok(
      "Parameter created",
      await c.env.services.parameters.create(c.req.param("envId"), c.req.valid("json")),
      201,
    ),
);

parameterRoutes.get("/parameters/:parameterId", requirePermission("config:read"), async (c) =>
  ok("Parameter", await c.env.services.parameters.get(c.req.param("parameterId"))),
);

parameterRoutes.patch(
  "/parameters/:parameterId",
  requirePermission("config:write"),
  zValidator("json", patchBodySchema),
  async (c) =>
    ok(
      "Parameter updated",
      await c.env.services.parameters.update(c.req.param("parameterId"), c.req.valid("json")),
    ),
);

parameterRoutes.delete("/parameters/:parameterId", requirePermission("config:write"), async (c) => {
  await c.env.services.parameters.remove(c.req.param("parameterId"));
  return ok("Parameter deleted");
});

parameterRoutes.put(
  "/parameters/:parameterId/conditional-values",
  requirePermission("config:write"),
  zValidator("json", conditionalValuesBodySchema),
  async (c) =>
    ok(
      "Conditional values replaced",
      await c.env.services.parameters.replaceConditionalValues(
        c.req.param("parameterId"),
        c.req.valid("json"),
      ),
    ),
);
