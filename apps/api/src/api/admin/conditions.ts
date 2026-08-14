import type { Hono } from "hono";
import { z } from "zod";
import type { ConditionsService } from "../../service/admin/conditions";
import { clausesSchema } from "../../service/snapshot";
import { createHono, zValidator, type AppEnv } from "../index";

const conditionNameSchema = z.string().min(1).max(128);
const createBodySchema = z.strictObject({ name: conditionNameSchema, clauses: clausesSchema });
const patchBodySchema = z.strictObject({
  name: conditionNameSchema.optional(),
  clauses: clausesSchema.optional(),
});

export function createConditionRoutes(conditions: ConditionsService): Hono<AppEnv> {
  const app = createHono();

  app.get("/environments/:envId/conditions", async (c) =>
    c.json(await conditions.listByEnvironment(c.req.param("envId"))),
  );

  app.post("/environments/:envId/conditions", zValidator("json", createBodySchema), async (c) =>
    c.json(await conditions.create(c.req.param("envId"), c.req.valid("json")), 201),
  );

  app.get("/conditions/:conditionId", async (c) =>
    c.json(await conditions.get(c.req.param("conditionId"))),
  );

  app.patch("/conditions/:conditionId", zValidator("json", patchBodySchema), async (c) =>
    c.json(await conditions.update(c.req.param("conditionId"), c.req.valid("json"))),
  );

  app.delete("/conditions/:conditionId", async (c) => {
    await conditions.remove(c.req.param("conditionId"));
    return c.body(null, 204);
  });

  return app;
}
