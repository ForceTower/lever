import type { Hono } from "hono";
import { z } from "zod";
import type { ProjectsService } from "../../service/admin/projects";
import { createHono, zValidator, type AppEnv } from "../index";
import { confirmBodySchema, displayNameSchema, slugSchema } from "./schemas";

const createBodySchema = z.strictObject({ key: slugSchema, name: displayNameSchema });
const patchBodySchema = z.strictObject({ name: displayNameSchema });

export function createProjectRoutes(projects: ProjectsService): Hono<AppEnv> {
  const app = createHono();

  app.get("/projects", (c) => c.json(projects.list()));

  app.post("/projects", zValidator("json", createBodySchema), (c) =>
    c.json(projects.create(c.req.valid("json")), 201),
  );

  app.get("/projects/:projectId", (c) => c.json(projects.get(c.req.param("projectId"))));

  app.patch("/projects/:projectId", zValidator("json", patchBodySchema), (c) =>
    c.json(projects.rename(c.req.param("projectId"), c.req.valid("json").name)),
  );

  app.delete("/projects/:projectId", zValidator("json", confirmBodySchema), (c) => {
    projects.remove(c.req.param("projectId"), c.req.valid("json").confirm);
    return c.body(null, 204);
  });

  return app;
}
