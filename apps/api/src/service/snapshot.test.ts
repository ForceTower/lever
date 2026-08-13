import { describe, expect, test } from "bun:test";
import {
  buildSnapshot,
  clauseSchema,
  clausesSchema,
  diffSnapshots,
  snapshotSchema,
  type Snapshot,
} from "./snapshot";

describe("clause validation", () => {
  test("rejects an empty clause list — it must not become match-all", () => {
    expect(clausesSchema.safeParse([]).success).toBe(false);
  });

  test.each([
    [{ kind: "platform", op: "eq", value: ["android"] }, "eq with a list"],
    [{ kind: "platform", op: "in", value: "android" }, "in with a scalar"],
    [{ kind: "platform", op: "in", value: [] }, "in with an empty list"],
    [{ kind: "appVersion", op: "gte", value: "5.2" }, "non-semver operand"],
    [{ kind: "attribute", attribute: "role", op: "exists", value: "x" }, "exists with a value"],
    [{ kind: "attribute", op: "eq", value: "x" }, "attribute without a name"],
    [{ kind: "platform", op: "eq", value: "android", extra: 1 }, "stray extra field"],
    [{ kind: "locale", op: "eq", value: "en" }, "unknown kind"],
  ])("rejects %j (%s)", (clause) => {
    expect(clauseSchema.safeParse(clause).success).toBe(false);
  });

  test.each([
    [{ kind: "platform", op: "eq", value: "android" }],
    [{ kind: "platform", op: "in", value: ["android", "ios"] }],
    [{ kind: "appVersion", op: "gte", value: "5.2.0-beta.1" }],
    [{ kind: "attribute", attribute: "role", op: "eq", value: "student" }],
    [{ kind: "attribute", attribute: "campus", op: "notIn", value: ["a"] }],
    [{ kind: "attribute", attribute: "cohort", op: "exists" }],
  ])("accepts %j", (clause) => {
    expect(clauseSchema.safeParse(clause).success).toBe(true);
  });
});

describe("snapshot validation", () => {
  const valid = {
    format: 1,
    parameters: {
      gate: { type: "boolean", defaultValue: false, conditionalValues: [] },
    },
  };

  test("accepts a well-formed snapshot", () => {
    expect(snapshotSchema.safeParse(valid).success).toBe(true);
  });

  test("rejects an unknown format", () => {
    expect(snapshotSchema.safeParse({ ...valid, format: 2 }).success).toBe(false);
  });

  test("rejects a defaultValue that does not match the declared type", () => {
    const snapshot = {
      format: 1,
      parameters: { gate: { type: "boolean", defaultValue: "yes", conditionalValues: [] } },
    };
    expect(snapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  test("rejects a conditional value that does not match the declared type", () => {
    const snapshot = {
      format: 1,
      parameters: {
        retries: {
          type: "number",
          defaultValue: 3,
          conditionalValues: [
            {
              condition: {
                name: "android",
                clauses: [{ kind: "platform", op: "eq", value: "android" }],
              },
              value: "5",
            },
          ],
        },
      },
    };
    expect(snapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  test("json parameters accept any JSON value", () => {
    const snapshot = {
      format: 1,
      parameters: {
        layout: { type: "json", defaultValue: { a: [1, null] }, conditionalValues: [] },
      },
    };
    expect(snapshotSchema.safeParse(snapshot).success).toBe(true);
  });
});

describe("buildSnapshot", () => {
  test("serializes draft parameters, inlining conditions and dropping nothing it is given", () => {
    const snapshot = buildSnapshot([
      {
        key: "gate",
        type: "boolean",
        defaultValue: false,
        conditionalValues: [
          {
            condition: {
              name: "android",
              clauses: [{ kind: "platform", op: "eq", value: "android" }],
            },
            value: true,
          },
        ],
      },
    ]);
    expect(snapshot).toEqual({
      format: 1,
      parameters: {
        gate: {
          type: "boolean",
          defaultValue: false,
          conditionalValues: [
            {
              condition: {
                name: "android",
                clauses: [{ kind: "platform", op: "eq", value: "android" }],
              },
              value: true,
            },
          ],
        },
      },
    });
    expect(snapshotSchema.safeParse(snapshot).success).toBe(true);
  });
});

describe("diffSnapshots", () => {
  const base: Snapshot = {
    format: 1,
    parameters: {
      gate: { type: "boolean", defaultValue: false, conditionalValues: [] },
      retries: { type: "number", defaultValue: 3, conditionalValues: [] },
    },
  };

  test("no previous snapshot means everything is added", () => {
    const diff = diffSnapshots(undefined, base);
    expect(diff.added.map((entry) => entry.key)).toEqual(["gate", "retries"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  test("identical snapshots produce an empty diff", () => {
    const diff = diffSnapshots(base, structuredClone(base));
    expect(diff).toEqual({ added: [], removed: [], changed: [] });
  });

  test("added, removed, and changed are all detected", () => {
    const after: Snapshot = {
      format: 1,
      parameters: {
        gate: { type: "boolean", defaultValue: true, conditionalValues: [] },
        max_size: { type: "number", defaultValue: 10, conditionalValues: [] },
      },
    };
    const diff = diffSnapshots(base, after);
    expect(diff.added.map((entry) => entry.key)).toEqual(["max_size"]);
    expect(diff.removed.map((entry) => entry.key)).toEqual(["retries"]);
    expect(diff.changed).toEqual([
      {
        key: "gate",
        before: { type: "boolean", defaultValue: false, conditionalValues: [] },
        after: { type: "boolean", defaultValue: true, conditionalValues: [] },
      },
    ]);
  });

  test("a condition-only edit surfaces as changed even when the default is untouched", () => {
    const withCondition = (platform: string): Snapshot => ({
      format: 1,
      parameters: {
        gate: {
          type: "boolean",
          defaultValue: false,
          conditionalValues: [
            {
              condition: {
                name: "target",
                clauses: [{ kind: "platform", op: "eq", value: platform }],
              },
              value: true,
            },
          ],
        },
      },
    });
    const diff = diffSnapshots(withCondition("android"), withCondition("ios"));
    expect(diff.changed.map((entry) => entry.key)).toEqual(["gate"]);
  });
});
