import type { Condition, ConditionRepo } from "../../db/condition-repo";
import type { EnvironmentRepo } from "../../db/environment-repo";
import { isConstraintError, LeverError, notFound } from "../../error";
import type { Clause } from "../snapshot";

export interface ConditionsService {
  listByEnvironment(environmentId: string): Condition[];
  create(environmentId: string, input: { name: string; clauses: Clause[] }): Condition;
  get(id: string): Condition;
  update(
    id: string,
    patch: { name?: string | undefined; clauses?: Clause[] | undefined },
  ): Condition;
  /** 409 while any conditional value references it — the §3.2 RESTRICT, surfaced. */
  remove(id: string): void;
}

export function createConditionsService(repos: {
  conditions: ConditionRepo;
  environments: EnvironmentRepo;
}): ConditionsService {
  const get = (id: string): Condition => {
    const condition = repos.conditions.getById(id);
    if (condition === undefined) throw notFound("condition");
    return condition;
  };

  return {
    listByEnvironment(environmentId) {
      if (repos.environments.getById(environmentId) === undefined) throw notFound("environment");
      return repos.conditions.listByEnvironment(environmentId);
    },
    create(environmentId, input) {
      if (repos.environments.getById(environmentId) === undefined) throw notFound("environment");
      try {
        return repos.conditions.create({ environmentId, ...input });
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
    update(id, patch) {
      get(id);
      const cleaned: { name?: string; clauses?: Clause[] } = {};
      if (patch.name !== undefined) cleaned.name = patch.name;
      if (patch.clauses !== undefined) cleaned.clauses = patch.clauses;
      try {
        const updated = repos.conditions.update(id, cleaned);
        if (updated === undefined) throw notFound("condition");
        return updated;
      } catch (error) {
        if (isConstraintError(error)) {
          throw new LeverError(409, "already_exists", `condition name is already taken`);
        }
        throw error;
      }
    },
    remove(id) {
      get(id);
      try {
        repos.conditions.remove(id);
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
