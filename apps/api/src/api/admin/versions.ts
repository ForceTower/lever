import { z } from "zod";
import { createHono, ok, zValidator, type LeverContext } from "../index";
import { requirePermission } from "../middleware";

/** Publish preview, publish, version history, rollback (§8.3–§8.5). */
export const versionRoutes = createHono();

const publishBodySchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative().optional(),
});

// z.object (not strict) — the param bag also carries envId.
const versionParamSchema = z.object({ n: z.coerce.number().int().positive() });

/** §3.2: the username is the durable record, the account id a best-effort join. */
function attribution(c: LeverContext): { author: string; authorAccountId: string } {
  const { account } = c.get("admin");
  return { author: account.username, authorAccountId: account.id };
}

versionRoutes.get("/environments/:envId/diff", requirePermission("config:read"), async (c) =>
  ok("Publish preview", await c.env.services.publish.preview(c.req.param("envId"))),
);

versionRoutes.post(
  "/environments/:envId/publish",
  requirePermission("config:publish"),
  zValidator("json", publishBodySchema),
  async (c) =>
    ok(
      "Published",
      await c.env.services.publish.publish(c.req.param("envId"), {
        ...attribution(c),
        expectedVersion: c.req.valid("json").expectedVersion,
      }),
      201,
    ),
);

versionRoutes.get("/environments/:envId/versions", requirePermission("config:read"), async (c) =>
  ok("Versions", await c.env.services.publish.listVersions(c.req.param("envId"))),
);

versionRoutes.get(
  "/environments/:envId/versions/:n",
  requirePermission("config:read"),
  zValidator("param", versionParamSchema),
  async (c) =>
    ok(
      "Version",
      await c.env.services.publish.getVersion(c.req.param("envId"), c.req.valid("param").n),
    ),
);

versionRoutes.post(
  "/environments/:envId/versions/:n/rollback",
  requirePermission("config:publish"),
  zValidator("param", versionParamSchema),
  async (c) =>
    ok(
      "Rolled back",
      await c.env.services.publish.rollback(
        c.req.param("envId"),
        c.req.valid("param").n,
        attribution(c),
      ),
      201,
    ),
);
