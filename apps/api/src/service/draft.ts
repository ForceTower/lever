import type { ConditionRepo } from "../db/condition-repo";
import type { ParameterRepo } from "../db/parameter-repo";
import { buildSnapshot, type DraftParameter, type Snapshot } from "./snapshot";

export interface DraftRepos {
  parameters: ParameterRepo;
  conditions: ConditionRepo;
}

/**
 * Joins the draft rows into the shape `buildSnapshot` serializes: parameters
 * with their conditional values in `position` order, conditions inlined by
 * value (§3.3). Shared by the environment dirty flag now and by publish and
 * the diff preview in Phase 4.
 */
export function buildDraftSnapshot(repos: DraftRepos, environmentId: string): Snapshot {
  const conditionsById = new Map(
    repos.conditions.listByEnvironment(environmentId).map((condition) => [condition.id, condition]),
  );
  const parameters: DraftParameter[] = repos.parameters
    .listByEnvironment(environmentId)
    .map((parameter) => ({
      key: parameter.key,
      type: parameter.type,
      defaultValue: parameter.defaultValue,
      conditionalValues: repos.parameters.listConditionalValues(parameter.id).map((cv) => {
        const condition = conditionsById.get(cv.conditionId);
        if (condition === undefined) {
          // The FK guarantees this; a miss means the join itself is broken.
          throw new Error(`conditional value references unknown condition ${cv.conditionId}`);
        }
        return {
          condition: { name: condition.name, clauses: condition.clauses },
          value: cv.value,
        };
      }),
    }));
  return buildSnapshot(parameters);
}
