import type { Database } from "bun:sqlite";
import type { ConditionRepo } from "../../db/condition-repo";
import type { EnvironmentRepo } from "../../db/environment-repo";
import type { ConditionalValue, Parameter, ParameterRepo } from "../../db/parameter-repo";
import { withTransaction } from "../../db";
import { isConstraintError, LeverError, notFound } from "../../error";
import type { JsonValue } from "../canonicalize";
import { type ParameterType, valueMatchesType } from "../snapshot";

export interface ParameterDetail extends Parameter {
  conditionalValues: ConditionalValue[];
}

export interface ParametersService {
  listByEnvironment(environmentId: string): ParameterDetail[];
  create(
    environmentId: string,
    input: {
      key: string;
      type: ParameterType;
      defaultValue: JsonValue;
      description?: string | undefined;
    },
  ): ParameterDetail;
  get(id: string): ParameterDetail;
  /**
   * A type change revalidates the default and every conditional value against
   * the new type in one transaction, or rejects (§8.2).
   */
  update(
    id: string,
    patch: {
      key?: string | undefined;
      type?: ParameterType | undefined;
      defaultValue?: JsonValue | undefined;
      description?: string | null | undefined;
    },
  ): ParameterDetail;
  remove(id: string): void;
  /**
   * Replaces the full ordered list (§8.2): positions are assigned from list
   * order, every condition must belong to the parameter's environment — the
   * §3.2 invariant SQLite cannot express — and every value must match the
   * parameter's type.
   */
  replaceConditionalValues(
    parameterId: string,
    values: { conditionId: string; value: JsonValue }[],
  ): ConditionalValue[];
}

function typeMismatch(where: string, type: ParameterType): LeverError {
  return new LeverError(400, "type_mismatch", `${where} must be a ${type}`);
}

export function createParametersService(
  db: Database,
  repos: {
    parameters: ParameterRepo;
    conditions: ConditionRepo;
    environments: EnvironmentRepo;
  },
): ParametersService {
  const getOrThrow = (id: string): Parameter => {
    const parameter = repos.parameters.getById(id);
    if (parameter === undefined) throw notFound("parameter");
    return parameter;
  };

  const withValues = (parameter: Parameter): ParameterDetail => ({
    ...parameter,
    conditionalValues: repos.parameters.listConditionalValues(parameter.id),
  });

  return {
    listByEnvironment(environmentId) {
      if (repos.environments.getById(environmentId) === undefined) throw notFound("environment");
      return repos.parameters.listByEnvironment(environmentId).map(withValues);
    },
    create(environmentId, input) {
      if (repos.environments.getById(environmentId) === undefined) throw notFound("environment");
      if (!valueMatchesType(input.type, input.defaultValue)) {
        throw typeMismatch("defaultValue", input.type);
      }
      try {
        return withValues(repos.parameters.create({ environmentId, ...input }));
      } catch (error) {
        if (isConstraintError(error)) {
          throw new LeverError(
            409,
            "already_exists",
            `parameter key "${input.key}" already exists in this environment`,
          );
        }
        throw error;
      }
    },
    get: (id) => withValues(getOrThrow(id)),
    update(id, patch) {
      getOrThrow(id);
      const cleaned: {
        key?: string;
        type?: ParameterType;
        defaultValue?: JsonValue;
        description?: string | null;
      } = {};
      if (patch.key !== undefined) cleaned.key = patch.key;
      if (patch.type !== undefined) cleaned.type = patch.type;
      if (patch.defaultValue !== undefined) cleaned.defaultValue = patch.defaultValue;
      if (patch.description !== undefined) cleaned.description = patch.description;
      try {
        // The throw on a type mismatch rolls the whole update back.
        return withTransaction(db, () => {
          const updated = repos.parameters.update(id, cleaned);
          if (updated === undefined) throw notFound("parameter");
          const detail = withValues(updated);
          if (!valueMatchesType(detail.type, detail.defaultValue)) {
            throw typeMismatch("defaultValue", detail.type);
          }
          for (const cv of detail.conditionalValues) {
            if (!valueMatchesType(detail.type, cv.value)) {
              throw typeMismatch(`conditional value for condition ${cv.conditionId}`, detail.type);
            }
          }
          return detail;
        });
      } catch (error) {
        if (isConstraintError(error)) {
          throw new LeverError(409, "already_exists", "parameter key is already taken");
        }
        throw error;
      }
    },
    remove(id) {
      getOrThrow(id);
      repos.parameters.remove(id);
    },
    replaceConditionalValues(parameterId, values) {
      const parameter = getOrThrow(parameterId);
      const seen = new Set<string>();
      for (const { conditionId, value } of values) {
        if (seen.has(conditionId)) {
          throw new LeverError(
            400,
            "invalid_condition",
            `condition ${conditionId} appears more than once`,
          );
        }
        seen.add(conditionId);
        const condition = repos.conditions.getById(conditionId);
        if (condition === undefined || condition.environmentId !== parameter.environmentId) {
          throw new LeverError(
            400,
            "invalid_condition",
            `condition ${conditionId} does not exist in this parameter's environment`,
          );
        }
        if (!valueMatchesType(parameter.type, value)) {
          throw typeMismatch(`value for condition ${conditionId}`, parameter.type);
        }
      }
      return repos.parameters.replaceConditionalValues(parameterId, values);
    },
  };
}
