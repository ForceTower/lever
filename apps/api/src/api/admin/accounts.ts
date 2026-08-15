/**
 * The §8.1 identity management surface. The whole surface is behind
 * `accounts:manage` — this is the permission that can grant permissions.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../service/permissions";
import { createHono, ok, zValidator } from "../index";
import { requirePermission } from "../middleware";
import { displayNameSchema } from "./schemas";

/**
 * Mounted at /v1/admin/accounts, so the blanket permission below applies to
 * this surface and nothing else — a `use("*")` on a router mounted at `/` would
 * gate every admin route with `accounts:manage`.
 */
export const accountRoutes = createHono();

accountRoutes.use("*", requirePermission("accounts:manage"));

const usernameSchema = z
  .string()
  .regex(/^[a-z0-9-]{1,32}$/, "must be a slug of [a-z0-9-], 1-32 chars");

const permissionsSchema = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);

const createBodySchema = z.strictObject({
  username: usernameSchema,
  name: displayNameSchema,
  permissions: permissionsSchema.default([]),
});
const patchBodySchema = z.strictObject({
  name: displayNameSchema.optional(),
  disabled: z.boolean().optional(),
});
const grantsBodySchema = z.strictObject({ permissions: permissionsSchema });

accountRoutes.get("/", async (c) => ok("Accounts", await c.env.services.adminAuth.listAccounts()));

accountRoutes.post("/", zValidator("json", createBodySchema), async (c) =>
  // The enrollment code in the response is shown exactly once — only its hash
  // is stored (§8.1.2).
  ok("Account created", await c.env.services.adminAuth.createAccount(c.req.valid("json")), 201),
);

accountRoutes.get("/:accountId", async (c) =>
  ok("Account", await c.env.services.adminAuth.getAccount(c.req.param("accountId"))),
);

accountRoutes.patch("/:accountId", zValidator("json", patchBodySchema), async (c) =>
  ok(
    "Account updated",
    await c.env.services.adminAuth.updateAccount(c.req.param("accountId"), c.req.valid("json")),
  ),
);

accountRoutes.delete("/:accountId", async (c) => {
  await c.env.services.adminAuth.deleteAccount(c.req.param("accountId"));
  return ok("Account deleted");
});

accountRoutes.post("/:accountId/enrollments", async (c) =>
  ok(
    "Enrollment code minted",
    await c.env.services.adminAuth.mintEnrollment(c.req.param("accountId")),
    201,
  ),
);

accountRoutes.put("/:accountId/grants", zValidator("json", grantsBodySchema), async (c) =>
  ok(
    "Grants replaced",
    await c.env.services.adminAuth.replaceGrants(
      c.get("admin"),
      c.req.param("accountId"),
      c.req.valid("json").permissions,
    ),
  ),
);

accountRoutes.get("/:accountId/credentials", async (c) => {
  const credentials = await c.env.services.adminAuth.listCredentials(c.req.param("accountId"));
  // The public key is never echoed: it is useless to the portal and only widens
  // what a compromised session can read.
  return ok(
    "Credentials",
    credentials.map((credential) => ({
      id: credential.id,
      name: credential.name,
      transports: credential.transports,
      createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt,
    })),
  );
});

accountRoutes.delete("/:accountId/credentials/:credentialId", async (c) => {
  await c.env.services.adminAuth.removeCredential(
    c.req.param("accountId"),
    c.req.param("credentialId"),
  );
  return ok("Credential removed");
});

accountRoutes.get("/:accountId/sessions", async (c) =>
  ok("Sessions", await c.env.services.adminAuth.listSessions(c.req.param("accountId"))),
);

/** Mounted at /v1/admin/sessions, for the same scoping reason as above. */
export const sessionRoutes = createHono();

sessionRoutes.use("*", requirePermission("accounts:manage"));

sessionRoutes.delete("/:sessionId", async (c) => {
  await c.env.services.adminAuth.revokeSession(c.req.param("sessionId"));
  return ok("Session revoked");
});
