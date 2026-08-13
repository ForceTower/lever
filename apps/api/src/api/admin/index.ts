import type { Hono } from "hono";
import type { Env } from "../../env";
import { createHono, type AppEnv } from "../index";
import { adminAuth } from "../middleware";
import { createConditionRoutes } from "./conditions";
import { createEnvironmentRoutes } from "./environments";
import { createParameterRoutes } from "./parameters";
import { createProjectRoutes } from "./projects";

/** The §8.2 admin surface, mounted under /v1/admin, all behind adminAuth. */
export function createAdminRoutes(env: Env): Hono<AppEnv> {
  const app = createHono();
  app.use(adminAuth(env.vars.LEVER_ADMIN_TOKENS));
  app.route("/", createProjectRoutes(env.services.projects));
  app.route("/", createEnvironmentRoutes(env.services.environments));
  app.route("/", createConditionRoutes(env.services.conditions));
  app.route("/", createParameterRoutes(env.services.parameters));
  return app;
}
