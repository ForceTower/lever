import type { Database } from "bun:sqlite";
import { type JsonValue } from "../service/canonicalize";
import { jsonValueSchema, type ParameterType, parameterTypeSchema } from "../service/snapshot";

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
  }): Parameter;
  getById(id: string): Parameter | undefined;
  listByEnvironment(environmentId: string): Parameter[];
  update(
    id: string,
    patch: {
      key?: string;
      type?: ParameterType;
      defaultValue?: JsonValue;
      description?: string | null;
    },
  ): Parameter | undefined;
  remove(id: string): boolean;
  /**
   * Replaces the full ordered list — ordering is first-match-wins semantics
   * (§4), so partial reorders are not offered. Positions are assigned 0…n−1
   * from list order. Same-environment validation of every conditionId is the
   * caller's job (§3.2 — service-layer invariant).
   */
  replaceConditionalValues(
    parameterId: string,
    values: { conditionId: string; value: JsonValue }[],
  ): ConditionalValue[];
  listConditionalValues(parameterId: string): ConditionalValue[];
}

interface ParameterRow {
  id: string;
  environment_id: string;
  key: string;
  type: string;
  default_value: string;
  description: string | null;
  updated_at: number;
}

interface ConditionalValueRow {
  id: string;
  parameter_id: string;
  condition_id: string;
  value: string;
  position: number;
}

function parseJson(encoded: string): JsonValue {
  return jsonValueSchema.parse(JSON.parse(encoded));
}

function toParameter(row: ParameterRow): Parameter {
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

function toConditionalValue(row: ConditionalValueRow): ConditionalValue {
  return {
    id: row.id,
    parameterId: row.parameter_id,
    conditionId: row.condition_id,
    value: parseJson(row.value),
    position: row.position,
  };
}

export function createParameterRepo(db: Database): ParameterRepo {
  const getById = (id: string): Parameter | undefined => {
    const row = db.query<ParameterRow, [string]>("SELECT * FROM parameters WHERE id = ?").get(id);
    return row === null ? undefined : toParameter(row);
  };

  const listConditionalValues = (parameterId: string): ConditionalValue[] =>
    db
      .query<ConditionalValueRow, [string]>(
        "SELECT * FROM parameter_conditional_values WHERE parameter_id = ? ORDER BY position",
      )
      .all(parameterId)
      .map(toConditionalValue);

  return {
    create({ environmentId, key, type, defaultValue, description }) {
      const parameter: Parameter = {
        id: Bun.randomUUIDv7(),
        environmentId,
        key,
        type,
        defaultValue,
        description: description ?? null,
        updatedAt: Date.now(),
      };
      db.query<undefined, [string, string, string, string, string, string | null, number]>(
        `INSERT INTO parameters (id, environment_id, key, type, default_value, description, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        parameter.id,
        parameter.environmentId,
        parameter.key,
        parameter.type,
        JSON.stringify(parameter.defaultValue),
        parameter.description,
        parameter.updatedAt,
      );
      return parameter;
    },
    getById,
    listByEnvironment(environmentId) {
      return db
        .query<ParameterRow, [string]>(
          "SELECT * FROM parameters WHERE environment_id = ? ORDER BY key",
        )
        .all(environmentId)
        .map(toParameter);
    },
    update(id, patch) {
      const existing = getById(id);
      if (existing === undefined) return undefined;
      db.query<undefined, [string, string, string, string | null, number, string]>(
        "UPDATE parameters SET key = ?, type = ?, default_value = ?, description = ?, updated_at = ? WHERE id = ?",
      ).run(
        patch.key ?? existing.key,
        patch.type ?? existing.type,
        // Explicit undefined check: null is a legitimate defaultValue for json
        // parameters, so ?? would silently drop it.
        JSON.stringify(
          patch.defaultValue === undefined ? existing.defaultValue : patch.defaultValue,
        ),
        patch.description === undefined ? existing.description : patch.description,
        Date.now(),
        id,
      );
      return getById(id);
    },
    remove(id) {
      return (
        db.query<undefined, [string]>("DELETE FROM parameters WHERE id = ?").run(id).changes === 1
      );
    },
    replaceConditionalValues(parameterId, values) {
      const insert = db.query<undefined, [string, string, string, string, number]>(
        `INSERT INTO parameter_conditional_values (id, parameter_id, condition_id, value, position)
         VALUES (?, ?, ?, ?, ?)`,
      );
      db.transaction(() => {
        db.query<undefined, [string]>(
          "DELETE FROM parameter_conditional_values WHERE parameter_id = ?",
        ).run(parameterId);
        values.forEach(({ conditionId, value }, position) => {
          insert.run(Bun.randomUUIDv7(), parameterId, conditionId, JSON.stringify(value), position);
        });
      })();
      return listConditionalValues(parameterId);
    },
    listConditionalValues,
  };
}
