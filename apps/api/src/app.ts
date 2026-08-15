import type { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import packageJson from "../package.json";
import { adminRoutes } from "./api/admin/index";
import { createHono, failure, ok, type AppEnv } from "./api/index";
import { requestContext } from "./api/middleware";
import { resolveRoutes } from "./api/resolve";
import { streamRoutes } from "./api/stream";
import type { Env } from "./env";
import { LeverError } from "./error";
import { getLogger } from "./logger";

/**
 * Assembles the Hono app over the composition-root registry (§1), injecting it
 * as `c.env` so handlers reach their services without a factory argument.
 * Tests drive this via `app.request()` on a `:memory:` database; the boot entry
 * passes `getEnv()`.
 */
export function createApp(env: Env): Hono<AppEnv> {
  const app = createHono();

  app.use("*", async (c, next) => {
    c.env = env;
    await next();
  });
  app.use(requestContext());

  app.onError((error, c) => {
    if (error instanceof LeverError) {
      return failure(error.statusCode, error.code, error.message, error.details);
    }
    // Hono's own 4xx (e.g. malformed JSON from the validator) keeps the §5.1 shape.
    if (error instanceof HTTPException) {
      return failure(error.status, "bad_request", error.message);
    }
    getLogger().withMetadata({ path: c.req.path }).withError(error).error("unhandled error");
    return failure(500, "internal_error", "internal server error");
  });

  app.notFound(() => failure(404, "not_found", "route not found"));

  app.get("/healthz", () => ok("lever", { name: "lever", version: packageJson.version }));

  // §5.3 CORS. Two allowlists because they are two trust tiers: the read surface
  // is public by design (research §3.4), while an authenticated surface that
  // echoed any origin is how a hostile page reaches an operator's session.
  // Neither sets Access-Control-Allow-Credentials — the session is a bearer
  // token in a header, never a cookie, so there is nothing for a browser to
  // attach implicitly (§8.1.4).
  const readOrigins = env.vars.LEVER_ALLOWED_ORIGINS;
  const readCors = cors({
    origin: readOrigins === "*" ? "*" : readOrigins.split(",").map((origin) => origin.trim()),
    // Without this browsers hide the ETag from cross-origin JS and the 304 path
    // silently degrades to full refetches.
    exposeHeaders: ["ETag"],
  });
  app.use("/v1/resolve", readCors);
  app.use("/v1/stream", readCors);
  app.route("/v1/resolve", resolveRoutes);
  app.route("/v1/stream", streamRoutes);

  app.use(
    "/v1/admin/*",
    cors({
      origin: env.vars.LEVER_ADMIN_ORIGINS,
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      maxAge: 86_400,
    }),
  );
  app.route("/v1/admin", adminRoutes);

  return app;
}
