/**
 * Behavior the data-only contract fixtures cannot express: thrown errors and
 * prototype-chain hygiene. Everything else lives in fixtures.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { evaluate } from "./evaluate";
import type { Snapshot } from "./snapshot";

describe("evaluate", () => {
  test("refuses a snapshot format it does not know", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately invalid input
    const snapshot = { format: 2, parameters: {} } as unknown as Snapshot;
    expect(() => evaluate(snapshot, { attributes: {} })).toThrow("unsupported snapshot format");
  });

  test("attributes named after Object.prototype members do not leak through the prototype chain", () => {
    const snapshot: Snapshot = {
      format: 1,
      parameters: {
        exists_gate: {
          type: "boolean",
          defaultValue: false,
          conditionalValues: [
            {
              condition: {
                name: "has-toString",
                clauses: [{ kind: "attribute", attribute: "toString", op: "exists" }],
              },
              value: true,
            },
          ],
        },
        eq_gate: {
          type: "boolean",
          defaultValue: false,
          conditionalValues: [
            {
              condition: {
                name: "constructor-eq",
                clauses: [{ kind: "attribute", attribute: "constructor", op: "neq", value: "x" }],
              },
              value: true,
            },
          ],
        },
      },
    };
    expect(evaluate(snapshot, { attributes: {} })).toEqual({
      exists_gate: { type: "boolean", value: false },
      eq_gate: { type: "boolean", value: false },
    });
  });
});
