/**
 * The §8.1 unauthenticated ceremony surface plus the two session-scoped
 * endpoints the portal needs. Mounted at /v1/admin/auth, ahead of the guarded
 * router — this is how a session is obtained in the first place, so it cannot
 * sit behind `adminAuth`.
 */
import { z } from "zod";
import { createHono, ok, zValidator, type LeverContext } from "../index";
import { adminAuth } from "../middleware";
import { authenticationResponseSchema, registrationResponseSchema } from "./passkey-schemas";

export const authRoutes = createHono();

const enrollmentCodeSchema = z.string().min(1).max(128);
const challengeIdSchema = z.string().min(1).max(128);

const registerOptionsBody = z.strictObject({ code: enrollmentCodeSchema });
const registerVerifyBody = z.strictObject({
  code: enrollmentCodeSchema,
  challengeId: challengeIdSchema,
  credentialName: z.string().min(1).max(64),
  response: registrationResponseSchema,
});
const loginOptionsBody = z.strictObject({ username: z.string().min(1).max(32).optional() });
const loginVerifyBody = z.strictObject({
  challengeId: challengeIdSchema,
  response: authenticationResponseSchema,
});

authRoutes.post("/register/options", zValidator("json", registerOptionsBody), async (c) =>
  ok(
    "Registration options generated",
    await c.env.services.adminAuth.startRegistration(c.req.valid("json").code),
  ),
);

authRoutes.post("/register/verify", zValidator("json", registerVerifyBody), async (c) => {
  const body = c.req.valid("json");
  const session = await c.env.services.adminAuth.finishRegistration({
    code: body.code,
    challengeId: body.challengeId,
    credentialName: body.credentialName,
    response: body.response,
    ip: clientIp(c),
    userAgent: c.req.header("User-Agent") ?? null,
  });
  return ok("Passkey registered", session, 201);
});

authRoutes.post("/login/options", zValidator("json", loginOptionsBody), async (c) =>
  ok(
    "Authentication options generated",
    await c.env.services.adminAuth.startLogin(c.req.valid("json").username),
  ),
);

authRoutes.post("/login/verify", zValidator("json", loginVerifyBody), async (c) => {
  const body = c.req.valid("json");
  const session = await c.env.services.adminAuth.finishLogin({
    challengeId: body.challengeId,
    response: body.response,
    ip: clientIp(c),
    userAgent: c.req.header("User-Agent") ?? null,
  });
  return ok("Signed in", session);
});

// The two session-scoped routes carry adminAuth themselves rather than
// inheriting a router-wide guard the ceremony routes above must not have.
authRoutes.get("/session", adminAuth(), (c) => {
  const admin = c.get("admin");
  return ok("Current session", {
    account: { id: admin.account.id, username: admin.account.username, name: admin.account.name },
    permissions: admin.permissions,
    sessionId: admin.sessionId,
  });
});

authRoutes.post("/logout", adminAuth(), async (c) => {
  await c.env.services.adminAuth.logout(c.get("admin").sessionId);
  return ok("Signed out");
});

/** Cloudflare Tunnel fronts the deployment (research §4.6); CF-Connecting-IP is the client. */
function clientIp(c: LeverContext): string | null {
  const forwarded = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim();
  return c.req.header("CF-Connecting-IP") ?? (forwarded === undefined ? null : forwarded);
}
