import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { buildEnv } from "../env";
import { createTestApp, type TestApp, type TestRequestInit, dataOf } from "../test-support";

type Request = TestApp["request"];

const post = (body?: unknown): TestRequestInit =>
  body === undefined ? { method: "POST" } : { method: "POST", body };
const patch = (body: unknown): TestRequestInit => ({ method: "PATCH", body });
const put = (body: unknown): TestRequestInit => ({ method: "PUT", body });

/**
 * A published environment: `enable_thing` (boolean, default false, true on
 * android ≥ 5.2.0) and `greeting` (string, "hello", "olá" when attr.locale=pt).
 */
async function seed(request: Request) {
  const project = await dataOf(
    await request("/v1/admin/projects", post({ key: "acme", name: "Acme" })),
  );
  const environment = await dataOf(
    await request(`/v1/admin/projects/${project.id}/environments`, post({ key: "prod" })),
  );
  const android = await dataOf(
    await request(
      `/v1/admin/environments/${environment.id}/conditions`,
      post({
        name: "android-5.2+",
        clauses: [
          { kind: "platform", op: "eq", value: "android" },
          { kind: "appVersion", op: "gte", value: "5.2.0" },
        ],
      }),
    ),
  );
  const portuguese = await dataOf(
    await request(
      `/v1/admin/environments/${environment.id}/conditions`,
      post({
        name: "pt",
        clauses: [{ kind: "attribute", attribute: "locale", op: "eq", value: "pt" }],
      }),
    ),
  );
  const enableThing = await dataOf(
    await request(
      `/v1/admin/environments/${environment.id}/parameters`,
      post({ key: "enable_thing", type: "boolean", defaultValue: false }),
    ),
  );
  await request(
    `/v1/admin/parameters/${enableThing.id}/conditional-values`,
    put([{ conditionId: android.id, value: true }]),
  );
  const greeting = await dataOf(
    await request(
      `/v1/admin/environments/${environment.id}/parameters`,
      post({ key: "greeting", type: "string", defaultValue: "hello" }),
    ),
  );
  await request(
    `/v1/admin/parameters/${greeting.id}/conditional-values`,
    put([{ conditionId: portuguese.id, value: "olá" }]),
  );
  const published = await request(`/v1/admin/environments/${environment.id}/publish`, post());
  expect(published.status).toBe(201);
  return { project, environment, enableThing };
}

const resolve = (request: Request, key: string, query = "") =>
  request(`/v1/resolve?key=${key}${query}`, { token: null });

describe("resolve", () => {
  test("empty context resolves defaults, matching context resolves conditional values", async () => {
    const { request } = createTestApp();
    const { environment } = await seed(request);

    const defaults = await resolve(request, environment.clientKey);
    expect(defaults.status).toBe(200);
    const body = await dataOf(defaults);
    expect(body.version).toBe(1);
    expect(body.values.enable_thing).toEqual({ type: "boolean", value: false });
    expect(body.values.greeting).toEqual({ type: "string", value: "hello" });

    const matched = await dataOf(
      await resolve(request, environment.clientKey, "&platform=Android&appVersion=5.3.1"),
    );
    expect(matched.values.enable_thing).toEqual({ type: "boolean", value: true });

    // AND of clauses: right platform but version below the floor.
    const below = await dataOf(
      await resolve(request, environment.clientKey, "&platform=android&appVersion=5.1.0"),
    );
    expect(below.values.enable_thing.value).toBe(false);

    // Invalid semver in context never matches a version clause (§4).
    const invalid = await dataOf(
      await resolve(request, environment.clientKey, "&platform=android&appVersion=5.2"),
    );
    expect(invalid.values.enable_thing.value).toBe(false);

    const attribute = await dataOf(
      await resolve(request, environment.clientKey, "&attr.locale=pt"),
    );
    expect(attribute.values.greeting.value).toBe("olá");
  });

  test("authorizes via Bearer or ?key and rejects unknown keys", async () => {
    const { request } = createTestApp();
    const { environment } = await seed(request);

    const viaBearer = await request("/v1/resolve", { token: environment.clientKey });
    expect(viaBearer.status).toBe(200);

    const missing = await request("/v1/resolve", { token: null });
    expect(missing.status).toBe(401);
    expect((await missing.json()).error.code).toBe("invalid_key");

    expect((await resolve(request, "pk_bogus")).status).toBe(401);
  });

  test("a never-published environment resolves version 0, not 401 (§6.3)", async () => {
    const { request } = createTestApp();
    const { project } = await seed(request);
    const fresh = await dataOf(
      await request(`/v1/admin/projects/${project.id}/environments`, post({ key: "staging" })),
    );
    const res = await resolve(request, fresh.clientKey);
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual({ version: 0, values: {} });
  });

  test("ETag is a strong validator: 304 on match, new ETag after publish", async () => {
    const { request } = createTestApp();
    const { environment, enableThing } = await seed(request);

    const first = await resolve(request, environment.clientKey);
    const etag = first.headers.get("ETag");
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");

    const revalidated = await request(`/v1/resolve?key=${environment.clientKey}`, {
      token: null,
      headers: { "If-None-Match": etag ?? "" },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("ETag")).toBe(etag);
    expect(await revalidated.text()).toBe("");

    // A different context is a different body, hence a different ETag.
    const other = await resolve(
      request,
      environment.clientKey,
      "&platform=android&appVersion=6.0.0",
    );
    expect(other.headers.get("ETag")).not.toBe(etag);

    // A publish always changes the ETag — the version is in the body.
    await request(`/v1/admin/parameters/${enableThing.id}`, patch({ defaultValue: true }));
    await request(`/v1/admin/environments/${environment.id}/publish`, post());
    const republished = await request(`/v1/resolve?key=${environment.clientKey}`, {
      token: null,
      headers: { "If-None-Match": etag ?? "" },
    });
    expect(republished.status).toBe(200);
    expect(republished.headers.get("ETag")).not.toBe(etag);
    expect((await dataOf(republished)).version).toBe(2);
  });

  test("draft edits stay invisible until the next publish (§8.2)", async () => {
    const { request } = createTestApp();
    const { environment, enableThing } = await seed(request);

    await request(`/v1/admin/parameters/${enableThing.id}`, patch({ defaultValue: true }));
    const stale = await dataOf(await resolve(request, environment.clientKey));
    expect(stale.values.enable_thing.value).toBe(false);

    await request(`/v1/admin/environments/${environment.id}/publish`, post());
    const fresh = await dataOf(await resolve(request, environment.clientKey));
    expect(fresh.values.enable_thing.value).toBe(true);
  });

  test("input limits reject oversized contexts with 400 (§6.2)", async () => {
    const { request } = createTestApp();
    const { environment } = await seed(request);
    const key = environment.clientKey;

    const tooMany = Array.from({ length: 21 }, (_, i) => `attr.a${i}=x`).join("&");
    expect((await resolve(request, key, `&${tooMany}`)).status).toBe(400);

    expect((await resolve(request, key, `&attr.big=${"v".repeat(257)}`)).status).toBe(400);
    expect((await resolve(request, key, `&attr.${"n".repeat(65)}=x`)).status).toBe(400);
    expect((await resolve(request, key, `&platform=${"p".repeat(65)}`)).status).toBe(400);

    // Unrecognized unprefixed parameters are ignored, not rejected.
    expect((await resolve(request, key, "&locale=pt&whatever=1")).status).toBe(200);
  });

  test("key rotation and environment deletion revoke resolution immediately", async () => {
    const { request } = createTestApp();
    const { environment } = await seed(request);

    const rotated = await dataOf(
      await request(`/v1/admin/environments/${environment.id}/rotate-key`, post()),
    );
    expect((await resolve(request, environment.clientKey)).status).toBe(401);
    expect((await resolve(request, rotated.clientKey)).status).toBe(200);

    await request(`/v1/admin/environments/${environment.id}`, {
      method: "DELETE",
      body: { confirm: "prod" },
    });
    expect((await resolve(request, rotated.clientKey)).status).toBe(401);
  });

  // §5.3: two allowlists, because they are two trust tiers.
  test("the read surface answers any origin and exposes the ETag", async () => {
    const { app, request } = createTestApp();
    const { environment } = await seed(request);

    const res = await app.request(`/v1/resolve?key=${environment.clientKey}`, {
      headers: { Origin: "https://app.example" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // Without this browsers hide the ETag and the 304 path degrades to refetches.
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("the admin surface answers only its configured origin", async () => {
    const { request } = createTestApp();

    const allowed = await request("/v1/admin/projects", {
      headers: { Origin: "https://portal.lever.test" },
    });
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://portal.lever.test");
    // The session is a bearer token, never a cookie — nothing for a browser to
    // attach implicitly, so credentials mode is never enabled (§8.1.4).
    expect(allowed.headers.get("Access-Control-Allow-Credentials")).toBeNull();

    const hostile = await request("/v1/admin/projects", {
      headers: { Origin: "https://evil.example" },
    });
    expect(hostile.headers.get("Access-Control-Allow-Origin")).not.toBe("https://evil.example");
  });

  test("an admin preflight from the portal advertises the mutating methods", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/admin/projects", {
      method: "OPTIONS",
      headers: {
        Origin: "https://portal.lever.test",
        "Access-Control-Request-Method": "DELETE",
        "Access-Control-Request-Headers": "Authorization",
      },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://portal.lever.test");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  test("a fresh process serves resolve from the warmed cache (§6.4)", async () => {
    const { request, env } = createTestApp();
    const { environment, project } = await seed(request);
    const neverPublished = await dataOf(
      await request(`/v1/admin/projects/${project.id}/environments`, post({ key: "staging" })),
    );

    // Same database, new registry — simulates a restart.
    const restarted = buildEnv(env.vars, env.sqlite);
    await restarted.resolveCache.warmUp(restarted.repos);
    const app = createApp(restarted);

    const res = await app.request(
      `/v1/resolve?key=${environment.clientKey}&platform=android&appVersion=6.0.0`,
    );
    expect(res.status).toBe(200);
    const body = await dataOf(res);
    expect(body.version).toBe(1);
    expect(body.values.enable_thing.value).toBe(true);

    // The §6.4 explicit version-0 entry: a valid key for a never-published
    // environment resolves, it does not fall through to 401.
    const empty = await app.request(`/v1/resolve?key=${neverPublished.clientKey}`);
    expect(empty.status).toBe(200);
    expect(await dataOf(empty)).toEqual({ version: 0, values: {} });
  });
});
