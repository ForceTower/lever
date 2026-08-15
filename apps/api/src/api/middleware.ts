import { LeverError } from "../error";
import { getLogger, runWithLogger } from "../logger";
import { unauthorized } from "../service/admin-auth";
import type { Permission } from "../service/permissions";
import type { LeverMiddleware } from "./index";

const MAX_AUDIT_BODY_BYTES = 16 * 1024;

/** Binds a request id to the AsyncLocalStorage logger context (§9.2). */
export function requestContext(): LeverMiddleware {
  return (c, next) => {
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    return runWithLogger({ requestId }, next);
  };
}

function bearer(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

/**
 * §8.1.4 admin auth: `Authorization: Bearer ls_…` resolved to a live session,
 * a live account, and that account's **live** grants — read per request, never
 * carried in the token, so a revoked grant applies with no re-login. Every
 * failure is the same generic 401; the middleware is never an oracle for
 * session or grant state. Client keys are not sessions, so they can never
 * reach `/v1/admin` (§7).
 */
export function adminAuth(): LeverMiddleware {
  return async (c, next) => {
    const token = bearer(c.req.header("Authorization"));
    const identity =
      token === undefined ? undefined : await c.env.services.adminAuth.authenticate(token);
    if (identity === undefined) {
      getLogger().withMetadata({ path: c.req.path }).warn("admin auth failed");
      throw unauthorized();
    }
    c.set("admin", identity);
    getLogger().withContext({ username: identity.account.username });
    await next();
  };
}

/** §8.1.5 — gates one route on one permission. Runs after `adminAuth`. */
export function requirePermission(permission: Permission): LeverMiddleware {
  return async (c, next) => {
    if (!c.get("admin").permissions.includes(permission)) {
      throw new LeverError(403, "forbidden", `missing permission: ${permission}`);
    }
    await next();
  };
}

/**
 * §8.1.6 — records every mutating admin request after its handler runs. Audit
 * write failures log and never fail the request: availability over
 * completeness, and the request logger keeps the trace either way.
 */
export function adminAudit(): LeverMiddleware {
  return async (c, next) => {
    if (c.req.method === "GET") {
      await next();
      return;
    }
    const body = await captureBody(c.req.raw, c.req.path);

    // A rejected write is exactly the kind of thing an audit log exists to
    // record, and route-level guards (validation, requirePermission) signal by
    // throwing — so the status is taken from the error rather than from `c.res`,
    // which app.onError has not built yet.
    let status: number;
    let thrown: unknown;
    let failed = false;
    try {
      await next();
      status = c.res.status;
    } catch (error) {
      thrown = error;
      failed = true;
      status = error instanceof LeverError ? error.statusCode : 500;
    }

    // Always set: adminAuth is registered ahead of this middleware, so a failure
    // there means this body never runs.
    const admin = c.get("admin");
    try {
      await c.env.repos.adminAudit.insert({
        accountId: admin.account.id,
        username: admin.account.username,
        sessionId: admin.sessionId,
        method: c.req.method,
        path: c.req.path,
        status,
        body,
      });
    } catch (error) {
      getLogger().withError(error).error("admin audit write failed");
    }
    if (failed) throw thrown;
  };
}

/**
 * The parsed JSON body when the request carried one and it fits the cap; null
 * otherwise. Bodies on the credential-bearing paths are never captured (§8.1.6)
 * — an audit log that stores enrollment codes is a liability, not a record.
 * The request is cloned, so Hono's own body cache is untouched.
 */
async function captureBody(request: Request, path: string): Promise<unknown> {
  if (isCredentialPath(path)) return null;

  const contentType = request.headers.get("content-type");
  if (contentType === null || !contentType.includes("application/json")) return null;

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIT_BODY_BYTES) return null;

  try {
    const raw = await request.clone().text();
    if (Buffer.byteLength(raw, "utf8") > MAX_AUDIT_BODY_BYTES) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function isCredentialPath(path: string): boolean {
  return path.includes("/admin/auth/") || path.endsWith("/enrollments");
}

/**
 * §6.1 client-key auth for resolve and stream: `Authorization: Bearer pk_…`
 * or, for EventSource-style clients that cannot set headers, `?key=pk_…`.
 * The lookup is the cache's auth index — no I/O. Client keys authorize
 * exactly this read surface for one environment (research §7).
 */
export function clientKeyAuth(): LeverMiddleware {
  return async (c, next) => {
    const clientKey = bearer(c.req.header("Authorization")) ?? c.req.query("key") ?? "";
    const compiledEnv = c.env.resolveCache.getByClientKey(clientKey);
    if (compiledEnv === undefined) {
      throw new LeverError(401, "invalid_key", "unknown client key");
    }
    c.set("compiledEnv", compiledEnv);
    await next();
  };
}
