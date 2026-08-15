import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openDb, runMigrations, type Migration } from "./index";

function tables(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name)
    .sort();
}

describe("runMigrations", () => {
  test("applies the schema and records each migration", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    expect(tables(db)).toEqual([
      "admin_accounts",
      "admin_audit",
      "admin_credentials",
      "admin_enrollments",
      "admin_grants",
      "admin_sessions",
      "conditions",
      "environments",
      "migrations",
      "parameter_conditional_values",
      "parameters",
      "projects",
      "versions",
    ]);
    const recorded = db
      .query<{ name: string }, []>("SELECT name FROM migrations ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(recorded).toEqual(["0001-init", "0002-admin-identity"]);
  });

  test("is idempotent — a second run applies nothing", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const applied = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM migrations").get()?.c;
    runMigrations(db);
    expect(db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM migrations").get()?.c).toBe(
      applied ?? 0,
    );
  });

  test("applies pending migrations in name order regardless of list order", () => {
    const db = openDb(":memory:");
    const applied: string[] = [];
    const record = (name: string): Migration => ({
      name,
      up: () => applied.push(name),
    });
    runMigrations(db, [record("0002-later"), record("0001-first")]);
    expect(applied).toEqual(["0001-first", "0002-later"]);
  });

  test("a failing migration rolls back atomically and stays unapplied", () => {
    const db = openDb(":memory:");
    const bad: Migration = {
      name: "0001-bad",
      up: (handle) => {
        handle.exec("CREATE TABLE half_done (id TEXT)");
        throw new Error("boom");
      },
    };
    expect(() => runMigrations(db, [bad])).toThrow("boom");
    expect(tables(db)).toEqual(["migrations"]);
    expect(db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM migrations").get()?.c).toBe(0);
  });

  test("foreign key enforcement is on", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    expect(() =>
      db
        .query(
          "INSERT INTO environments (id, project_id, key, client_key, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("e1", "missing-project", "prod", "pk_x", 0),
    ).toThrow();
  });
});
