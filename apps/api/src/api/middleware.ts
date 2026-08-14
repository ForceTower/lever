import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AdminToken } from "../env";
import { LeverError } from "../error";
import { getLogger, runWithLogger } from "../logger";
import type { ResolveCache } from "../service/resolve-cache";
import type { AppEnv } from "./index";

/** Binds a request id to the AsyncLocalStorage logger context (§9.2). */
export function requestContext(): MiddlewareHandler<AppEnv> {
  return (c, next) => {
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    return runWithLogger({ requestId }, next);
  };
}

// Hashing both sides equalizes lengths so timingSafeEqual applies; with
// ≥190-bit secrets this is belt and braces, not a real defense surface (§8.1).
function secretsEqual(a: string, b: string): boolean {
  const hashA = new Bun.CryptoHasher("sha256").update(a).digest();
  const hashB = new Bun.CryptoHasher("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * §8.1 admin auth: `Authorization: Bearer <secret>` against the static token
 * list; the matched name lands on the context for `versions.author`. Client
 * keys are not in the list, so they can never reach `/v1/admin` (§7).
 */
export function adminAuth(tokens: AdminToken[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("Authorization");
    const secret = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : "";
    const matched = tokens.find((token) => secretsEqual(token.secret, secret));
    if (matched === undefined) {
      getLogger().withMetadata({ path: c.req.path }).warn("admin auth failed");
      throw new LeverError(401, "unauthorized", "missing or invalid admin token");
    }
    c.set("adminName", matched.name);
    await next();
  };
}

/**
 * §6.1 client-key auth for resolve and stream: `Authorization: Bearer pk_…`
 * or, for EventSource-style clients that cannot set headers, `?key=pk_…`.
 * The lookup is the cache's auth index — no I/O. Client keys authorize
 * exactly this read surface for one environment (research §7).
 */
export function clientKeyAuth(cache: ResolveCache): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("Authorization");
    const clientKey =
      header?.startsWith("Bearer ") === true
        ? header.slice("Bearer ".length)
        : (c.req.query("key") ?? "");
    const compiledEnv = cache.getByClientKey(clientKey);
    if (compiledEnv === undefined) {
      throw new LeverError(401, "invalid_key", "unknown client key");
    }
    c.set("compiledEnv", compiledEnv);
    await next();
  };
}
