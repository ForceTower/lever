import type { Database } from "bun:sqlite";
import { z } from "zod";
import { createDb, createRepos, openDb, type Db, type Repos } from "./db";
import { initLogger } from "./logger";
import { createAdminAuthService, type AdminAuthService } from "./service/admin-auth";
import { createConditionsService, type ConditionsService } from "./service/admin/conditions";
import { createEnvironmentsService, type EnvironmentsService } from "./service/admin/environments";
import { createParametersService, type ParametersService } from "./service/admin/parameters";
import { createProjectsService, type ProjectsService } from "./service/admin/projects";
import { createPublishService, type PublishService } from "./service/publish";
import { createResolveCache, type ResolveCache } from "./service/resolve-cache";
import { createStreamRegistry, type StreamRegistry } from "./service/stream";
import { createTokenService, type TokenService } from "./service/tokens";
import { createWebAuthnService, type WebAuthnService } from "./service/webauthn";

/** Comma-separated origin list; every entry must be a bare scheme://host[:port]. */
function parseOrigins(raw: string, ctx: z.RefinementCtx): string[] {
  const origins = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (origins.length === 0) {
    ctx.addIssue("must list at least one origin");
    return z.NEVER;
  }
  for (const origin of origins) {
    if (origin === "*") {
      // §5.3: an authenticated surface that echoes any origin is how a hostile
      // page reaches an operator's session.
      ctx.addIssue(`"*" is not allowed here — name the portal's origin explicitly`);
      return z.NEVER;
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      ctx.addIssue(`"${origin}" is not a valid origin (expected scheme://host[:port])`);
      return z.NEVER;
    }
    if (parsed.origin !== origin) {
      ctx.addIssue(`"${origin}" must be a bare origin, i.e. "${parsed.origin}"`);
      return z.NEVER;
    }
  }
  return origins;
}

const originListSchema = z.string().transform(parseOrigins);

export const envVarsSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production"]).default("development"),
    PORT: z.coerce.number().default(3000),
    DATABASE_PATH: z.string().default("./data/lever.db"),
    LEVER_ALLOWED_ORIGINS: z.string().default("*"),
    LEVER_ADMIN_ORIGINS: originListSchema,
    LEVER_WEBAUTHN_RP_ID: z.string().min(1),
    LEVER_WEBAUTHN_ORIGINS: originListSchema,
    LEVER_WEBAUTHN_RP_NAME: z.string().min(1).default("Lever"),
    LEVER_ADMIN_SESSION_HOURS: z.coerce.number().positive().default(8),
    // Signs admin session JWTs (§8.1.4). 32 chars is the HS256 floor worth
    // enforcing; rotating it invalidates every live session, which is the
    // intended break-glass behaviour.
    LEVER_JWT_SECRET: z.string().min(32),
    SSE_HEARTBEAT_MS: z.coerce.number().default(25_000),
    SSE_MAX_SUBSCRIBERS: z.coerce.number().default(2_000),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .superRefine((vars, ctx) => {
    // §8.1.1: credentials are bound to the *portal's* domain, so the RP id must
    // cover every origin an assertion may arrive from. Pointing it at the API's
    // domain is the common misconfiguration, and it fails at the first login
    // rather than at boot unless it is caught here.
    for (const origin of vars.LEVER_WEBAUTHN_ORIGINS) {
      const { hostname } = new URL(origin);
      const rpId = vars.LEVER_WEBAUTHN_RP_ID;
      if (hostname !== rpId && !hostname.endsWith(`.${rpId}`)) {
        ctx.addIssue({
          code: "custom",
          path: ["LEVER_WEBAUTHN_RP_ID"],
          message: `"${rpId}" is not a suffix of the origin "${origin}" — WebAuthn would reject every assertion`,
        });
      }
    }
  });

export type EnvVars = z.infer<typeof envVarsSchema>;

export interface Env {
  vars: EnvVars;
  /** The raw bun:sqlite handle — pragmas, migrations, backups. */
  sqlite: Database;
  /** The Kysely instance every query goes through. */
  db: Db;
  repos: Repos;
  streams: StreamRegistry;
  resolveCache: ResolveCache;
  webauthn: WebAuthnService;
  tokens: TokenService;
  services: {
    projects: ProjectsService;
    environments: EnvironmentsService;
    conditions: ConditionsService;
    parameters: ParametersService;
    publish: PublishService;
    adminAuth: AdminAuthService;
  };
}

// Callers warm the cache after construction (`env.resolveCache.warmUp`) — boot
// does it before listening; tests build over an empty database, where the
// mutation hooks keep the cache current from the first write.
export function buildEnv(
  vars: EnvVars,
  sqlite: Database,
  overrides: { webauthn?: WebAuthnService } = {},
): Env {
  const db = createDb(sqlite);
  const repos = createRepos(db);
  const streams = createStreamRegistry({
    heartbeatMs: vars.SSE_HEARTBEAT_MS,
    maxSubscribers: vars.SSE_MAX_SUBSCRIBERS,
  });
  const resolveCache = createResolveCache(streams);
  const tokens = createTokenService(vars.LEVER_JWT_SECRET);
  // Injectable so the §10.3 ceremony tests can drive enrollment and login
  // without real authenticator cryptography.
  const webauthn =
    overrides.webauthn ??
    createWebAuthnService({
      rpId: vars.LEVER_WEBAUTHN_RP_ID,
      rpName: vars.LEVER_WEBAUTHN_RP_NAME,
      origins: vars.LEVER_WEBAUTHN_ORIGINS,
    });
  return {
    vars,
    sqlite,
    db,
    repos,
    streams,
    resolveCache,
    webauthn,
    tokens,
    services: {
      projects: createProjectsService(repos, resolveCache),
      environments: createEnvironmentsService(repos, resolveCache),
      conditions: createConditionsService(repos),
      parameters: createParametersService(db, repos),
      publish: createPublishService(db, repos, resolveCache),
      adminAuth: createAdminAuthService(db, repos, webauthn, tokens, {
        sessionHours: vars.LEVER_ADMIN_SESSION_HOURS,
      }),
    },
  };
}

let cached: Env | undefined;

/**
 * The composition root: parsed env vars, the opened database, and constructed
 * repositories and services, built lazily and cached. Invalid config logs the
 * treeified issues and exits (spec 0001 §9.1). Tests bypass this via `buildEnv`
 * over a `:memory:` database.
 */
export function getEnv(): Env {
  if (cached === undefined) {
    if (process.env.LEVER_ADMIN_TOKENS !== undefined) {
      // Removed with the passkey model (§9.1). Refusing to boot beats ignoring
      // it and leaving the operator with no way in.
      console.error(
        "LEVER_ADMIN_TOKENS is no longer supported: admin auth is passkey-based (spec 0001 §8.1).",
        "\nEnrol an account with: bun run --cwd apps/api admin:enroll <username>",
      );
      process.exit(1);
    }
    const parsed = envVarsSchema.safeParse(process.env);
    if (!parsed.success) {
      console.error("invalid environment configuration", z.treeifyError(parsed.error));
      process.exit(1);
    }
    initLogger(parsed.data.LOG_LEVEL);
    cached = buildEnv(parsed.data, openDb(parsed.data.DATABASE_PATH));
  }
  return cached;
}
