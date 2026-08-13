import type { Hono } from "hono";
import { z } from "zod";
import type { PublishService } from "../../service/publish";
import { createHono, zValidator, type AppEnv } from "../index";

const publishBodySchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative().optional(),
});

// z.object (not strict) — the param bag also carries envId.
const versionParamSchema = z.object({ n: z.coerce.number().int().positive() });

/** Publish preview, publish, version history, rollback (§8.3–§8.5). */
export function createVersionRoutes(publish: PublishService): Hono<AppEnv> {
  const app = createHono();

  app.get("/environments/:envId/diff", (c) => c.json(publish.preview(c.req.param("envId"))));

  app.post("/environments/:envId/publish", zValidator("json", publishBodySchema), (c) =>
    c.json(
      publish.publish(c.req.param("envId"), {
        author: c.get("adminName"),
        expectedVersion: c.req.valid("json").expectedVersion,
      }),
      201,
    ),
  );

  app.get("/environments/:envId/versions", (c) =>
    c.json(publish.listVersions(c.req.param("envId"))),
  );

  app.get("/environments/:envId/versions/:n", zValidator("param", versionParamSchema), (c) =>
    c.json(publish.getVersion(c.req.param("envId"), c.req.valid("param").n)),
  );

  app.post(
    "/environments/:envId/versions/:n/rollback",
    zValidator("param", versionParamSchema),
    (c) =>
      c.json(
        publish.rollback(c.req.param("envId"), c.req.valid("param").n, c.get("adminName")),
        201,
      ),
  );

  return app;
}
