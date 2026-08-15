import { z } from "zod";
import { createHono, ok, zValidator } from "../index";
import { requirePermission } from "../middleware";
import { confirmBodySchema, displayNameSchema, slugSchema } from "./schemas";

export const projectRoutes = createHono();

const createBodySchema = z.strictObject({ key: slugSchema, name: displayNameSchema });
const patchBodySchema = z.strictObject({ name: displayNameSchema });

projectRoutes.get("/projects", requirePermission("config:read"), async (c) =>
  ok("Projects", await c.env.services.projects.list()),
);

projectRoutes.post(
  "/projects",
  requirePermission("config:write"),
  zValidator("json", createBodySchema),
  async (c) =>
    ok("Project created", await c.env.services.projects.create(c.req.valid("json")), 201),
);

projectRoutes.get("/projects/:projectId", requirePermission("config:read"), async (c) =>
  ok("Project", await c.env.services.projects.get(c.req.param("projectId"))),
);

projectRoutes.patch(
  "/projects/:projectId",
  requirePermission("config:write"),
  zValidator("json", patchBodySchema),
  async (c) =>
    ok(
      "Project renamed",
      await c.env.services.projects.rename(c.req.param("projectId"), c.req.valid("json").name),
    ),
);

// Cascades away every environment's version chain — its audit log (§8.2).
projectRoutes.delete(
  "/projects/:projectId",
  requirePermission("config:admin"),
  zValidator("json", confirmBodySchema),
  async (c) => {
    await c.env.services.projects.remove(c.req.param("projectId"), c.req.valid("json").confirm);
    return ok("Project deleted");
  },
);
