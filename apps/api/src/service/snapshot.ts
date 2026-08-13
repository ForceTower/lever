/**
 * The persisted shapes of spec 0001: clause vocabulary (§4), snapshot (§3.3),
 * and the derived diff (§3.4). Snapshots are validated here at publish time so
 * evaluation may assume well-formed input; `format` versions the snapshot shape
 * itself because snapshots are stored forever.
 */
import { z } from "zod";
import { canonicalize, type JsonValue } from "./canonicalize";
import { parseSemver } from "./semver";

const list = z.array(z.string()).min(1);
const attrName = z.string().min(1).max(64);
const semverString = z
  .string()
  .refine((value) => parseSemver(value) !== undefined, "must be strict semver");

// Operator and value shape validate as pairs — `eq` with a list or `exists`
// with a value cannot reach the evaluator or get baked into a snapshot.
export const clauseSchema = z.union([
  z.strictObject({ kind: z.literal("platform"), op: z.literal("eq"), value: z.string() }),
  z.strictObject({ kind: z.literal("platform"), op: z.literal("in"), value: list }),
  z.strictObject({
    kind: z.literal("appVersion"),
    op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]),
    value: semverString,
  }),
  z.strictObject({
    kind: z.literal("attribute"),
    attribute: attrName,
    op: z.enum(["eq", "neq"]),
    value: z.string(),
  }),
  z.strictObject({
    kind: z.literal("attribute"),
    attribute: attrName,
    op: z.enum(["in", "notIn"]),
    value: list,
  }),
  z.strictObject({ kind: z.literal("attribute"), attribute: attrName, op: z.literal("exists") }),
]);

// At least one clause: an empty array must not silently become match-all.
export const clausesSchema = z.array(clauseSchema).min(1);

export type Clause = z.infer<typeof clauseSchema>;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const parameterTypeSchema = z.enum(["boolean", "string", "number", "json"]);
export type ParameterType = z.infer<typeof parameterTypeSchema>;

export function valueMatchesType(type: ParameterType, value: JsonValue): boolean {
  return type === "json" || typeof value === type;
}

const snapshotConditionSchema = z.strictObject({
  name: z.string().min(1),
  clauses: clausesSchema,
});

const snapshotParameterSchema = z
  .strictObject({
    type: parameterTypeSchema,
    defaultValue: jsonValueSchema,
    conditionalValues: z.array(
      z.strictObject({ condition: snapshotConditionSchema, value: jsonValueSchema }),
    ),
  })
  .check((ctx) => {
    const { type, defaultValue, conditionalValues } = ctx.value;
    if (!valueMatchesType(type, defaultValue)) {
      ctx.issues.push({
        code: "custom",
        message: `defaultValue must be a ${type}`,
        path: ["defaultValue"],
        input: defaultValue,
      });
    }
    conditionalValues.forEach((conditionalValue, index) => {
      if (!valueMatchesType(type, conditionalValue.value)) {
        ctx.issues.push({
          code: "custom",
          message: `value must be a ${type}`,
          path: ["conditionalValues", index, "value"],
          input: conditionalValue.value,
        });
      }
    });
  });

export const SNAPSHOT_FORMAT = 1;

export const snapshotSchema = z.strictObject({
  format: z.literal(SNAPSHOT_FORMAT),
  parameters: z.record(z.string(), snapshotParameterSchema),
});

export type Snapshot = z.infer<typeof snapshotSchema>;
export type SnapshotParameter = Snapshot["parameters"][string];

/**
 * Stored snapshot bytes → validated snapshot. Refuses a `format` it does not
 * know rather than guessing (§3.3).
 */
export function parseSnapshot(bytes: string): Snapshot {
  return snapshotSchema.parse(JSON.parse(bytes));
}

/**
 * The draft rows publish serializes, joined and ordered by the caller:
 * conditional values in `position` order. Parameter `description` is draft-only
 * operator metadata and deliberately absent — snapshots are lossy (§3.3).
 */
export interface DraftParameter {
  key: string;
  type: ParameterType;
  defaultValue: JsonValue;
  conditionalValues: {
    condition: { name: string; clauses: Clause[] };
    value: JsonValue;
  }[];
}

export function buildSnapshot(parameters: DraftParameter[]): Snapshot {
  return {
    format: SNAPSHOT_FORMAT,
    parameters: Object.fromEntries(
      parameters.map((parameter) => [
        parameter.key,
        {
          type: parameter.type,
          defaultValue: parameter.defaultValue,
          conditionalValues: parameter.conditionalValues.map(({ condition, value }) => ({
            condition: { name: condition.name, clauses: condition.clauses },
            value,
          })),
        },
      ]),
    ),
  };
}

export interface SnapshotDiff {
  added: { key: string; after: SnapshotParameter }[];
  removed: { key: string; before: SnapshotParameter }[];
  changed: { key: string; before: SnapshotParameter; after: SnapshotParameter }[];
}

/**
 * Structural comparison of adjacent snapshots (§3.4) — derived on read, never
 * stored. Entries compare by canonical bytes, so condition and
 * conditional-value edits surface as `changed` even when the default is
 * untouched.
 */
export function diffSnapshots(before: Snapshot | undefined, after: Snapshot): SnapshotDiff {
  const beforeParameters = before?.parameters ?? {};
  const diff: SnapshotDiff = { added: [], removed: [], changed: [] };
  const keys = [
    ...new Set([...Object.keys(beforeParameters), ...Object.keys(after.parameters)]),
  ].sort();
  for (const key of keys) {
    const beforeEntry = beforeParameters[key];
    const afterEntry = after.parameters[key];
    if (beforeEntry === undefined) {
      if (afterEntry !== undefined) diff.added.push({ key, after: afterEntry });
    } else if (afterEntry === undefined) {
      diff.removed.push({ key, before: beforeEntry });
    } else if (canonicalize(beforeEntry) !== canonicalize(afterEntry)) {
      diff.changed.push({ key, before: beforeEntry, after: afterEntry });
    }
  }
  return diff;
}
