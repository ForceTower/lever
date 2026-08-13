import { describe, expect, test } from "bun:test";
import { createTestApp, type TestApp, type TestRequestInit } from "../../test-support";

type Request = TestApp["request"];

const post = (body: unknown): TestRequestInit => ({ method: "POST", body });
const patch = (body: unknown): TestRequestInit => ({ method: "PATCH", body });
const put = (body: unknown): TestRequestInit => ({ method: "PUT", body });
const del = (body?: unknown): TestRequestInit =>
  body === undefined ? { method: "DELETE" } : { method: "DELETE", body };

async function createProject(request: Request, key = "acme") {
  const res = await request("/v1/admin/projects", post({ key, name: "Acme" }));
  expect(res.status).toBe(201);
  return res.json();
}

async function createEnvironment(request: Request, projectId: string, key = "prod") {
  const res = await request(`/v1/admin/projects/${projectId}/environments`, post({ key }));
  expect(res.status).toBe(201);
  return res.json();
}

const platformClause = { kind: "platform", op: "eq", value: "android" };

async function createCondition(
  request: Request,
  envId: string,
  name = "android",
  clauses: unknown[] = [platformClause],
) {
  const res = await request(`/v1/admin/environments/${envId}/conditions`, post({ name, clauses }));
  expect(res.status).toBe(201);
  return res.json();
}

async function createParameter(
  request: Request,
  envId: string,
  body: Record<string, unknown> = { key: "enable_thing", type: "boolean", defaultValue: false },
) {
  const res = await request(`/v1/admin/environments/${envId}/parameters`, post(body));
  expect(res.status).toBe(201);
  return res.json();
}

describe("app assembly", () => {
  test("healthz needs no auth and reports name and version", async () => {
    const { request } = createTestApp();
    const res = await request("/healthz", { token: null });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("lever");
    expect(typeof body.version).toBe("string");
  });

  test("unknown routes return the §5 error shape", async () => {
    const { request } = createTestApp();
    const res = await request("/v1/nope", { token: null });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  test("malformed JSON bodies keep the §5 error shape", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/admin/projects", {
      method: "POST",
      headers: {
        Authorization: `Bearer testsecrettestsecrettestsecret12`,
        "Content-Type": "application/json",
      },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
  });
});

describe("admin auth", () => {
  test("missing and wrong tokens are 401", async () => {
    const { request } = createTestApp();
    expect((await request("/v1/admin/projects", { token: null })).status).toBe(401);
    const wrong = await request("/v1/admin/projects", { token: "A".repeat(32) });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error.code).toBe("unauthorized");
  });

  test("a client key cannot reach /v1/admin", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);
    expect(environment.clientKey).toStartWith("pk_");
    const res = await request("/v1/admin/projects", { token: environment.clientKey });
    expect(res.status).toBe(401);
  });
});

describe("projects", () => {
  test("create, list, get, rename", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    expect(project.key).toBe("acme");

    const list = await (await request("/v1/admin/projects")).json();
    expect(list).toHaveLength(1);

    const fetched = await (await request(`/v1/admin/projects/${project.id}`)).json();
    expect(fetched.name).toBe("Acme");

    const renamed = await request(`/v1/admin/projects/${project.id}`, patch({ name: "Acme 2" }));
    expect((await renamed.json()).name).toBe("Acme 2");
  });

  test("invalid slugs fail validation with details", async () => {
    const { request } = createTestApp();
    const res = await request("/v1/admin/projects", post({ key: "Not A Slug", name: "x" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details).toBeDefined();
  });

  test("duplicate keys are 409", async () => {
    const { request } = createTestApp();
    await createProject(request);
    const res = await request("/v1/admin/projects", post({ key: "acme", name: "again" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("already_exists");
  });

  test("unknown ids are 404", async () => {
    const { request } = createTestApp();
    expect((await request("/v1/admin/projects/missing")).status).toBe(404);
  });

  test("delete requires the key echoed and cascades environments", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);

    const wrong = await request(`/v1/admin/projects/${project.id}`, del({ confirm: "wrong" }));
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error.code).toBe("confirm_mismatch");

    const ok = await request(`/v1/admin/projects/${project.id}`, del({ confirm: "acme" }));
    expect(ok.status).toBe(204);
    expect((await request(`/v1/admin/projects/${project.id}`)).status).toBe(404);
    expect((await request(`/v1/admin/environments/${environment.id}`)).status).toBe(404);
  });
});

describe("environments", () => {
  test("create generates a client key server-side", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);
    expect(environment.clientKey).toMatch(/^pk_[0-9A-Za-z]{32}$/);
  });

  test("duplicate keys within a project are 409, across projects fine", async () => {
    const { request } = createTestApp();
    const a = await createProject(request, "a");
    const b = await createProject(request, "b");
    await createEnvironment(request, a.id);
    const dup = await request(`/v1/admin/projects/${a.id}/environments`, post({ key: "prod" }));
    expect(dup.status).toBe(409);
    await createEnvironment(request, b.id);
  });

  test("creating under an unknown project is 404", async () => {
    const { request } = createTestApp();
    const res = await request("/v1/admin/projects/missing/environments", post({ key: "prod" }));
    expect(res.status).toBe(404);
  });

  test("detail reports latest version and dirty flag", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);

    const clean = await (await request(`/v1/admin/environments/${environment.id}`)).json();
    expect(clean.latestVersion).toBe(0);
    expect(clean.draftDirty).toBe(false);

    await createParameter(request, environment.id);
    const dirty = await (await request(`/v1/admin/environments/${environment.id}`)).json();
    expect(dirty.draftDirty).toBe(true);
  });

  test("rotate-key returns a fresh key", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);
    const rotated = await (
      await request(`/v1/admin/environments/${environment.id}/rotate-key`, { method: "POST" })
    ).json();
    expect(rotated.clientKey).toMatch(/^pk_[0-9A-Za-z]{32}$/);
    expect(rotated.clientKey).not.toBe(environment.clientKey);
  });

  test("delete requires the key echoed", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);
    const wrong = await request(`/v1/admin/environments/${environment.id}`, del({ confirm: "no" }));
    expect(wrong.status).toBe(400);
    const ok = await request(`/v1/admin/environments/${environment.id}`, del({ confirm: "prod" }));
    expect(ok.status).toBe(204);
    expect((await request(`/v1/admin/environments/${environment.id}`)).status).toBe(404);
  });
});

describe("conditions", () => {
  test("create, list, update", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);
    const condition = await createCondition(request, environment.id);

    const list = await (
      await request(`/v1/admin/environments/${environment.id}/conditions`)
    ).json();
    expect(list).toHaveLength(1);

    const updated = await (
      await request(
        `/v1/admin/conditions/${condition.id}`,
        patch({ clauses: [{ kind: "appVersion", op: "gte", value: "5.2.0" }] }),
      )
    ).json();
    expect(updated.clauses[0].kind).toBe("appVersion");
    expect(updated.name).toBe("android");
  });

  test("clause validation rejects operator/value mismatches and empty clause lists", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);
    const path = `/v1/admin/environments/${environment.id}/conditions`;

    const badPair = await request(
      path,
      post({ name: "bad", clauses: [{ kind: "platform", op: "eq", value: ["android"] }] }),
    );
    expect(badPair.status).toBe(400);

    const badSemver = await request(
      path,
      post({ name: "bad", clauses: [{ kind: "appVersion", op: "gte", value: "5.2" }] }),
    );
    expect(badSemver.status).toBe(400);

    const empty = await request(path, post({ name: "bad", clauses: [] }));
    expect(empty.status).toBe(400);
  });

  test("duplicate names within an environment are 409", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);
    await createCondition(request, environment.id);
    const res = await request(
      `/v1/admin/environments/${environment.id}/conditions`,
      post({ name: "android", clauses: [platformClause] }),
    );
    expect(res.status).toBe(409);
  });

  test("delete is refused while referenced, allowed once unreferenced", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);
    const condition = await createCondition(request, environment.id);
    const parameter = await createParameter(request, environment.id);
    await request(
      `/v1/admin/parameters/${parameter.id}/conditional-values`,
      put([{ conditionId: condition.id, value: true }]),
    );

    const refused = await request(`/v1/admin/conditions/${condition.id}`, del());
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("condition_in_use");

    await request(`/v1/admin/parameters/${parameter.id}/conditional-values`, put([]));
    const allowed = await request(`/v1/admin/conditions/${condition.id}`, del());
    expect(allowed.status).toBe(204);
  });
});

describe("parameters", () => {
  test("create validates the default against the declared type", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);

    const mismatch = await request(
      `/v1/admin/environments/${environment.id}/parameters`,
      post({ key: "flag", type: "boolean", defaultValue: "yes" }),
    );
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error.code).toBe("type_mismatch");

    const parameter = await createParameter(request, environment.id);
    expect(parameter.conditionalValues).toEqual([]);
  });

  test("key charset is enforced and duplicates are 409", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);
    const path = `/v1/admin/environments/${environment.id}/parameters`;

    const badKey = await request(path, post({ key: "no-dash", type: "string", defaultValue: "" }));
    expect(badKey.status).toBe(400);

    await createParameter(request, environment.id);
    const dup = await request(
      path,
      post({ key: "enable_thing", type: "boolean", defaultValue: true }),
    );
    expect(dup.status).toBe(409);
  });

  test("description is patchable and nullable", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);
    const parameter = await createParameter(request, environment.id);

    const set = await (
      await request(`/v1/admin/parameters/${parameter.id}`, patch({ description: "gates things" }))
    ).json();
    expect(set.description).toBe("gates things");

    const cleared = await (
      await request(`/v1/admin/parameters/${parameter.id}`, patch({ description: null }))
    ).json();
    expect(cleared.description).toBeNull();
  });

  test("a type change revalidates every value in one transaction or rejects", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);
    const condition = await createCondition(request, environment.id);
    const parameter = await createParameter(request, environment.id);
    await request(
      `/v1/admin/parameters/${parameter.id}/conditional-values`,
      put([{ conditionId: condition.id, value: true }]),
    );

    // The boolean conditional value blocks the change even with a new default.
    const refused = await request(
      `/v1/admin/parameters/${parameter.id}`,
      patch({ type: "string", defaultValue: "hello" }),
    );
    expect(refused.status).toBe(400);

    // The rejection rolled everything back.
    const unchanged = await (await request(`/v1/admin/parameters/${parameter.id}`)).json();
    expect(unchanged.type).toBe("boolean");
    expect(unchanged.defaultValue).toBe(false);

    await request(`/v1/admin/parameters/${parameter.id}/conditional-values`, put([]));
    const accepted = await request(
      `/v1/admin/parameters/${parameter.id}`,
      patch({ type: "string", defaultValue: "hello" }),
    );
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).type).toBe("string");
  });

  test("delete removes the parameter", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);
    const parameter = await createParameter(request, environment.id);
    expect((await request(`/v1/admin/parameters/${parameter.id}`, del())).status).toBe(204);
    expect((await request(`/v1/admin/parameters/${parameter.id}`)).status).toBe(404);
  });
});

describe("conditional values", () => {
  test("PUT replaces the whole list with deterministic positions", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);
    const android = await createCondition(request, environment.id, "android");
    const ios = await createCondition(request, environment.id, "ios", [
      { kind: "platform", op: "eq", value: "ios" },
    ]);
    const parameter = await createParameter(request, environment.id);
    const path = `/v1/admin/parameters/${parameter.id}/conditional-values`;

    const first = await (
      await request(
        path,
        put([
          { conditionId: android.id, value: true },
          { conditionId: ios.id, value: false },
        ]),
      )
    ).json();
    expect(first.map((cv: { conditionId: string }) => cv.conditionId)).toEqual([
      android.id,
      ios.id,
    ]);
    expect(first.map((cv: { position: number }) => cv.position)).toEqual([0, 1]);

    const reordered = await (
      await request(
        path,
        put([
          { conditionId: ios.id, value: false },
          { conditionId: android.id, value: true },
        ]),
      )
    ).json();
    expect(reordered.map((cv: { conditionId: string }) => cv.conditionId)).toEqual([
      ios.id,
      android.id,
    ]);
    expect(reordered.map((cv: { position: number }) => cv.position)).toEqual([0, 1]);
  });

  test("conditions from another environment are rejected (§3.2 invariant)", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const prod = await createEnvironment(request, project.id, "prod");
    const staging = await createEnvironment(request, project.id, "staging");
    const foreign = await createCondition(request, staging.id);
    const parameter = await createParameter(request, prod.id);

    const res = await request(
      `/v1/admin/parameters/${parameter.id}/conditional-values`,
      put([{ conditionId: foreign.id, value: true }]),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_condition");
  });

  test("unknown conditions, duplicates, and type mismatches are rejected", async () => {
    const { request } = createTestApp();
    const project = await createProject(request);
    const environment = await createEnvironment(request, project.id);
    const condition = await createCondition(request, environment.id);
    const parameter = await createParameter(request, environment.id);
    const path = `/v1/admin/parameters/${parameter.id}/conditional-values`;

    expect((await request(path, put([{ conditionId: "missing", value: true }]))).status).toBe(400);
    expect(
      (
        await request(
          path,
          put([
            { conditionId: condition.id, value: true },
            { conditionId: condition.id, value: false },
          ]),
        )
      ).status,
    ).toBe(400);
    const mismatch = await request(path, put([{ conditionId: condition.id, value: "nope" }]));
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error.code).toBe("type_mismatch");
  });
});
