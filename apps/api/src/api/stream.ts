/**
 * GET /v1/stream — SSE nudges (spec 0001 §7). Version numbers only, never
 * values. Register-then-emit ordering lives in `connectSubscriber`; the
 * subscriber here wraps a ReadableStream controller, so writes are
 * non-blocking enqueues and a hopelessly backpressured stream reports failure
 * instead of stalling anyone else.
 */
import { connectSubscriber, type Subscriber } from "../service/stream";
import { createHono, failure } from "./index";
import { clientKeyAuth } from "./middleware";

const encoder = new TextEncoder();
// Frames a reader has not drained before we consider the socket dead. Bun
// normally drains into the OS buffer immediately, so hitting this means the
// connection has effectively stopped consuming.
const MAX_QUEUED_FRAMES = 256;

function controllerSubscriber(controller: ReadableStreamDefaultController<Uint8Array>): Subscriber {
  return {
    write(frame) {
      if ((controller.desiredSize ?? 0) <= -MAX_QUEUED_FRAMES) return false;
      controller.enqueue(encoder.encode(frame));
      return true;
    },
    close() {
      try {
        controller.close();
      } catch {
        // Already closed by the other side — nothing to do.
      }
    },
  };
}

export const streamRoutes = createHono();

streamRoutes.get("/", clientKeyAuth(), (c) => {
  const compiled = c.get("compiledEnv");
  const { streams: registry, resolveCache: cache } = c.env;

  let unsubscribe: (() => void) | undefined;
  let atCapacity = false;
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        // Register first, then emit the current version (§7): a publish
        // landing mid-connect becomes a duplicate nudge, never a lost one.
        // The version is re-read from the cache at emit time — the entry
        // captured at auth is stale if a publish landed since.
        const subscription = connectSubscriber(
          registry,
          compiled.environmentId,
          controllerSubscriber(controller),
          () => cache.getByEnvironmentId(compiled.environmentId)?.version ?? 0,
        );
        if (subscription === undefined) {
          atCapacity = true;
          controller.close();
          return;
        }
        unsubscribe = () => subscription.unsubscribe();
      },
      cancel() {
        unsubscribe?.();
      },
    },
    { highWaterMark: MAX_QUEUED_FRAMES },
  );

  if (atCapacity) {
    // §7: past SSE_MAX_SUBSCRIBERS the SDK's min-interval polling carries
    // the load — the poll-fallback blast-radius cap, made concrete. Refusing
    // a connection is an ordinary JSON response, so it carries the envelope;
    // the event frames below never do (§5.1).
    const response = failure(503, "at_capacity", "stream subscriber limit reached");
    response.headers.set("Retry-After", "30");
    return response;
  }
  return c.body(body, 200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
});
