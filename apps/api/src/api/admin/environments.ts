import type { Hono } from "hono";
import { z } from "zod";
import type { EnvironmentsService } from "../../service/admin/environments";
import { createHono, zValidator, type AppEnv } from "../index";
import { confirmBodySchema, slugSchema } from "./schemas";

const createBodySchema = z.strictObject({ key: slugSchema });

export function createEnvironmentRoutes(environments: EnvironmentsService): Hono<AppEnv> {
  const app = createHono();

  app.get("/projects/:projectId/environments", async (c) =>
    c.json(await environments.listByProject(c.req.param("projectId"))),
  );

  // The client key is generated server-side (§8.2) — the body carries only the key slug.
  app.post("/projects/:projectId/environments", zValidator("json", createBodySchema), async (c) =>
    c.json(await environments.create(c.req.param("projectId"), c.req.valid("json").key), 201),
  );

  app.get("/environments/:envId", async (c) =>
    c.json(await environments.get(c.req.param("envId"))),
  );

  app.post("/environments/:envId/rotate-key", async (c) =>
    c.json(await environments.rotateClientKey(c.req.param("envId"))),
  );

  app.delete("/environments/:envId", zValidator("json", confirmBodySchema), async (c) => {
    await environments.remove(c.req.param("envId"), c.req.valid("json").confirm);
    return c.body(null, 204);
  });

  return app;
}
