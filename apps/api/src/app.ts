import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import packageJson from "../package.json";
import { createAdminRoutes } from "./api/admin/index";
import { createHono, type AppEnv } from "./api/index";
import { requestContext } from "./api/middleware";
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

  app.route("/v1/admin", createAdminRoutes(env));

  return app;
}
