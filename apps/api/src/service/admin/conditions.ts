import type { Condition, ConditionRepo } from "../../db/condition-repo";
import type { EnvironmentRepo } from "../../db/environment-repo";
import { isConstraintError, LeverError, notFound } from "../../error";
import type { Clause } from "../snapshot";

export interface ConditionsService {
  listByEnvironment(environmentId: string): Promise<Condition[]>;
  create(environmentId: string, input: { name: string; clauses: Clause[] }): Promise<Condition>;
  get(id: string): Promise<Condition>;
  update(
    id: string,
    patch: { name?: string | undefined; clauses?: Clause[] | undefined },
  ): Promise<Condition>;
  /** 409 while any conditional value references it — the §3.2 RESTRICT, surfaced. */
  remove(id: string): Promise<void>;
}

export function createConditionsService(repos: {
  conditions: ConditionRepo;
  environments: EnvironmentRepo;
}): ConditionsService {
  const get = async (id: string): Promise<Condition> => {
    const condition = await repos.conditions.getById(id);
    if (condition === undefined) throw notFound("condition");
    return condition;
  };

  const ensureEnvironment = async (environmentId: string): Promise<void> => {
    if ((await repos.environments.getById(environmentId)) === undefined) {
      throw notFound("environment");
    }
  };

  return {
    async listByEnvironment(environmentId) {
      await ensureEnvironment(environmentId);
      return repos.conditions.listByEnvironment(environmentId);
    },
    async create(environmentId, input) {
      await ensureEnvironment(environmentId);
      try {
        return await repos.conditions.create({ environmentId, ...input });
      } catch (error) {
        if (isConstraintError(error)) {
          throw new LeverError(
            409,
            "already_exists",
            `condition "${input.name}" already exists in this environment`,
          );
        }
        throw error;
      }
    },
    get,
    async update(id, patch) {
      await get(id);
      const cleaned: { name?: string; clauses?: Clause[] } = {};
      if (patch.name !== undefined) cleaned.name = patch.name;
      if (patch.clauses !== undefined) cleaned.clauses = patch.clauses;
      try {
        const updated = await repos.conditions.update(id, cleaned);
        if (updated === undefined) throw notFound("condition");
        return updated;
      } catch (error) {
        if (isConstraintError(error)) {
          throw new LeverError(409, "already_exists", `condition name is already taken`);
        }
        throw error;
      }
    },
    async remove(id) {
      await get(id);
      try {
        await repos.conditions.remove(id);
      } catch (error) {
        if (isConstraintError(error)) {
          throw new LeverError(
            409,
            "condition_in_use",
            "condition is referenced by parameter conditional values; remove those references first",
          );
        }
        throw error;
      }
    },
  };
}
