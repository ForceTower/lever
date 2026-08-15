/**
 * §5.1 envelope coverage: exactly four members on every JSON response, and the
 * two deliberate exemptions — 304s and SSE frames, which are not response
 * bodies.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createTestApp, dataOf } from "../test-support";

const ENVELOPE_KEYS = ["data", "error", "message", "ok"];

const envelopeSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  data: z.unknown(),
  error: z.object({ code: z.string(), details: z.unknown().optional() }).nullable(),
});

/** Parsed, not asserted — the shape is what these tests are checking. */
async function envelopeOf(response: Response) {
  return envelopeSchema.parse(await response.json());
}

describe("the response envelope (§5.1)", () => {
  test("a success body has exactly the four members", async () => {
    const { request } = createTestApp();
    const body = await envelopeOf(await request("/healthz", { token: null }));
    expect(Object.keys(body).sort()).toEqual(ENVELOPE_KEYS);
    expect(body.ok).toBe(true);
    expect(body.error).toBeNull();
    expect(typeof body.message).toBe("string");
  });

  test("a failure body has the same four members, with data null", async () => {
    const { request } = createTestApp();
    const body = await envelopeOf(await request("/v1/nope", { token: null }));
    expect(Object.keys(body).sort()).toEqual(ENVELOPE_KEYS);
    expect(body.ok).toBe(false);
    expect(body.data).toBeNull();
    expect(body.error?.code).toBe("not_found");
  });

  test("`ok` mirrors the status across the admin and read surfaces", async () => {
    const { request } = createTestApp();
    const project = await request("/v1/admin/projects", {
      method: "POST",
      body: { key: "acme", name: "Acme" },
    });
    expect(project.status).toBe(201);
    expect((await envelopeOf(project)).ok).toBe(true);

    const denied = await request("/v1/admin/projects", { token: "not-a-token" });
    expect(denied.status).toBe(401);
    expect((await envelopeOf(denied)).ok).toBe(false);
  });

  test("validation failures carry a code and treeified details", async () => {
    const { request } = createTestApp();
    const body = await envelopeOf(
      await request("/v1/admin/projects", { method: "POST", body: { key: "Not A Slug" } }),
    );
    expect(body.error?.code).toBe("validation_failed");
    expect(body.error?.details).toBeDefined();
  });

  test("resolve nests the payload under data", async () => {
    const { request } = createTestApp();
    const project = await dataOf(
      await request("/v1/admin/projects", { method: "POST", body: { key: "acme", name: "Acme" } }),
    );
    const environment = await dataOf(
      await request(`/v1/admin/projects/${project.id}/environments`, {
        method: "POST",
        body: { key: "prod" },
      }),
    );

    const res = await request(`/v1/resolve?key=${environment.clientKey}`, { token: null });
    const body = await envelopeOf(res);
    expect(Object.keys(body).sort()).toEqual(ENVELOPE_KEYS);
    expect(body.data).toEqual({ version: 0, values: {} });
  });

  // The validator is a function of resolved config alone (§6.4), so the
  // human-facing message can never invalidate a client's cache.
  test("the resolve ETag covers the payload, not the envelope", async () => {
    const { request } = createTestApp();
    const project = await dataOf(
      await request("/v1/admin/projects", { method: "POST", body: { key: "acme", name: "Acme" } }),
    );
    const environment = await dataOf(
      await request(`/v1/admin/projects/${project.id}/environments`, {
        method: "POST",
        body: { key: "prod" },
      }),
    );

    const res = await request(`/v1/resolve?key=${environment.clientKey}`, { token: null });
    const etag = res.headers.get("ETag");
    expect(etag).toBeString();

    const payload = JSON.stringify((await envelopeOf(res)).data);
    const digest = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
    expect(etag).toBe(`"${digest.slice(0, 16)}"`);
  });

  test("a 304 carries no body at all", async () => {
    const { request } = createTestApp();
    const project = await dataOf(
      await request("/v1/admin/projects", { method: "POST", body: { key: "acme", name: "Acme" } }),
    );
    const environment = await dataOf(
      await request(`/v1/admin/projects/${project.id}/environments`, {
        method: "POST",
        body: { key: "prod" },
      }),
    );

    const first = await request(`/v1/resolve?key=${environment.clientKey}`, { token: null });
    const etag = first.headers.get("ETag") ?? "";
    const revalidated = await request(`/v1/resolve?key=${environment.clientKey}`, {
      token: null,
      headers: { "If-None-Match": etag },
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
  });

  // Wrapping a nudge would put a message string on the hot push path and force
  // every SDK to unwrap a frame whose entire content is one integer.
  test("SSE frames are event data, not envelopes", async () => {
    const { request } = createTestApp();
    const project = await dataOf(
      await request("/v1/admin/projects", { method: "POST", body: { key: "acme", name: "Acme" } }),
    );
    const environment = await dataOf(
      await request(`/v1/admin/projects/${project.id}/environments`, {
        method: "POST",
        body: { key: "prod" },
      }),
    );

    const res = await request(`/v1/stream?key=${environment.clientKey}`, { token: null });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    const chunk = new TextDecoder().decode((await reader?.read())?.value);
    expect(chunk).toContain("event: version");
    expect(chunk).toContain(`data: {"version":0}`);
    expect(chunk).not.toContain('"ok"');
    await reader?.cancel();
  });
});
