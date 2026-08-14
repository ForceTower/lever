import type { Hono } from "hono";
import { z } from "zod";
import type { ParametersService } from "../../service/admin/parameters";
import { jsonValueSchema, parameterTypeSchema } from "../../service/snapshot";
import { createHono, zValidator, type AppEnv } from "../index";

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

export function createParameterRoutes(parameters: ParametersService): Hono<AppEnv> {
  const app = createHono();

  app.get("/environments/:envId/parameters", async (c) =>
    c.json(await parameters.listByEnvironment(c.req.param("envId"))),
  );

  app.post("/environments/:envId/parameters", zValidator("json", createBodySchema), async (c) =>
    c.json(await parameters.create(c.req.param("envId"), c.req.valid("json")), 201),
  );

  app.get("/parameters/:parameterId", async (c) =>
    c.json(await parameters.get(c.req.param("parameterId"))),
  );

  app.patch("/parameters/:parameterId", zValidator("json", patchBodySchema), async (c) =>
    c.json(await parameters.update(c.req.param("parameterId"), c.req.valid("json"))),
  );

  app.delete("/parameters/:parameterId", async (c) => {
    await parameters.remove(c.req.param("parameterId"));
    return c.body(null, 204);
  });

  app.put(
    "/parameters/:parameterId/conditional-values",
    zValidator("json", conditionalValuesBodySchema),
    async (c) =>
      c.json(
        await parameters.replaceConditionalValues(c.req.param("parameterId"), c.req.valid("json")),
      ),
  );

  return app;
}
