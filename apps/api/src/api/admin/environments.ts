import { z } from "zod";
import { createHono, ok, zValidator } from "../index";
import { requirePermission } from "../middleware";
import { confirmBodySchema, slugSchema } from "./schemas";

export const environmentRoutes = createHono();

const createBodySchema = z.strictObject({ key: slugSchema });

environmentRoutes.get(
  "/projects/:projectId/environments",
  requirePermission("config:read"),
  async (c) =>
    ok("Environments", await c.env.services.environments.listByProject(c.req.param("projectId"))),
);

// The client key is generated server-side (§8.2) — the body carries only the key slug.
environmentRoutes.post(
  "/projects/:projectId/environments",
  requirePermission("config:write"),
  zValidator("json", createBodySchema),
  async (c) =>
    ok(
      "Environment created",
      await c.env.services.environments.create(c.req.param("projectId"), c.req.valid("json").key),
      201,
    ),
);

environmentRoutes.get("/environments/:envId", requirePermission("config:read"), async (c) =>
  ok("Environment", await c.env.services.environments.get(c.req.param("envId"))),
);

// Rotation invalidates the old key immediately and drops live streams — it
// breaks running clients, so it sits with the destructive verbs (§8.1.5).
environmentRoutes.post(
  "/environments/:envId/rotate-key",
  requirePermission("config:admin"),
  async (c) =>
    ok(
      "Client key rotated",
      await c.env.services.environments.rotateClientKey(c.req.param("envId")),
    ),
);

environmentRoutes.delete(
  "/environments/:envId",
  requirePermission("config:admin"),
  zValidator("json", confirmBodySchema),
  async (c) => {
    await c.env.services.environments.remove(c.req.param("envId"), c.req.valid("json").confirm);
    return ok("Environment deleted");
  },
);
