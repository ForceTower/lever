import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createTestApp, type TestApp, type TestRequestInit, dataOf } from "../../test-support";

type Request = TestApp["request"];

const post = (body?: unknown): TestRequestInit =>
  body === undefined ? { method: "POST" } : { method: "POST", body };
const patch = (body: unknown): TestRequestInit => ({ method: "PATCH", body });
const put = (body: unknown): TestRequestInit => ({ method: "PUT", body });

/** A project + environment with one condition and one boolean parameter. */
async function seed(request: Request) {
  const project = await dataOf(
    await request("/v1/admin/projects", post({ key: "acme", name: "Acme" })),
  );
  const environment = await dataOf(
    await request(`/v1/admin/projects/${project.id}/environments`, post({ key: "prod" })),
  );
  const condition = await dataOf(
    await request(
      `/v1/admin/environments/${environment.id}/conditions`,
      post({ name: "android", clauses: [{ kind: "platform", op: "eq", value: "android" }] }),
    ),
  );
  const parameter = await dataOf(
    await request(
      `/v1/admin/environments/${environment.id}/parameters`,
      post({ key: "enable_thing", type: "boolean", defaultValue: false, description: "keep me" }),
    ),
  );
  await request(
    `/v1/admin/parameters/${parameter.id}/conditional-values`,
    put([{ conditionId: condition.id, value: true }]),
  );
  return { project, environment, condition, parameter };
}

async function publish(request: Request, envId: string, body?: unknown) {
  return request(`/v1/admin/environments/${envId}/publish`, post(body));
}

describe("publish", () => {
  test("first publish creates version 1 with an all-added diff and the author", async () => {
    const { request } = createTestApp();
    const { environment } = await seed(request);

    const res = await publish(request, environment.id);
    expect(res.status).toBe(201);
    const body = await dataOf(res);
    expect(body.version).toBe(1);
    expect(body.author).toBe("test");
    expect(body.rollbackOf).toBeNull();
    expect(body.diff.added.map((e: { key: string }) => e.key)).toEqual(["enable_thing"]);

    const detail = await dataOf(await request(`/v1/admin/environments/${environment.id}`));
    expect(detail.latestVersion).toBe(1);
    expect(detail.draftDirty).toBe(false);
  });

  test("the preview shows the would-be diff and dirty flag without publishing", async () => {
    const { request } = createTestApp();
    const { environment } = await seed(request);

    const preview = await dataOf(await request(`/v1/admin/environments/${environment.id}/diff`));
    expect(preview.draftDirty).toBe(true);
    expect(preview.diff.added).toHaveLength(1);

    await publish(request, environment.id);
    const after = await dataOf(await request(`/v1/admin/environments/${environment.id}/diff`));
    expect(after.draftDirty).toBe(false);
    expect(after.diff).toEqual({ added: [], removed: [], changed: [] });
  });

  test("an unchanged draft is 409 nothing_to_publish, including an empty never-published one", async () => {
    const { request } = createTestApp();
    const { environment } = await seed(request);
    await publish(request, environment.id);

    const unchanged = await publish(request, environment.id);
    expect(unchanged.status).toBe(409);
    expect((await unchanged.json()).error.code).toBe("nothing_to_publish");

    const project = await dataOf(
      await request("/v1/admin/projects", post({ key: "other", name: "Other" })),
    );
    const empty = await dataOf(
      await request(`/v1/admin/projects/${project.id}/environments`, post({ key: "prod" })),
    );
    const emptyPublish = await publish(request, empty.id);
    expect(emptyPublish.status).toBe(409);
    expect((await emptyPublish.json()).error.code).toBe("nothing_to_publish");
  });

  test("a stale expectedVersion is 409 publish_conflict", async () => {
    const { request } = createTestApp();
    const { environment, parameter } = await seed(request);
    await publish(request, environment.id, { expectedVersion: 0 });

    await request(`/v1/admin/parameters/${parameter.id}`, patch({ defaultValue: true }));
    const stale = await publish(request, environment.id, { expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("publish_conflict");

    const fresh = await publish(request, environment.id, { expectedVersion: 1 });
    expect(fresh.status).toBe(201);
  });

  test("a held write lock maps to 409 publish_conflict, never a 500", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lever-publish-test-"));
    try {
      const { request, env } = createTestApp({ dbPath: join(dir, "test.db") });
      const { environment } = await seed(request);
      env.sqlite.exec("PRAGMA busy_timeout = 100");

      const other = new Database(join(dir, "test.db"));
      other.exec("PRAGMA busy_timeout = 100");
      other.exec("BEGIN IMMEDIATE");
      try {
        const res = await publish(request, environment.id);
        expect(res.status).toBe(409);
        expect((await res.json()).error.code).toBe("publish_conflict");
      } finally {
        other.exec("ROLLBACK");
        other.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("publishing for an unknown environment is 404", async () => {
    const { request } = createTestApp();
    await seed(request);
    expect((await publish(request, "missing")).status).toBe(404);
  });
});

describe("publish immutability (§10.3)", () => {
  test("later draft and condition edits leave published snapshots byte-identical", async () => {
    const { request, env } = createTestApp();
    const { environment, parameter, condition } = await seed(request);
    await publish(request, environment.id);
    const v1Before = await env.repos.versions.get(environment.id, 1);

    await request(`/v1/admin/parameters/${parameter.id}`, patch({ defaultValue: true }));
    await request(
      `/v1/admin/conditions/${condition.id}`,
      patch({ clauses: [{ kind: "platform", op: "eq", value: "ios" }] }),
    );
    await publish(request, environment.id);

    const v1After = await env.repos.versions.get(environment.id, 1);
    expect(v1After?.snapshot).toBe(v1Before?.snapshot ?? "");
    expect((await env.repos.versions.get(environment.id, 2))?.snapshot).not.toBe(
      v1Before?.snapshot,
    );
  });
});

describe("versions", () => {
  test("list is descending with diff summary counts", async () => {
    const { request } = createTestApp();
    const { environment, parameter } = await seed(request);
    await publish(request, environment.id);
    await request(`/v1/admin/parameters/${parameter.id}`, patch({ defaultValue: true }));
    await publish(request, environment.id);

    const list = await dataOf(await request(`/v1/admin/environments/${environment.id}/versions`));
    expect(list.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(list[0].diff).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(list[1].diff).toEqual({ added: 1, removed: 0, changed: 0 });
  });

  test("detail returns the full snapshot and the derived diff against n-1", async () => {
    const { request } = createTestApp();
    const { environment, parameter } = await seed(request);
    await publish(request, environment.id);
    await request(`/v1/admin/parameters/${parameter.id}`, patch({ defaultValue: true }));
    await publish(request, environment.id);

    const v2 = await dataOf(await request(`/v1/admin/environments/${environment.id}/versions/2`));
    expect(v2.snapshot.format).toBe(1);
    expect(v2.snapshot.parameters.enable_thing.defaultValue).toBe(true);
    // The description is draft-only operator metadata — never in the snapshot (§3.3).
    expect(v2.snapshot.parameters.enable_thing.description).toBeUndefined();
    expect(v2.diff.changed).toHaveLength(1);

    expect((await request(`/v1/admin/environments/${environment.id}/versions/9`)).status).toBe(404);
    expect((await request(`/v1/admin/environments/${environment.id}/versions/abc`)).status).toBe(
      400,
    );
  });
});

describe("rollback (§8.4)", () => {
  test("republishes the target as N+1, resets the draft, and preserves draft-only state", async () => {
    const { request, env } = createTestApp();
    const { environment, parameter, condition } = await seed(request);
    await publish(request, environment.id);

    // Diverge the draft: flip the default, add a parameter, retarget the
    // shared condition, and add a condition rollback should never touch.
    await request(`/v1/admin/parameters/${parameter.id}`, patch({ defaultValue: true }));
    await request(
      `/v1/admin/environments/${environment.id}/parameters`,
      post({ key: "extra", type: "string", defaultValue: "x" }),
    );
    await request(
      `/v1/admin/conditions/${condition.id}`,
      patch({ clauses: [{ kind: "platform", op: "eq", value: "ios" }] }),
    );
    await request(
      `/v1/admin/environments/${environment.id}/conditions`,
      post({
        name: "unreferenced",
        clauses: [{ kind: "attribute", attribute: "beta", op: "exists" }],
      }),
    );
    await publish(request, environment.id);

    const res = await request(
      `/v1/admin/environments/${environment.id}/versions/1/rollback`,
      post(),
    );
    expect(res.status).toBe(201);
    const v3 = await dataOf(res);
    expect(v3.version).toBe(3);
    expect(v3.rollbackOf).toBe(1);

    // v3's snapshot is byte-identical to v1's — same config, new version.
    expect((await env.repos.versions.get(environment.id, 3))?.snapshot).toBe(
      (await env.repos.versions.get(environment.id, 1))?.snapshot ?? "",
    );

    // The draft now matches v1: same parameter row (id and description
    // survive), the extra parameter is gone, the condition is retargeted back.
    const detail = await dataOf(await request(`/v1/admin/environments/${environment.id}`));
    expect(detail.latestVersion).toBe(3);
    expect(detail.draftDirty).toBe(false);
    const parameters = await dataOf(
      await request(`/v1/admin/environments/${environment.id}/parameters`),
    );
    expect(parameters).toHaveLength(1);
    expect(parameters[0].id).toBe(parameter.id);
    expect(parameters[0].description).toBe("keep me");
    expect(parameters[0].defaultValue).toBe(false);
    const rolledCondition = await dataOf(await request(`/v1/admin/conditions/${condition.id}`));
    expect(rolledCondition.clauses[0].value).toBe("android");

    // The unreferenced condition survives the rewrite — the operator's
    // condition library is not rollback's to destroy.
    const conditions = await dataOf(
      await request(`/v1/admin/environments/${environment.id}/conditions`),
    );
    expect(conditions.map((entry: { name: string }) => entry.name)).toContain("unreferenced");

    // History is append-only across rollback.
    const list = await dataOf(await request(`/v1/admin/environments/${environment.id}/versions`));
    expect(list.map((entry: { version: number }) => entry.version)).toEqual([3, 2, 1]);
  });

  test("rolling back to the currently live version succeeds", async () => {
    const { request } = createTestApp();
    const { environment } = await seed(request);
    await publish(request, environment.id);

    const res = await request(
      `/v1/admin/environments/${environment.id}/versions/1/rollback`,
      post(),
    );
    expect(res.status).toBe(201);
    const v2 = await dataOf(res);
    expect(v2.version).toBe(2);
    expect(v2.rollbackOf).toBe(1);
  });

  test("rolling back to an unknown version is 404", async () => {
    const { request } = createTestApp();
    const { environment } = await seed(request);
    await publish(request, environment.id);
    const res = await request(
      `/v1/admin/environments/${environment.id}/versions/9/rollback`,
      post(),
    );
    expect(res.status).toBe(404);
  });
});
