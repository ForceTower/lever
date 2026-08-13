import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrations as allMigrations } from "./migrations";

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

export function withTransaction<T>(db: Database, fn: () => T): T {
  return db.transaction(fn)();
}

/**
 * BEGIN IMMEDIATE — takes the write lock up front, avoiding the DEFERRED
 * read→write upgrade that fails mid-transaction under WAL (spec 0001 §8.3).
 * Publish and rollback run through this.
 */
export function withImmediateTransaction<T>(db: Database, fn: () => T): T {
  return db.transaction(fn).immediate();
}
