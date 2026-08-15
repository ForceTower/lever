import { describe, expect, test } from "bun:test";
import { connectSubscriber, createStreamRegistry, type Subscriber } from "../service/stream";
import { createTestApp, type TestApp, type TestRequestInit, dataOf } from "../test-support";

type Request = TestApp["request"];

const post = (body?: unknown): TestRequestInit =>
  body === undefined ? { method: "POST" } : { method: "POST", body };

async function seed(request: Request) {
  const project = await dataOf(
    await request("/v1/admin/projects", post({ key: "acme", name: "Acme" })),
  );
  const environment = await dataOf(
    await request(`/v1/admin/projects/${project.id}/environments`, post({ key: "prod" })),
  );
  await request(
    `/v1/admin/environments/${environment.id}/parameters`,
    post({ key: "gate", type: "boolean", defaultValue: false }),
  );
  const published = await request(`/v1/admin/environments/${environment.id}/publish`, post());
  expect(published.status).toBe(201);
  return { project, environment };
}

const connect = (request: Request, key: string) =>
  request(`/v1/stream?key=${key}`, { token: null });

/** Reads SSE frames (separated by a blank line) until `count` or `timeoutMs`. */
async function readFrames(
  body: ReadableStream<Uint8Array>,
  count: number,
  timeoutMs = 1000,
): Promise<string[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (frames.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(remaining).then(() => "timeout" as const),
      ]);
      if (next === "timeout" || next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        frames.push(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
  return frames;
}

describe("stream", () => {
  test("connect emits the current version with a retry hint; version 0 when unpublished", async () => {
    const { request } = createTestApp();
    const { environment, project } = await seed(request);

    const res = await connect(request, environment.clientKey);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    const [first] = await readFrames(res.body ?? new ReadableStream(), 1);
    expect(first).toContain("retry: 15000");
    expect(first).toContain("event: version");
    expect(first).toContain('{"version":1}');
    await res.body?.cancel();

    const fresh = await dataOf(
      await request(`/v1/admin/projects/${project.id}/environments`, post({ key: "staging" })),
    );
    const unpublished = await connect(request, fresh.clientKey);
    const [frame] = await readFrames(unpublished.body ?? new ReadableStream(), 1);
    expect(frame).toContain('{"version":0}');
    await unpublished.body?.cancel();
  });

  test("publish and rollback broadcast nudges with the new version", async () => {
    const { request, env } = createTestApp();
    const { environment } = await seed(request);

    const res = await connect(request, environment.clientKey);
    const body = res.body ?? new ReadableStream();
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 1000;
      while (!received.includes(needle) && Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          Bun.sleep(50).then(() => "timeout" as const),
        ]);
        if (next !== "timeout" && !next.done) received += decoder.decode(next.value);
      }
      expect(received).toContain(needle);
    };

    await readUntil('{"version":1}');
    await request(
      `/v1/admin/parameters/${(await dataOf(await request(`/v1/admin/environments/${environment.id}/parameters`)))[0].id}`,
      { method: "PATCH", body: { defaultValue: true } },
    );
    await request(`/v1/admin/environments/${environment.id}/publish`, post());
    await readUntil('{"version":2}');

    await request(`/v1/admin/environments/${environment.id}/versions/1/rollback`, post());
    await readUntil('{"version":3}');

    expect(env.streams.count(environment.id)).toBe(1);
    await reader.cancel();
  });

  test("disconnect removes the subscriber — the registry is observably empty", async () => {
    const { request, env } = createTestApp();
    const { environment } = await seed(request);

    const res = await connect(request, environment.clientKey);
    await readFrames(res.body ?? new ReadableStream(), 1);
    expect(env.streams.count()).toBe(1);

    await res.body?.cancel();
    await Bun.sleep(10);
    expect(env.streams.count()).toBe(0);
  });

  test("key rotation and environment deletion close the stream (§7)", async () => {
    const { request, env } = createTestApp();
    const { environment } = await seed(request);

    const res = await connect(request, environment.clientKey);
    await readFrames(res.body ?? new ReadableStream(), 1);
    expect(env.streams.count(environment.id)).toBe(1);

    await request(`/v1/admin/environments/${environment.id}/rotate-key`, post());
    await Bun.sleep(10);
    expect(env.streams.count(environment.id)).toBe(0);

    const rotated = await dataOf(await request(`/v1/admin/environments/${environment.id}`));
    const second = await connect(request, rotated.clientKey);
    await readFrames(second.body ?? new ReadableStream(), 1);
    expect(env.streams.count(environment.id)).toBe(1);

    await request(`/v1/admin/environments/${environment.id}`, {
      method: "DELETE",
      body: { confirm: "prod" },
    });
    await Bun.sleep(10);
    expect(env.streams.count()).toBe(0);
  });

  test("past the subscriber cap connect answers 503 with Retry-After (§7)", async () => {
    const { request } = createTestApp({ vars: { SSE_MAX_SUBSCRIBERS: "1" } });
    const { environment } = await seed(request);

    const first = await connect(request, environment.clientKey);
    expect(first.status).toBe(200);
    await readFrames(first.body ?? new ReadableStream(), 1);

    const second = await connect(request, environment.clientKey);
    expect(second.status).toBe(503);
    expect(second.headers.get("Retry-After")).toBe("30");

    await first.body?.cancel();
  });

  test("heartbeat comment frames keep the stream warm", async () => {
    const { request } = createTestApp({ vars: { SSE_HEARTBEAT_MS: "20" } });
    const { environment } = await seed(request);

    const res = await connect(request, environment.clientKey);
    const frames = await readFrames(res.body ?? new ReadableStream(), 3, 500);
    expect(frames.some((frame) => frame.startsWith(": hb"))).toBe(true);
    await res.body?.cancel();
  });

  test("a publish between registration and the connect emission is not lost (§7 ordering)", async () => {
    const registry = createStreamRegistry({ heartbeatMs: 60_000, maxSubscribers: 10 });
    const received: string[] = [];
    const subscriber: Subscriber = {
      write(frame) {
        received.push(frame);
        return true;
      },
      close() {},
    };

    // currentVersion() simulates a publish landing inside the connect gap:
    // the broadcast fires before the connect emission is written. Because
    // registration happened first, the subscriber gets the nudge (worst case
    // a duplicate, absorbed by SDK dedupe) — never a lost update.
    const subscription = connectSubscriber(registry, "env-x", subscriber, () => {
      registry.broadcast("env-x", 2);
      return 1;
    });
    expect(subscription).toBeDefined();
    expect(received[0]).toContain('{"version":2}');
    expect(received[1]).toContain('{"version":1}');
    subscription?.unsubscribe();
    expect(registry.count()).toBe(0);
  });

  test("a failed or throwing write drops the subscriber", async () => {
    const registry = createStreamRegistry({ heartbeatMs: 60_000, maxSubscribers: 10 });
    let closed = 0;
    const backpressured: Subscriber = {
      write: () => false,
      close: () => {
        closed += 1;
      },
    };
    const throwing: Subscriber = {
      write: () => {
        throw new Error("socket gone");
      },
      close: () => {
        closed += 1;
      },
    };
    registry.subscribe("env-x", backpressured);
    registry.subscribe("env-x", throwing);
    expect(registry.count("env-x")).toBe(2);

    registry.broadcast("env-x", 5);
    expect(registry.count("env-x")).toBe(0);
    expect(closed).toBe(2);
  });
});
