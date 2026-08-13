/**
 * Contract-fixture-driven tests (spec 0001 §10.2): the evaluation and
 * canonicalization suites are generated from `@lever/contract-fixtures`, the
 * same data-only files that later drive the SDK test suites.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { canonicalize } from "./canonicalize";
import { evaluate } from "./evaluate";
import { jsonValueSchema, parameterTypeSchema, snapshotSchema } from "./snapshot";

const fixturesRoot = join(
  dirname(Bun.resolveSync("@lever/contract-fixtures/package.json", import.meta.dir)),
  "fixtures",
);

function loadCases<Schema extends z.ZodType>(path: string, schema: Schema): z.infer<Schema>[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return z.array(schema).parse(raw);
}

const evaluationCaseSchema = z.strictObject({
  name: z.string().min(1),
  snapshot: snapshotSchema,
  context: z.strictObject({
    platform: z.string().optional(),
    appVersion: z.string().optional(),
    clientId: z.string().optional(),
    attributes: z.record(z.string(), z.string()),
  }),
  expected: z.strictObject({
    values: z.record(
      z.string(),
      z.strictObject({ type: parameterTypeSchema, value: jsonValueSchema }),
    ),
  }),
});

describe("evaluation fixtures", () => {
  const evaluationDir = join(fixturesRoot, "evaluation");
  const files = readdirSync(evaluationDir).sort();
  if (files.length === 0) throw new Error(`no evaluation fixtures found in ${evaluationDir}`);

  for (const file of files) {
    describe(file, () => {
      for (const fixture of loadCases(join(evaluationDir, file), evaluationCaseSchema)) {
        test(fixture.name, () => {
          expect(evaluate(fixture.snapshot, fixture.context)).toEqual(fixture.expected.values);
        });
      }
    });
  }
});

const canonicalizationCaseSchema = z.strictObject({
  name: z.string().min(1),
  value: jsonValueSchema,
  canonical: z.string(),
});

describe("canonicalization fixtures", () => {
  const cases = loadCases(join(fixturesRoot, "canonicalization.json"), canonicalizationCaseSchema);
  for (const fixture of cases) {
    test(fixture.name, () => {
      expect(canonicalize(fixture.value)).toBe(fixture.canonical);
    });
  }

  test("the pinned snapshot case round-trips through JSON.parse", () => {
    for (const fixture of cases) {
      const reparsed: unknown = JSON.parse(fixture.canonical);
      expect(canonicalize(jsonValueSchema.parse(reparsed))).toBe(fixture.canonical);
    }
  });
});
