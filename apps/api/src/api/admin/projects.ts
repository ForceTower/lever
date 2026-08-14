import type { Hono } from "hono";
import { z } from "zod";
import type { ProjectsService } from "../../service/admin/projects";
import { createHono, zValidator, type AppEnv } from "../index";
import { confirmBodySchema, displayNameSchema, slugSchema } from "./schemas";

const createBodySchema = z.strictObject({ key: slugSchema, name: displayNameSchema });
const patchBodySchema = z.strictObject({ name: displayNameSchema });

export function createProjectRoutes(projects: ProjectsService): Hono<AppEnv> {
  const app = createHono();

  app.get("/projects", async (c) => c.json(await projects.list()));

  app.post("/projects", zValidator("json", createBodySchema), async (c) =>
    c.json(await projects.create(c.req.valid("json")), 201),
  );

  app.get("/projects/:projectId", async (c) =>
    c.json(await projects.get(c.req.param("projectId"))),
  );

  app.patch("/projects/:projectId", zValidator("json", patchBodySchema), async (c) =>
    c.json(await projects.rename(c.req.param("projectId"), c.req.valid("json").name)),
  );

  app.delete("/projects/:projectId", zValidator("json", confirmBodySchema), async (c) => {
    await projects.remove(c.req.param("projectId"), c.req.valid("json").confirm);
    return c.body(null, 204);
  });

  return app;
}
