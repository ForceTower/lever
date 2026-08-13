/**
 * Shared harness for integration tests (§10): `:memory:` SQLite through the
 * real migration runner, the real app via `app.request()` — no network, no
 * mocks of our own layers.
 */
import type { Hono } from "hono";
import type { AppEnv } from "./api/index";
import { createApp } from "./app";
import { openDb, runMigrations } from "./db";
import { buildEnv, envVarsSchema, type Env } from "./env";
import { initLogger } from "./logger";

export const TEST_ADMIN_NAME = "test";
export const TEST_ADMIN_SECRET = "testsecrettestsecrettestsecret12";

export interface TestRequestInit {
  method?: string;
  body?: unknown;
  /** Defaults to the admin secret; `null` sends no Authorization header. */
  token?: string | null;
}

export interface TestApp {
  env: Env;
  app: Hono<AppEnv>;
  request: (path: string, init?: TestRequestInit) => Promise<Response>;
}

/** `dbPath` other than `:memory:` lets a test open a second handle on the same file. */
export function createTestApp(dbPath = ":memory:"): TestApp {
  initLogger("error");
  const vars = envVarsSchema.parse({
    LEVER_ADMIN_TOKENS: `${TEST_ADMIN_NAME}:${TEST_ADMIN_SECRET}`,
  });
  const db = openDb(dbPath);
  runMigrations(db);
  const env = buildEnv(vars, db);
  const app = createApp(env);

  const request = async (path: string, init: TestRequestInit = {}) => {
    const headers: Record<string, string> = {};
    if (init.token !== null) headers.Authorization = `Bearer ${init.token ?? TEST_ADMIN_SECRET}`;
    const hasBody = init.body !== undefined;
    if (hasBody) headers["Content-Type"] = "application/json";
    return app.request(path, {
      method: init.method ?? "GET",
      headers,
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
    });
  };

  return { env, app, request };
}
