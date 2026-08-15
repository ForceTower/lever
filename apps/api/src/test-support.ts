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
import { PERMISSIONS, type Permission } from "./service/permissions";
import {
  ChallengeStore,
  type StoredCredential,
  type VerifiedCredential,
  type WebAuthnService,
} from "./service/webauthn";

export const TEST_ADMIN_USERNAME = "test";

/** Vars every test needs; the auth-shaped ones have no defaults by design (§9.1). */
const BASE_VARS = {
  LEVER_ADMIN_ORIGINS: "https://portal.lever.test",
  LEVER_WEBAUTHN_RP_ID: "lever.test",
  LEVER_WEBAUTHN_ORIGINS: "https://portal.lever.test",
  LEVER_JWT_SECRET: "test-jwt-secret-test-jwt-secret-32",
};

/**
 * Stubs the *cryptography* only: the real `ChallengeStore` still governs
 * single-use, TTL, and ceremony tagging, so replay and expiry behave exactly as
 * in production. `rejectNext` stands in for a bad assertion.
 */
export class FakeWebAuthn implements WebAuthnService {
  readonly store = new ChallengeStore();
  rejectNext = false;

  private consumeRejection(): boolean {
    if (!this.rejectNext) return false;
    this.rejectNext = false;
    return true;
  }

  async startRegistration({
    account,
    excludeCredentials,
  }: {
    account: { id: string; username: string; name: string };
    excludeCredentials: { id: string; transports: string[] }[];
  }): Promise<{ challengeId: string; options: unknown }> {
    const challenge = `register:${account.id}`;
    return {
      challengeId: this.store.put("register", challenge, account.id),
      options: { challenge, excludeCredentials },
    };
  }

  async verifyRegistration({
    challengeId,
    response,
  }: {
    challengeId: string;
    response: { id: string };
  }): Promise<{ accountId: string; credential: VerifiedCredential } | undefined> {
    const pending = this.store.take(challengeId, "register");
    if (pending?.accountId === undefined) return undefined;
    if (this.consumeRejection()) return undefined;
    return {
      accountId: pending.accountId,
      credential: {
        id: response.id,
        publicKey: new TextEncoder().encode(`public-key:${response.id}`),
        counter: 0,
        transports: ["internal"],
      },
    };
  }

  async startAuthentication({
    allowCredentials,
  }: {
    allowCredentials: { id: string; transports: string[] }[];
  }): Promise<{ challengeId: string; options: unknown }> {
    const challenge = "login";
    return {
      challengeId: this.store.put("login", challenge),
      options: { challenge, allowCredentials },
    };
  }

  async verifyAuthentication({
    challengeId,
    credential,
  }: {
    challengeId: string;
    credential: StoredCredential;
  }): Promise<{ newCounter: number } | undefined> {
    const pending = this.store.take(challengeId, "login");
    if (pending === undefined) return undefined;
    if (this.consumeRejection()) return undefined;
    return { newCounter: credential.counter + 1 };
  }
}

export interface TestRequestInit {
  method?: string;
  body?: unknown;
  /** Defaults to the lazily created full-permission session; `null` sends no header. */
  token?: string | null;
  headers?: Record<string, string>;
}

export interface TestApp {
  env: Env;
  app: Hono<AppEnv>;
  webauthn: FakeWebAuthn;
  request: (path: string, init?: TestRequestInit) => Promise<Response>;
  /** Mints an account with the given grants and returns a usable session token. */
  signIn: (options?: { username?: string; permissions?: Permission[] }) => Promise<string>;
}

/** `dbPath` other than `:memory:` lets a test open a second handle on the same file. */
export function createTestApp(
  options: { dbPath?: string; vars?: Record<string, string> } = {},
): TestApp {
  initLogger("error");
  const vars = envVarsSchema.parse({ ...BASE_VARS, ...options.vars });
  const db = openDb(options.dbPath ?? ":memory:");
  runMigrations(db);
  const webauthn = new FakeWebAuthn();
  const env = buildEnv(vars, db, { webauthn });
  const app = createApp(env);

  let counter = 0;
  const signIn = async (
    signInOptions: { username?: string; permissions?: Permission[] } = {},
  ): Promise<string> => {
    counter += 1;
    const username = signInOptions.username ?? `${TEST_ADMIN_USERNAME}-${counter}`;
    const account = await env.repos.adminAccounts.create({ username, name: username });
    await env.repos.adminAccounts.replaceGrants(
      account.id,
      signInOptions.permissions ?? [...PERMISSIONS],
    );
    const sessionId = Bun.randomUUIDv7();
    const expiresAt = Date.now() + 60 * 60 * 1000;
    await env.repos.adminSessions.create({
      id: sessionId,
      accountId: account.id,
      expiresAt,
      ip: null,
      userAgent: null,
    });
    return env.tokens.sign({ accountId: account.id, sessionId, expiresAt });
  };

  // Created on first use so tests that never touch /v1/admin pay nothing, and
  // so the existing suites keep their synchronous `createTestApp()` call.
  let defaultToken: Promise<string> | undefined;

  const request = async (path: string, init: TestRequestInit = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.token !== null) {
      // Only mint the shared session when the caller did not bring its own:
      // creating it regardless would add a second all-permission account to
      // every test, silently masking permission and last-holder behaviour.
      if (init.token === undefined) defaultToken ??= signIn({ username: TEST_ADMIN_USERNAME });
      headers.Authorization = `Bearer ${init.token ?? (await defaultToken)}`;
    }
    const hasBody = init.body !== undefined;
    if (hasBody) headers["Content-Type"] = "application/json";
    return app.request(path, {
      method: init.method ?? "GET",
      headers,
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
    });
  };

  return { env, app, webauthn, request, signIn };
}

/*
 * Test assertions reach into response shapes the routes already own, and
 * restating each of them here would duplicate the contract without checking it.
 * One deliberately permissive alias, declared once, keeps that looseness
 * confined to the harness instead of spreading `any` across every suite.
 */
// oxlint-disable-next-line typescript/no-explicit-any
type TestPayload = any;

/** Unwraps the §5.1 envelope for assertions; throws if the response is a failure. */
export async function dataOf(response: Response): Promise<TestPayload> {
  const body: TestPayload = await response.json();
  if (body.ok !== true) throw new Error(`expected success, got ${JSON.stringify(body.error)}`);
  return body.data;
}

/** The `error.code` of a failure envelope. */
export async function errorCodeOf(response: Response): Promise<string | undefined> {
  const body: TestPayload = await response.json();
  return body.error?.code;
}
