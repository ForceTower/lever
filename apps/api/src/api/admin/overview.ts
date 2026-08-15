import { createHono, ok } from "../index";
import { requirePermission } from "../middleware";

/** §8.2 — the dashboard's landing read: projects, environments, version and dirty state. */
export const overviewRoutes = createHono();

overviewRoutes.get("/overview", requirePermission("config:read"), async (c) =>
  ok("Overview", await c.env.services.overview.list()),
);
