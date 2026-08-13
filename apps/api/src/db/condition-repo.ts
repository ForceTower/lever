import type { Database } from "bun:sqlite";
import { clausesSchema, type Clause } from "../service/snapshot";

export interface Condition {
  id: string;
  environmentId: string;
  name: string;
  clauses: Clause[];
  updatedAt: number;
}

export interface ConditionRepo {
  create(input: { environmentId: string; name: string; clauses: Clause[] }): Condition;
  getById(id: string): Condition | undefined;
  listByEnvironment(environmentId: string): Condition[];
  update(id: string, patch: { name?: string; clauses?: Clause[] }): Condition | undefined;
  /**
   * Throws SQLITE_CONSTRAINT while any conditional value references the
   * condition (§3.2 RESTRICT) — deletion order is explicit, never a cascade
   * that changes resolved values. The service layer maps this to a 409.
   */
  remove(id: string): boolean;
}

interface ConditionRow {
  id: string;
  environment_id: string;
  name: string;
  clauses: string;
  updated_at: number;
}

// Clauses were zod-validated on write; parsing again on read means a row that
// drifted (manual edit, future format change) fails loudly instead of reaching
// the evaluator.
function toCondition(row: ConditionRow): Condition {
  return {
    id: row.id,
    environmentId: row.environment_id,
    name: row.name,
    clauses: clausesSchema.parse(JSON.parse(row.clauses)),
    updatedAt: row.updated_at,
  };
}

export function createConditionRepo(db: Database): ConditionRepo {
  const getById = (id: string): Condition | undefined => {
    const row = db.query<ConditionRow, [string]>("SELECT * FROM conditions WHERE id = ?").get(id);
    return row === null ? undefined : toCondition(row);
  };

  return {
    create({ environmentId, name, clauses }) {
      const condition: Condition = {
        id: Bun.randomUUIDv7(),
        environmentId,
        name,
        clauses,
        updatedAt: Date.now(),
      };
      db.query<undefined, [string, string, string, string, number]>(
        "INSERT INTO conditions (id, environment_id, name, clauses, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        condition.id,
        condition.environmentId,
        condition.name,
        JSON.stringify(condition.clauses),
        condition.updatedAt,
      );
      return condition;
    },
    getById,
    listByEnvironment(environmentId) {
      return db
        .query<ConditionRow, [string]>(
          "SELECT * FROM conditions WHERE environment_id = ? ORDER BY name",
        )
        .all(environmentId)
        .map(toCondition);
    },
    update(id, patch) {
      const existing = getById(id);
      if (existing === undefined) return undefined;
      db.query<undefined, [string, string, number, string]>(
        "UPDATE conditions SET name = ?, clauses = ?, updated_at = ? WHERE id = ?",
      ).run(
        patch.name ?? existing.name,
        JSON.stringify(patch.clauses ?? existing.clauses),
        Date.now(),
        id,
      );
      return getById(id);
    },
    remove(id) {
      return (
        db.query<undefined, [string]>("DELETE FROM conditions WHERE id = ?").run(id).changes === 1
      );
    },
  };
}
