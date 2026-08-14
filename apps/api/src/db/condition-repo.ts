import { clausesSchema, type Clause } from "../service/snapshot";
import type { Db } from "./kysely";
import type { ConditionsTable } from "./schema";

export interface Condition {
  id: string;
  environmentId: string;
  name: string;
  clauses: Clause[];
  updatedAt: number;
}

export interface ConditionRepo {
  create(input: { environmentId: string; name: string; clauses: Clause[] }): Promise<Condition>;
  getById(id: string): Promise<Condition | undefined>;
  listByEnvironment(environmentId: string): Promise<Condition[]>;
  update(id: string, patch: { name?: string; clauses?: Clause[] }): Promise<Condition | undefined>;
  /**
   * Throws SQLITE_CONSTRAINT while any conditional value references the
   * condition (§3.2 RESTRICT) — deletion order is explicit, never a cascade
   * that changes resolved values. The service layer maps this to a 409.
   */
  remove(id: string): Promise<boolean>;
}

// Clauses were zod-validated on write; parsing again on read means a row that
// drifted (manual edit, future format change) fails loudly instead of reaching
// the evaluator.
function toCondition(row: ConditionsTable): Condition {
  return {
    id: row.id,
    environmentId: row.environment_id,
    name: row.name,
    clauses: clausesSchema.parse(JSON.parse(row.clauses)),
    updatedAt: row.updated_at,
  };
}

export function createConditionRepo(db: Db): ConditionRepo {
  const getById = async (id: string): Promise<Condition | undefined> => {
    const row = await db
      .selectFrom("conditions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined ? undefined : toCondition(row);
  };

  return {
    async create({ environmentId, name, clauses }) {
      const condition: Condition = {
        id: Bun.randomUUIDv7(),
        environmentId,
        name,
        clauses,
        updatedAt: Date.now(),
      };
      await db
        .insertInto("conditions")
        .values({
          id: condition.id,
          environment_id: condition.environmentId,
          name: condition.name,
          clauses: JSON.stringify(condition.clauses),
          updated_at: condition.updatedAt,
        })
        .execute();
      return condition;
    },
    getById,
    async listByEnvironment(environmentId) {
      const rows = await db
        .selectFrom("conditions")
        .selectAll()
        .where("environment_id", "=", environmentId)
        .orderBy("name")
        .execute();
      return rows.map(toCondition);
    },
    async update(id, patch) {
      const existing = await getById(id);
      if (existing === undefined) return undefined;
      await db
        .updateTable("conditions")
        .set({
          name: patch.name ?? existing.name,
          clauses: JSON.stringify(patch.clauses ?? existing.clauses),
          updated_at: Date.now(),
        })
        .where("id", "=", id)
        .execute();
      return getById(id);
    },
    async remove(id) {
      const result = await db.deleteFrom("conditions").where("id", "=", id).executeTakeFirst();
      return result.numDeletedRows === 1n;
    },
  };
}
