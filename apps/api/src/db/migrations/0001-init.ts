import type { Database } from "bun:sqlite";

// The spec 0001 §3.2 schema, verbatim.
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE projects (
      id         TEXT PRIMARY KEY,
      key        TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE environments (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      key        TEXT NOT NULL,
      client_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      UNIQUE (project_id, key)
    );

    CREATE TABLE conditions (
      id             TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      clauses        TEXT NOT NULL,
      updated_at     INTEGER NOT NULL,
      UNIQUE (environment_id, name)
    );

    CREATE TABLE parameters (
      id             TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
      key            TEXT NOT NULL,
      type           TEXT NOT NULL CHECK (type IN ('boolean','string','number','json')),
      default_value  TEXT NOT NULL,
      description    TEXT,
      updated_at     INTEGER NOT NULL,
      UNIQUE (environment_id, key)
    );

    CREATE TABLE parameter_conditional_values (
      id           TEXT PRIMARY KEY,
      parameter_id TEXT NOT NULL REFERENCES parameters(id) ON DELETE CASCADE,
      condition_id TEXT NOT NULL REFERENCES conditions(id) ON DELETE RESTRICT,
      value        TEXT NOT NULL,
      position     INTEGER NOT NULL,
      UNIQUE (parameter_id, condition_id),
      UNIQUE (parameter_id, position)
    );

    CREATE TABLE versions (
      environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
      version        INTEGER NOT NULL,
      snapshot       TEXT NOT NULL,
      author         TEXT NOT NULL,
      published_at   INTEGER NOT NULL,
      rollback_of    INTEGER,
      PRIMARY KEY (environment_id, version),
      FOREIGN KEY (environment_id, rollback_of)
        REFERENCES versions(environment_id, version)
    );

    CREATE INDEX idx_conditions_env ON conditions(environment_id);
    CREATE INDEX idx_parameters_env ON parameters(environment_id);
  `);
}
