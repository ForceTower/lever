import { z } from "zod";
import { clausesSchema } from "../../service/snapshot";
import { createHono, ok, zValidator } from "../index";
import { requirePermission } from "../middleware";

export const conditionRoutes = createHono();

const conditionNameSchema = z.string().min(1).max(128);
const createBodySchema = z.strictObject({ name: conditionNameSchema, clauses: clausesSchema });
const patchBodySchema = z.strictObject({
  name: conditionNameSchema.optional(),
  clauses: clausesSchema.optional(),
});

conditionRoutes.get(
  "/environments/:envId/conditions",
  requirePermission("config:read"),
  async (c) =>
    ok("Conditions", await c.env.services.conditions.listByEnvironment(c.req.param("envId"))),
);

conditionRoutes.post(
  "/environments/:envId/conditions",
  requirePermission("config:write"),
  zValidator("json", createBodySchema),
  async (c) =>
    ok(
      "Condition created",
      await c.env.services.conditions.create(c.req.param("envId"), c.req.valid("json")),
      201,
    ),
);

conditionRoutes.get("/conditions/:conditionId", requirePermission("config:read"), async (c) =>
  ok("Condition", await c.env.services.conditions.get(c.req.param("conditionId"))),
);

conditionRoutes.patch(
  "/conditions/:conditionId",
  requirePermission("config:write"),
  zValidator("json", patchBodySchema),
  async (c) =>
    ok(
      "Condition updated",
      await c.env.services.conditions.update(c.req.param("conditionId"), c.req.valid("json")),
    ),
);

conditionRoutes.delete("/conditions/:conditionId", requirePermission("config:write"), async (c) => {
  await c.env.services.conditions.remove(c.req.param("conditionId"));
  return ok("Condition deleted");
});
