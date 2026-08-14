import { type JsonValue } from "../service/canonicalize";
import { jsonValueSchema, type ParameterType, parameterTypeSchema } from "../service/snapshot";
import type { Db } from "./kysely";
import type { ParameterConditionalValuesTable, ParametersTable } from "./schema";

export interface Parameter {
  id: string;
  environmentId: string;
  key: string;
  type: ParameterType;
  defaultValue: JsonValue;
  description: string | null;
  updatedAt: number;
}

export interface ConditionalValue {
  id: string;
  parameterId: string;
  conditionId: string;
  value: JsonValue;
  position: number;
}

export interface ParameterRepo {
  create(input: {
    environmentId: string;
    key: string;
    type: ParameterType;
    defaultValue: JsonValue;
    description?: string | undefined;
  }): Promise<Parameter>;
  getById(id: string): Promise<Parameter | undefined>;
  listByEnvironment(environmentId: string): Promise<Parameter[]>;
  update(
    id: string,
    patch: {
      key?: string;
      type?: ParameterType;
      defaultValue?: JsonValue;
      description?: string | null;
    },
  ): Promise<Parameter | undefined>;
  remove(id: string): Promise<boolean>;
  /**
   * Replaces the full ordered list — ordering is first-match-wins semantics
   * (§4), so partial reorders are not offered. Positions are assigned 0…n−1
   * from list order. Not atomic on its own: the caller wraps it in a
   * transaction, and also owns same-environment validation of every
   * conditionId (§3.2 — service-layer invariant).
   */
  replaceConditionalValues(
    parameterId: string,
    values: { conditionId: string; value: JsonValue }[],
  ): Promise<ConditionalValue[]>;
  listConditionalValues(parameterId: string): Promise<ConditionalValue[]>;
}

function parseJson(encoded: string): JsonValue {
  return jsonValueSchema.parse(JSON.parse(encoded));
}

function toParameter(row: ParametersTable): Parameter {
  return {
    id: row.id,
    environmentId: row.environment_id,
    key: row.key,
    type: parameterTypeSchema.parse(row.type),
    defaultValue: parseJson(row.default_value),
    description: row.description,
    updatedAt: row.updated_at,
  };
}

function toConditionalValue(row: ParameterConditionalValuesTable): ConditionalValue {
  return {
    id: row.id,
    parameterId: row.parameter_id,
    conditionId: row.condition_id,
    value: parseJson(row.value),
    position: row.position,
  };
}

export function createParameterRepo(db: Db): ParameterRepo {
  const getById = async (id: string): Promise<Parameter | undefined> => {
    const row = await db
      .selectFrom("parameters")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined ? undefined : toParameter(row);
  };

  const listConditionalValues = async (parameterId: string): Promise<ConditionalValue[]> => {
    const rows = await db
      .selectFrom("parameter_conditional_values")
      .selectAll()
      .where("parameter_id", "=", parameterId)
      .orderBy("position")
      .execute();
    return rows.map(toConditionalValue);
  };

  return {
    async create({ environmentId, key, type, defaultValue, description }) {
      const parameter: Parameter = {
        id: Bun.randomUUIDv7(),
        environmentId,
        key,
        type,
        defaultValue,
        description: description ?? null,
        updatedAt: Date.now(),
      };
      await db
        .insertInto("parameters")
        .values({
          id: parameter.id,
          environment_id: parameter.environmentId,
          key: parameter.key,
          type: parameter.type,
          default_value: JSON.stringify(parameter.defaultValue),
          description: parameter.description,
          updated_at: parameter.updatedAt,
        })
        .execute();
      return parameter;
    },
    getById,
    async listByEnvironment(environmentId) {
      const rows = await db
        .selectFrom("parameters")
        .selectAll()
        .where("environment_id", "=", environmentId)
        .orderBy("key")
        .execute();
      return rows.map(toParameter);
    },
    async update(id, patch) {
      const existing = await getById(id);
      if (existing === undefined) return undefined;
      await db
        .updateTable("parameters")
        .set({
          key: patch.key ?? existing.key,
          type: patch.type ?? existing.type,
          // Explicit undefined check: null is a legitimate defaultValue for
          // json parameters, so ?? would silently drop it.
          default_value: JSON.stringify(
            patch.defaultValue === undefined ? existing.defaultValue : patch.defaultValue,
          ),
          description: patch.description === undefined ? existing.description : patch.description,
          updated_at: Date.now(),
        })
        .where("id", "=", id)
        .execute();
      return getById(id);
    },
    async remove(id) {
      const result = await db.deleteFrom("parameters").where("id", "=", id).executeTakeFirst();
      return result.numDeletedRows === 1n;
    },
    async replaceConditionalValues(parameterId, values) {
      await db
        .deleteFrom("parameter_conditional_values")
        .where("parameter_id", "=", parameterId)
        .execute();
      if (values.length > 0) {
        await db
          .insertInto("parameter_conditional_values")
          .values(
            values.map(({ conditionId, value }, position) => ({
              id: Bun.randomUUIDv7(),
              parameter_id: parameterId,
              condition_id: conditionId,
              value: JSON.stringify(value),
              position,
            })),
          )
          .execute();
      }
      return listConditionalValues(parameterId);
    },
    listConditionalValues,
  };
}
