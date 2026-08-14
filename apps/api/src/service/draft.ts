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
 * value (§3.3). Shared by the environment dirty flag, publish, and the diff
 * preview.
 */
export async function buildDraftSnapshot(
  repos: DraftRepos,
  environmentId: string,
): Promise<Snapshot> {
  const conditionsById = new Map(
    (await repos.conditions.listByEnvironment(environmentId)).map(
      (condition) => [condition.id, condition] as const,
    ),
  );
  const parameters: DraftParameter[] = [];
  for (const parameter of await repos.parameters.listByEnvironment(environmentId)) {
    const conditionalValues = await repos.parameters.listConditionalValues(parameter.id);
    parameters.push({
      key: parameter.key,
      type: parameter.type,
      defaultValue: parameter.defaultValue,
      conditionalValues: conditionalValues.map((cv) => {
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
    });
  }
  return buildSnapshot(parameters);
}
