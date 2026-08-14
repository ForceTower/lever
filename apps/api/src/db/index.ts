import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createConditionRepo, type ConditionRepo } from "./condition-repo";
import { createEnvironmentRepo, type EnvironmentRepo } from "./environment-repo";
import type { Db } from "./kysely";
import { migrations as allMigrations } from "./migrations";
import { createParameterRepo, type ParameterRepo } from "./parameter-repo";
import { createProjectRepo, type ProjectRepo } from "./project-repo";
import { createVersionRepo, type VersionRepo } from "./version-repo";

export { createDb, type Db } from "./kysely";

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

export interface Migration {
  name: string;
  up: (db: Database) => void;
}

/**
 * Applies pending migrations in name order, each inside its own transaction,
 * recording them in `migrations`. Runs automatically at boot before the server
 * listens (spec 0001 §9.3) — single-node SQLite has no coordination problem.
 * Migrations stay on the raw handle: they run before the query layer exists
 * and their DDL is the spec's SQL verbatim.
 */
export function runMigrations(db: Database, migrations: Migration[] = allMigrations): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM migrations")
      .all()
      .map((row) => row.name),
  );
  const insert = db.query<undefined, { name: string; appliedAt: number }>(
    "INSERT INTO migrations (name, applied_at) VALUES ($name, $appliedAt)",
  );
  for (const migration of [...migrations].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (applied.has(migration.name)) continue;
    db.transaction(() => {
      migration.up(db);
      insert.run({ name: migration.name, appliedAt: Date.now() });
    })();
  }
}

export interface Repos {
  projects: ProjectRepo;
  environments: EnvironmentRepo;
  conditions: ConditionRepo;
  parameters: ParameterRepo;
  versions: VersionRepo;
}

/**
 * Cheap closures over a Kysely executor — built once over the root handle for
 * the registry, and rebuilt over `trx` inside `withTransaction` so every query
 * in a transaction goes through it.
 */
export function createRepos(db: Db): Repos {
  return {
    projects: createProjectRepo(db),
    environments: createEnvironmentRepo(db),
    conditions: createConditionRepo(db),
    parameters: createParameterRepo(db),
    versions: createVersionRepo(db),
  };
}

/**
 * Every transaction opens with BEGIN IMMEDIATE (see the dialect) — publish
 * and rollback require it (§8.3) and every transaction we run is a write.
 * Query only through the repos handed to the callback: the root instance
 * would wait on the connection mutex and deadlock.
 */
export function withTransaction<T>(db: Db, fn: (repos: Repos, trx: Db) => Promise<T>): Promise<T> {
  return db.transaction().execute((trx) => fn(createRepos(trx), trx));
}
