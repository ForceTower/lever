/**
 * Pure rule evaluation (spec 0001 §4): snapshot + context → resolved values.
 * Server-side only; SDKs never see this. The engine never throws on malformed
 * context — bad input degrades to non-match. Snapshots are validated at
 * publish time, so evaluation assumes a well-formed snapshot but still refuses
 * a format it does not know rather than guessing.
 */
import type { JsonValue } from "./canonicalize";
import { compareSemver, parseSemver, type Semver } from "./semver";
import { SNAPSHOT_FORMAT, type Clause, type ParameterType, type Snapshot } from "./snapshot";

export interface ResolveContext {
  platform?: string | undefined;
  appVersion?: string | undefined;
  clientId?: string | undefined; // reserved for v1.x percentage rollouts (research §4.4)
  attributes: Record<string, string>;
}

export interface ResolvedValue {
  type: ParameterType;
  value: JsonValue;
}

export function evaluate(
  snapshot: Snapshot,
  context: ResolveContext,
): Record<string, ResolvedValue> {
  if (snapshot.format !== SNAPSHOT_FORMAT) {
    throw new Error(`unsupported snapshot format: ${String(snapshot.format)}`);
  }
  const platform = context.platform?.toLowerCase();
  const appVersion = context.appVersion === undefined ? undefined : parseSemver(context.appVersion);

  const values: Record<string, ResolvedValue> = {};
  for (const [key, parameter] of Object.entries(snapshot.parameters)) {
    // First matching conditional value wins; default is the floor.
    const match = parameter.conditionalValues.find(({ condition }) =>
      condition.clauses.every((clause) => matchesClause(clause, platform, appVersion, context)),
    );
    values[key] = { type: parameter.type, value: match?.value ?? parameter.defaultValue };
  }
  return values;
}

/**
 * Missing input never matches — including negated operators (`neq`, `notIn`):
 * targeting only ever narrows, so an SDK that sends nothing gets pure defaults.
 */
function matchesClause(
  clause: Clause,
  platform: string | undefined,
  appVersion: Semver | undefined,
  context: ResolveContext,
): boolean {
  switch (clause.kind) {
    case "platform": {
      if (platform === undefined) return false;
      if (clause.op === "eq") return platform === clause.value.toLowerCase();
      return clause.value.some((candidate) => candidate.toLowerCase() === platform);
    }
    case "appVersion": {
      if (appVersion === undefined) return false;
      const operand = parseSemver(clause.value);
      if (operand === undefined) return false; // unreachable for validated snapshots
      const order = compareSemver(appVersion, operand);
      return {
        eq: order === 0,
        neq: order !== 0,
        gt: order > 0,
        gte: order >= 0,
        lt: order < 0,
        lte: order <= 0,
      }[clause.op];
    }
    case "attribute": {
      // hasOwn, not `in`: an attribute named "toString" must not match via the
      // prototype chain.
      const present = Object.hasOwn(context.attributes, clause.attribute);
      if (clause.op === "exists") return present;
      const actual = present ? context.attributes[clause.attribute] : undefined;
      if (actual === undefined) return false;
      switch (clause.op) {
        case "eq":
          return actual === clause.value;
        case "neq":
          return actual !== clause.value;
        case "in":
          return clause.value.includes(actual);
        case "notIn":
          return !clause.value.includes(actual);
      }
    }
  }
}
