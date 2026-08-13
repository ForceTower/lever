import type { Database } from "bun:sqlite";
import { z } from "zod";
import { openDb } from "./db";
import { createConditionRepo, type ConditionRepo } from "./db/condition-repo";
import { createEnvironmentRepo, type EnvironmentRepo } from "./db/environment-repo";
import { createParameterRepo, type ParameterRepo } from "./db/parameter-repo";
import { createProjectRepo, type ProjectRepo } from "./db/project-repo";
import { createVersionRepo, type VersionRepo } from "./db/version-repo";
import { initLogger } from "./logger";

export interface AdminToken {
  name: string;
  secret: string;
}

const TOKEN_NAME_RE = /^[a-z0-9-]{1,32}$/;
const TOKEN_SECRET_RE = /^[A-Za-z0-9]{32,}$/;

/**
 * "name:secret,name:secret" (spec 0001 §8.1). The charsets make the delimiters
 * unambiguous without escaping; a malformed or duplicate entry refuses to
 * parse rather than leaving a token silently unreachable.
 */
export function parseAdminTokens(raw: string): AdminToken[] {
  const tokens = raw.split(",").map((entry) => {
    const [name, secret, ...rest] = entry.split(":");
    if (name === undefined || secret === undefined || rest.length > 0) {
      throw new Error(`malformed admin token entry: expected "name:secret"`);
    }
    if (!TOKEN_NAME_RE.test(name)) {
      throw new Error(`invalid admin token name: must match [a-z0-9-]{1,32}`);
    }
    if (!TOKEN_SECRET_RE.test(secret)) {
      throw new Error(`invalid admin token secret for "${name}": must match [A-Za-z0-9]{32,}`);
    }
    return { name, secret };
  });
  const names = new Set(tokens.map((token) => token.name));
  if (names.size !== tokens.length) throw new Error("duplicate admin token name");
  return tokens;
}

export const envVarsSchema = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_PATH: z.string().default("./data/lever.db"),
  LEVER_ADMIN_TOKENS: z.string().transform((raw, ctx) => {
    try {
      return parseAdminTokens(raw);
    } catch (error) {
      ctx.addIssue(error instanceof Error ? error.message : String(error));
      return z.NEVER;
    }
  }),
  LEVER_ALLOWED_ORIGINS: z.string().default("*"),
  SSE_HEARTBEAT_MS: z.coerce.number().default(25_000),
  SSE_MAX_SUBSCRIBERS: z.coerce.number().default(2_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type EnvVars = z.infer<typeof envVarsSchema>;

export interface Env {
  vars: EnvVars;
  db: Database;
  repos: {
    projects: ProjectRepo;
    environments: EnvironmentRepo;
    conditions: ConditionRepo;
    parameters: ParameterRepo;
    versions: VersionRepo;
  };
}

export function buildEnv(vars: EnvVars, db: Database): Env {
  return {
    vars,
    db,
    repos: {
      projects: createProjectRepo(db),
      environments: createEnvironmentRepo(db),
      conditions: createConditionRepo(db),
      parameters: createParameterRepo(db),
      versions: createVersionRepo(db),
    },
  };
}

let cached: Env | undefined;

/**
 * The composition root: parsed env vars, the opened database, and constructed
 * repositories, built lazily and cached. Invalid config logs the treeified
 * issues and exits (spec 0001 §9.1). Services join the registry in later
 * phases. Tests bypass this via `buildEnv` over a `:memory:` database.
 */
export function getEnv(): Env {
  if (cached === undefined) {
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
