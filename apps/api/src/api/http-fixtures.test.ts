/**
 * HTTP contract fixtures (spec 0002 §10.4): the tapes every SDK replays through
 * its transport double, generated and verified here against the real server so
 * they can never drift from what lever actually emits.
 *
 * `bun run fixtures:update` rewrites each file's recorded `response` from a live
 * run; the default mode asserts the recording still matches byte for byte —
 * ETags are SHA-256 over the canonical body, so a matching ETag pins the exact
 * response bytes, not just an equivalent JSON shape.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { clausesSchema, jsonValueSchema, parameterTypeSchema } from "../service/snapshot";
import { createTestApp, type TestApp } from "../test-support";

const UPDATE = Bun.env.LEVER_UPDATE_FIXTURES === "1";

const httpFixturesDir = join(
  dirname(Bun.resolveSync("@lever/contract-fixtures/package.json", import.meta.dir)),
  "fixtures",
  "http",
);

const contextSchema = z.strictObject({
  platform: z.string().optional(),
  appVersion: z.string().optional(),
  clientId: z.string().optional(),
  attributes: z.record(z.string(), z.string()),
});

const stepSchema = z.strictObject({
  before: z.enum(["rotate-key", "publish"]).optional(),
  request: z.strictObject({
    path: z.literal("/v1/resolve"),
    context: contextSchema,
    query: z.string(),
    // The validator to send, named by the step whose ETag it is (1-based) —
    // one source of truth, so a regenerated ETag can never desync.
    ifNoneMatch: z.strictObject({ fromStep: z.number().int().positive() }).optional(),
  }),
  response: z.strictObject({
    status: z.number().int(),
    etag: z.string().nullable().optional(),
    body: jsonValueSchema.nullable().optional(),
  }),
  expect: z.looseObject({}),
});

const fixtureSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  setup: z.strictObject({
    conditions: z.array(z.strictObject({ name: z.string().min(1), clauses: clausesSchema })),
    parameters: z.array(
      z.strictObject({
        key: z.string().min(1),
        type: parameterTypeSchema,
        defaultValue: jsonValueSchema,
        conditionalValues: z.array(
          z.strictObject({ condition: z.string().min(1), value: jsonValueSchema }),
        ),
      }),
    ),
    publish: z.boolean(),
  }),
  steps: z.array(stepSchema).min(1),
});

type Fixture = z.infer<typeof fixtureSchema>;
type ResolveContext = z.infer<typeof contextSchema>;

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** RFC 3986 percent-encoding over UTF-8, unreserved set only — the one rule every SDK implements. */
function encodeComponent(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    out += UNRESERVED.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

const utf8 = (value: string) => new TextEncoder().encode(value);

/** Ascending UTF-8 byte order — identical to Unicode scalar order, and reproducible in any language. */
export function compareByteWise(a: string, b: string): number {
  const left = utf8(a);
  const right = utf8(b);
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/**
 * The resolve query string, in the order every SDK must produce it: the
 * reserved names in a fixed order, then `attr.*` sorted by name.
 */
export function queryFor(context: ResolveContext): string {
  const items: string[] = [];
  for (const name of ["platform", "appVersion", "clientId"] as const) {
    const value = context[name];
    if (value !== undefined) items.push(`${name}=${encodeComponent(value)}`);
  }
  for (const name of Object.keys(context.attributes).sort(compareByteWise)) {
    items.push(`attr.${encodeComponent(name)}=${encodeComponent(context.attributes[name] ?? "")}`);
  }
  return items.join("&");
}

interface Seeded {
  clientKey: string;
  environmentId: string;
}

async function seed(app: TestApp, setup: Fixture["setup"]): Promise<Seeded> {
  const post = (path: string, body?: unknown) =>
    app.request(path, body === undefined ? { method: "POST" } : { method: "POST", body });
  const json = async (response: Promise<Response>) => {
    const resolved = await response;
    expect(resolved.status).toBeLessThan(300);
    return resolved.json();
  };

  const project = await json(post("/v1/admin/projects", { key: "acme", name: "Acme" }));
  const environment = await json(
    post(`/v1/admin/projects/${project.id}/environments`, { key: "prod" }),
  );

  const conditionIds = new Map<string, string>();
  for (const condition of setup.conditions) {
    const created = await json(
      post(`/v1/admin/environments/${environment.id}/conditions`, condition),
    );
    conditionIds.set(condition.name, created.id);
  }

  for (const parameter of setup.parameters) {
    const created = await json(
      post(`/v1/admin/environments/${environment.id}/parameters`, {
        key: parameter.key,
        type: parameter.type,
        defaultValue: parameter.defaultValue,
      }),
    );
    if (parameter.conditionalValues.length === 0) continue;
    const response = await app.request(`/v1/admin/parameters/${created.id}/conditional-values`, {
      method: "PUT",
      body: parameter.conditionalValues.map(({ condition, value }) => {
        const conditionId = conditionIds.get(condition);
        if (conditionId === undefined) throw new Error(`unknown condition: ${condition}`);
        return { conditionId, value };
      }),
    });
    expect(response.status).toBeLessThan(300);
  }

  if (setup.publish) {
    const published = await post(`/v1/admin/environments/${environment.id}/publish`);
    expect(published.status).toBe(201);
  }

  return { clientKey: environment.clientKey, environmentId: environment.id };
}

const files = readdirSync(httpFixturesDir)
  .filter((file) => file.endsWith(".json"))
  .sort();
if (files.length === 0) throw new Error(`no http fixtures found in ${httpFixturesDir}`);

describe("http contract fixtures", () => {
  for (const file of files) {
    const path = join(httpFixturesDir, file);
    const fixture = fixtureSchema.parse(JSON.parse(readFileSync(path, "utf8")));

    describe(fixture.name, () => {
      test("the file name matches the fixture name", () => {
        expect(file).toBe(`${fixture.name}.json`);
      });

      test("every recorded query is what the documented encoding produces", () => {
        for (const step of fixture.steps) {
          expect(queryFor(step.request.context)).toBe(step.request.query);
        }
      });

      test("the recording still matches the live server", async () => {
        const app = createTestApp();
        // The client key is fixed at configure time, so a rotation mid-tape
        // means the client keeps sending the old one — that is the 401 case.
        const { clientKey, environmentId } = await seed(app, fixture.setup);
        const etags: (string | null)[] = [];

        for (const [index, step] of fixture.steps.entries()) {
          if (step.before === "rotate-key") {
            const rotated = await app.request(
              `/v1/admin/environments/${environmentId}/rotate-key`,
              {
                method: "POST",
              },
            );
            expect(rotated.status).toBeLessThan(300);
          } else if (step.before === "publish") {
            const published = await app.request(`/v1/admin/environments/${environmentId}/publish`, {
              method: "POST",
            });
            expect(published.status).toBe(201);
          }

          const headers: Record<string, string> = {};
          if (step.request.ifNoneMatch !== undefined) {
            const source = etags[step.request.ifNoneMatch.fromStep - 1];
            if (typeof source !== "string") {
              throw new Error(`step ${index + 1} references a step with no ETag`);
            }
            headers["If-None-Match"] = source;
          }

          const response = await app.request(`${step.request.path}?${step.request.query}`, {
            token: clientKey,
            headers,
          });
          const etag = response.headers.get("ETag");
          etags.push(etag);

          const text = await response.text();
          const body = text === "" ? null : jsonValueSchema.parse(JSON.parse(text));
          const recorded = { status: response.status, etag, body };

          if (UPDATE) {
            step.response = recorded;
          } else {
            expect({
              status: step.response.status,
              etag: step.response.etag ?? null,
              body: step.response.body ?? null,
            }).toEqual(recorded);
          }
        }

        if (UPDATE) writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
      });
    });
  }
});
