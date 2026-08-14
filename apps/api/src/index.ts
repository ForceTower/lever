/**
 * Boot (spec 0001 §9): migrate → warm the resolve cache → listen. A container
 * that starts is a container whose schema is current and whose cache serves
 * every environment from memory.
 */
import { createApp } from "./app";
import { runMigrations } from "./db";
import { getEnv } from "./env";
import { getLogger } from "./logger";

const env = getEnv();
runMigrations(env.sqlite);
await env.resolveCache.warmUp(env.repos);

const app = createApp(env);
const server = Bun.serve({
  port: env.vars.PORT,
  fetch: app.fetch,
  // SSE streams idle between 25s heartbeats; the heartbeat is the liveness
  // mechanism (§7), so the server must not cut idle connections itself.
  idleTimeout: 0,
});

getLogger().withMetadata({ port: server.port }).info("lever listening");

function shutdown(): void {
  getLogger().info("shutting down");
  // Exit follows immediately — in-flight completion is not awaited on purpose.
  void server.stop();
  env.sqlite.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
