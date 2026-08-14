import { beforeEach, describe, expect, test } from "bun:test";
import { buildEnv, type Env } from "../env";
import { openDb, runMigrations, withTransaction } from "./index";

function testEnv(): Env {
  const sqlite = openDb(":memory:");
  runMigrations(sqlite);
  return buildEnv(
    {
      NODE_ENV: "development",
      PORT: 3000,
      DATABASE_PATH: ":memory:",
      LEVER_ADMIN_TOKENS: [{ name: "test", secret: "a".repeat(32) }],
      LEVER_ALLOWED_ORIGINS: "*",
      SSE_HEARTBEAT_MS: 25_000,
      SSE_MAX_SUBSCRIBERS: 2_000,
      LOG_LEVEL: "error",
    },
    sqlite,
  );
}

let env: Env;
beforeEach(() => {
  env = testEnv();
});

describe("project repo", () => {
  test("create, get, list, rename, remove round-trip", async () => {
    const created = await env.repos.projects.create({ key: "unes", name: "UNES" });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await env.repos.projects.getById(created.id)).toEqual(created);
    expect(await env.repos.projects.getByKey("unes")).toEqual(created);
    expect((await env.repos.projects.list()).map((p) => p.key)).toEqual(["unes"]);

    const renamed = await env.repos.projects.rename(created.id, "UNES App");
    expect(renamed?.name).toBe("UNES App");

    expect(await env.repos.projects.remove(created.id)).toBe(true);
    expect(await env.repos.projects.remove(created.id)).toBe(false);
    expect(await env.repos.projects.getById(created.id)).toBeUndefined();
  });

  test("project keys are unique", async () => {
    await env.repos.projects.create({ key: "unes", name: "one" });
    expect(env.repos.projects.create({ key: "unes", name: "two" })).rejects.toThrow();
  });
});

describe("environment repo", () => {
  test("create generates a pk_ client key and scopes keys per project", async () => {
    const project = await env.repos.projects.create({ key: "unes", name: "UNES" });
    const prod = await env.repos.environments.create({ projectId: project.id, key: "prod" });
    expect(prod.clientKey).toMatch(/^pk_[0-9A-Za-z]{32}$/);

    expect(env.repos.environments.create({ projectId: project.id, key: "prod" })).rejects.toThrow();

    const other = await env.repos.projects.create({ key: "other", name: "Other" });
    const otherProd = await env.repos.environments.create({ projectId: other.id, key: "prod" });
    expect(otherProd.id).not.toBe(prod.id);
  });

  test("lookup by client key drives resolve auth", async () => {
    const project = await env.repos.projects.create({ key: "unes", name: "UNES" });
    const prod = await env.repos.environments.create({ projectId: project.id, key: "prod" });
    expect(await env.repos.environments.getByClientKey(prod.clientKey)).toEqual(prod);
    expect(await env.repos.environments.getByClientKey("pk_unknown")).toBeUndefined();
  });

  test("rotateClientKey invalidates the old key immediately", async () => {
    const project = await env.repos.projects.create({ key: "unes", name: "UNES" });
    const prod = await env.repos.environments.create({ projectId: project.id, key: "prod" });
    const rotated = await env.repos.environments.rotateClientKey(prod.id);
    expect(rotated?.clientKey).toMatch(/^pk_[0-9A-Za-z]{32}$/);
    expect(rotated?.clientKey).not.toBe(prod.clientKey);
    expect(await env.repos.environments.getByClientKey(prod.clientKey)).toBeUndefined();
  });

  test("deleting a project cascades its environments and everything below", async () => {
    const project = await env.repos.projects.create({ key: "unes", name: "UNES" });
    const prod = await env.repos.environments.create({ projectId: project.id, key: "prod" });
    await env.repos.parameters.create({
      environmentId: prod.id,
      key: "gate",
      type: "boolean",
      defaultValue: false,
    });
    await env.repos.versions.insert({
      environmentId: prod.id,
      version: 1,
      snapshot: '{"format":1,"parameters":{}}',
      author: "test",
    });

    await env.repos.projects.remove(project.id);
    expect(await env.repos.environments.getById(prod.id)).toBeUndefined();
    expect(await env.repos.parameters.listByEnvironment(prod.id)).toEqual([]);
    expect(await env.repos.versions.list(prod.id)).toEqual([]);
  });
});

describe("condition repo", () => {
  test("clauses round-trip typed and validated", async () => {
    const project = await env.repos.projects.create({ key: "unes", name: "UNES" });
    const prod = await env.repos.environments.create({ projectId: project.id, key: "prod" });
    const condition = await env.repos.conditions.create({
      environmentId: prod.id,
      name: "android-5.2+",
      clauses: [
        { kind: "platform", op: "eq", value: "android" },
        { kind: "appVersion", op: "gte", value: "5.2.0" },
      ],
    });
    expect(await env.repos.conditions.getById(condition.id)).toEqual(condition);

    const updated = await env.repos.conditions.update(condition.id, {
      clauses: [{ kind: "platform", op: "eq", value: "ios" }],
    });
    expect(updated?.name).toBe("android-5.2+");
    expect(updated?.clauses).toEqual([{ kind: "platform", op: "eq", value: "ios" }]);
  });

  test("condition names are unique per environment", async () => {
    const project = await env.repos.projects.create({ key: "unes", name: "UNES" });
    const prod = await env.repos.environments.create({ projectId: project.id, key: "prod" });
    const clauses = [{ kind: "platform", op: "eq", value: "android" } as const];
    await env.repos.conditions.create({ environmentId: prod.id, name: "android", clauses });
    expect(
      env.repos.conditions.create({ environmentId: prod.id, name: "android", clauses }),
    ).rejects.toThrow();
  });

  test("deleting a referenced condition is RESTRICTed until the reference goes", async () => {
    const project = await env.repos.projects.create({ key: "unes", name: "UNES" });
    const prod = await env.repos.environments.create({ projectId: project.id, key: "prod" });
    const condition = await env.repos.conditions.create({
      environmentId: prod.id,
      name: "android",
      clauses: [{ kind: "platform", op: "eq", value: "android" }],
    });
    const parameter = await env.repos.parameters.create({
      environmentId: prod.id,
      key: "gate",
      type: "boolean",
      defaultValue: false,
    });
    await env.repos.parameters.replaceConditionalValues(parameter.id, [
      { conditionId: condition.id, value: true },
    ]);

    expect(env.repos.conditions.remove(condition.id)).rejects.toThrow();

    await env.repos.parameters.replaceConditionalValues(parameter.id, []);
    expect(await env.repos.conditions.remove(condition.id)).toBe(true);
  });
});

describe("parameter repo", () => {
  test("parameters round-trip with typed values and optional description", async () => {
    const project = await env.repos.projects.create({ key: "unes", name: "UNES" });
    const prod = await env.repos.environments.create({ projectId: project.id, key: "prod" });
    const parameter = await env.repos.parameters.create({
      environmentId: prod.id,
      key: "menu_layout",
      type: "json",
      defaultValue: { rows: [1, 2], compact: null },
      description: "home screen layout",
    });
    expect(await env.repos.parameters.getById(parameter.id)).toEqual(parameter);

    const updated = await env.repos.parameters.update(parameter.id, { defaultValue: null });
    expect(updated?.defaultValue).toBeNull();
    expect(updated?.description).toBe("home screen layout");

    const cleared = await env.repos.parameters.update(parameter.id, { description: null });
    expect(cleared?.description).toBeNull();
  });

  test("parameter keys are unique per environment", async () => {
    const project = await env.repos.projects.create({ key: "unes", name: "UNES" });
    const prod = await env.repos.environments.create({ projectId: project.id, key: "prod" });
    await env.repos.parameters.create({
      environmentId: prod.id,
      key: "gate",
      type: "boolean",
      defaultValue: false,
    });
    expect(
      env.repos.parameters.create({
        environmentId: prod.id,
        key: "gate",
        type: "string",
        defaultValue: "x",
      }),
    ).rejects.toThrow();
  });

  test("replaceConditionalValues assigns positions from list order and replaces wholesale", async () => {
    const project = await env.repos.projects.create({ key: "unes", name: "UNES" });
    const prod = await env.repos.environments.create({ projectId: project.id, key: "prod" });
    const android = await env.repos.conditions.create({
      environmentId: prod.id,
      name: "android",
      clauses: [{ kind: "platform", op: "eq", value: "android" }],
    });
    const ios = await env.repos.conditions.create({
      environmentId: prod.id,
      name: "ios",
      clauses: [{ kind: "platform", op: "eq", value: "ios" }],
    });
    const parameter = await env.repos.parameters.create({
      environmentId: prod.id,
      key: "banner",
      type: "string",
      defaultValue: "default",
    });

    const first = await env.repos.parameters.replaceConditionalValues(parameter.id, [
      { conditionId: android.id, value: "a" },
      { conditionId: ios.id, value: "i" },
    ]);
    expect(first.map((cv) => [cv.conditionId, cv.position])).toEqual([
      [android.id, 0],
      [ios.id, 1],
    ]);

    const reordered = await env.repos.parameters.replaceConditionalValues(parameter.id, [
      { conditionId: ios.id, value: "i" },
      { conditionId: android.id, value: "a" },
    ]);
    expect(reordered.map((cv) => [cv.conditionId, cv.position])).toEqual([
      [ios.id, 0],
      [android.id, 1],
    ]);
  });

  test("a failed replace inside a transaction rolls back to the previous list", async () => {
    const project = await env.repos.projects.create({ key: "unes", name: "UNES" });
    const prod = await env.repos.environments.create({ projectId: project.id, key: "prod" });
    const android = await env.repos.conditions.create({
      environmentId: prod.id,
      name: "android",
      clauses: [{ kind: "platform", op: "eq", value: "android" }],
    });
    const parameter = await env.repos.parameters.create({
      environmentId: prod.id,
      key: "banner",
      type: "string",
      defaultValue: "default",
    });
    await env.repos.parameters.replaceConditionalValues(parameter.id, [
      { conditionId: android.id, value: "a" },
    ]);

    // The repo method is delete-then-insert and not atomic on its own — the
    // caller's transaction is what rolls the delete back (the UNIQUE
    // parameter/condition pair makes the insert fail here).
    expect(
      withTransaction(env.db, (repos) =>
        repos.parameters.replaceConditionalValues(parameter.id, [
          { conditionId: android.id, value: "a" },
          { conditionId: android.id, value: "b" },
        ]),
      ),
    ).rejects.toThrow();
    expect(
      (await env.repos.parameters.listConditionalValues(parameter.id)).map((cv) => cv.value),
    ).toEqual(["a"]);
  });
});

describe("version repo", () => {
  test("insert, latest, get, list — append-only by construction", async () => {
    const project = await env.repos.projects.create({ key: "unes", name: "UNES" });
    const prod = await env.repos.environments.create({ projectId: project.id, key: "prod" });

    expect(await env.repos.versions.latestNumber(prod.id)).toBe(0);
    expect(await env.repos.versions.latest(prod.id)).toBeUndefined();

    const v1 = await env.repos.versions.insert({
      environmentId: prod.id,
      version: 1,
      snapshot: '{"format":1,"parameters":{}}',
      author: "joao",
    });
    const v2 = await env.repos.versions.insert({
      environmentId: prod.id,
      version: 2,
      snapshot: '{"format":1,"parameters":{}}',
      author: "joao",
      rollbackOf: 1,
    });

    expect(await env.repos.versions.latestNumber(prod.id)).toBe(2);
    expect(await env.repos.versions.latest(prod.id)).toEqual(v2);
    expect(await env.repos.versions.get(prod.id, 1)).toEqual(v1);
    expect((await env.repos.versions.list(prod.id)).map((v) => v.version)).toEqual([2, 1]);
    expect(v2.rollbackOf).toBe(1);
  });

  test("the versions primary key rejects a duplicate version number", async () => {
    const project = await env.repos.projects.create({ key: "unes", name: "UNES" });
    const prod = await env.repos.environments.create({ projectId: project.id, key: "prod" });
    const input = {
      environmentId: prod.id,
      version: 1,
      snapshot: '{"format":1,"parameters":{}}',
      author: "joao",
    };
    await env.repos.versions.insert(input);
    expect(env.repos.versions.insert(input)).rejects.toThrow();
  });

  test("rollback_of must reference an existing version of the same environment", async () => {
    const project = await env.repos.projects.create({ key: "unes", name: "UNES" });
    const prod = await env.repos.environments.create({ projectId: project.id, key: "prod" });
    expect(
      env.repos.versions.insert({
        environmentId: prod.id,
        version: 1,
        snapshot: '{"format":1,"parameters":{}}',
        author: "joao",
        rollbackOf: 99,
      }),
    ).rejects.toThrow();
  });
});
