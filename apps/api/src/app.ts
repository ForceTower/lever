import type { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import packageJson from "../package.json";
import { createAdminRoutes } from "./api/admin/index";
import { createHono, type AppEnv } from "./api/index";
import { requestContext } from "./api/middleware";
import { createResolveRoutes } from "./api/resolve";
import { createStreamRoutes } from "./api/stream";
import type { Env } from "./env";
import { LeverError } from "./error";
import { getLogger } from "./logger";

function errorResponse(status: number, code: string, message: string, details?: unknown) {
  return Response.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status },
  );
}

/**
 * Assembles the Hono app over the composition-root registry (§1). Tests drive
 * this via `app.request()` on a `:memory:` database; the boot entry (Phase 6)
 * passes `getEnv()`.
 */
export function createApp(env: Env): Hono<AppEnv> {
  const app = createHono();

  app.use(requestContext());

  app.onError((error, c) => {
    if (error instanceof LeverError) {
      return errorResponse(error.statusCode, error.code, error.message, error.details);
    }
    // Hono's own 4xx (e.g. malformed JSON from the validator) keeps the §5 shape.
    if (error instanceof HTTPException) {
      return errorResponse(error.status, "bad_request", error.message);
    }
    getLogger().withMetadata({ path: c.req.path }).withError(error).error("unhandled error");
    return errorResponse(500, "internal_error", "internal server error");
  });

  app.notFound(() => errorResponse(404, "not_found", "route not found"));

  app.get("/healthz", (c) => c.json({ name: "lever", version: packageJson.version }));

  // §5 CORS: the public read surface answers cross-origin browsers; ETag must
  // be exposed or the 304 path silently degrades to full refetches. /v1/admin
  // gets no CORS — the dashboard is served same-origin (§9.4).
  const origins = env.vars.LEVER_ALLOWED_ORIGINS;
  const readCors = cors({
    origin: origins === "*" ? "*" : origins.split(",").map((origin) => origin.trim()),
    exposeHeaders: ["ETag"],
  });
  app.use("/v1/resolve", readCors);
  app.use("/v1/stream", readCors);
  app.route("/v1/resolve", createResolveRoutes(env.resolveCache));
  app.route("/v1/stream", createStreamRoutes(env.streams, env.resolveCache));

  app.route("/v1/admin", createAdminRoutes(env));

  return app;
}
