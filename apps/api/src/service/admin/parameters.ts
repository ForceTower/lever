import { withTransaction, type Db, type Repos } from "../../db";
import type { ConditionalValue, Parameter, ParameterRepo } from "../../db/parameter-repo";
import { isConstraintError, LeverError, notFound } from "../../error";
import type { JsonValue } from "../canonicalize";
import { type ParameterType, valueMatchesType } from "../snapshot";

export interface ParameterDetail extends Parameter {
  conditionalValues: ConditionalValue[];
}

export interface ParametersService {
  listByEnvironment(environmentId: string): Promise<ParameterDetail[]>;
  create(
    environmentId: string,
    input: {
      key: string;
      type: ParameterType;
      defaultValue: JsonValue;
      description?: string | undefined;
    },
  ): Promise<ParameterDetail>;
  get(id: string): Promise<ParameterDetail>;
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
  ): Promise<ParameterDetail>;
  remove(id: string): Promise<void>;
  /**
   * Replaces the full ordered list (§8.2): positions are assigned from list
   * order, every condition must belong to the parameter's environment — the
   * §3.2 invariant SQLite cannot express — and every value must match the
   * parameter's type.
   */
  replaceConditionalValues(
    parameterId: string,
    values: { conditionId: string; value: JsonValue }[],
  ): Promise<ConditionalValue[]>;
}

function typeMismatch(where: string, type: ParameterType): LeverError {
  return new LeverError(400, "type_mismatch", `${where} must be a ${type}`);
}

export function createParametersService(db: Db, repos: Repos): ParametersService {
  const getOrThrow = async (id: string, from: ParameterRepo = repos.parameters) => {
    const parameter = await from.getById(id);
    if (parameter === undefined) throw notFound("parameter");
    return parameter;
  };

  const withValues = async (
    parameter: Parameter,
    from: ParameterRepo = repos.parameters,
  ): Promise<ParameterDetail> => ({
    ...parameter,
    conditionalValues: await from.listConditionalValues(parameter.id),
  });

  return {
    async listByEnvironment(environmentId) {
      if ((await repos.environments.getById(environmentId)) === undefined) {
        throw notFound("environment");
      }
      const parameters = await repos.parameters.listByEnvironment(environmentId);
      return Promise.all(parameters.map((parameter) => withValues(parameter)));
    },
    async create(environmentId, input) {
      if ((await repos.environments.getById(environmentId)) === undefined) {
        throw notFound("environment");
      }
      if (!valueMatchesType(input.type, input.defaultValue)) {
        throw typeMismatch("defaultValue", input.type);
      }
      try {
        return await withValues(await repos.parameters.create({ environmentId, ...input }));
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
    get: async (id) => withValues(await getOrThrow(id)),
    async update(id, patch) {
      await getOrThrow(id);
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
        return await withTransaction(db, async (txRepos) => {
          const updated = await txRepos.parameters.update(id, cleaned);
          if (updated === undefined) throw notFound("parameter");
          const detail = await withValues(updated, txRepos.parameters);
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
    async remove(id) {
      await getOrThrow(id);
      await repos.parameters.remove(id);
    },
    async replaceConditionalValues(parameterId, values) {
      const parameter = await getOrThrow(parameterId);
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
        const condition = await repos.conditions.getById(conditionId);
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
      // The repo method is delete-then-insert; the transaction makes it atomic.
      return withTransaction(db, (txRepos) =>
        txRepos.parameters.replaceConditionalValues(parameterId, values),
      );
    },
  };
}
