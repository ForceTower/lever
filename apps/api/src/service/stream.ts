/**
 * The SSE subscriber registry (spec 0001 §7). The stream carries version
 * numbers only, never values — a nudge triggers the SDK's normal
 * fetch-and-activate. Writes never await one subscriber before dispatching to
 * the next, and any failed write drops that subscriber: a failed write IS the
 * disconnect signal, so the registry cannot accumulate zombies.
 */
import { getLogger } from "../logger";

export interface Subscriber {
  /** Non-blocking; returns false when the stream is backpressured beyond hope. */
  write(frame: string): boolean;
  close(): void;
}

export interface Subscription {
  /** Guarded write — a failure drops and closes this subscriber. */
  emit(frame: string): void;
  unsubscribe(): void;
}

export interface StreamRegistry {
  /** Returns undefined at the §7 subscriber cap — the route answers 503. */
  subscribe(environmentId: string, subscriber: Subscriber): Subscription | undefined;
  /** The §7 nudge: version number only. */
  broadcast(environmentId: string, version: number): void;
  /** Environment delete and key rotation close every subscriber (§7). */
  closeEnvironment(environmentId: string): void;
  count(environmentId?: string): number;
}

export function versionFrame(version: number): string {
  return `event: version\ndata: {"version":${version}}\n\n`;
}

/**
 * Register-then-emit, in this order (§7): registering first means a publish
 * landing mid-connect reaches this subscriber as a duplicate nudge (absorbed
 * by the SDK's version dedupe) instead of a lost update. `currentVersion` is
 * read only after registration.
 */
export function connectSubscriber(
  registry: StreamRegistry,
  environmentId: string,
  subscriber: Subscriber,
  currentVersion: () => number,
): Subscription | undefined {
  const subscription = registry.subscribe(environmentId, subscriber);
  if (subscription === undefined) return undefined;
  // retry hint for EventSource clients; native SDKs keep their own backoff.
  subscription.emit(`retry: 15000\n${versionFrame(currentVersion())}`);
  return subscription;
}

export function createStreamRegistry(options: {
  heartbeatMs: number;
  maxSubscribers: number;
}): StreamRegistry {
  const byEnvironment = new Map<string, Set<Subscriber>>();
  let total = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const drop = (environmentId: string, subscriber: Subscriber): void => {
    const set = byEnvironment.get(environmentId);
    if (set === undefined || !set.delete(subscriber)) return;
    total -= 1;
    if (set.size === 0) byEnvironment.delete(environmentId);
    // The interval only runs while someone is connected.
    if (total === 0 && heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    subscriber.close();
    getLogger().withMetadata({ environmentId, subscribers: set.size }).info("stream disconnected");
  };

  const send = (environmentId: string, subscriber: Subscriber, frame: string): void => {
    try {
      if (!subscriber.write(frame)) drop(environmentId, subscriber);
    } catch {
      drop(environmentId, subscriber);
    }
  };

  const heartbeatAll = (): void => {
    for (const [environmentId, set] of byEnvironment) {
      for (const subscriber of [...set]) send(environmentId, subscriber, ": hb\n\n");
    }
  };

  return {
    subscribe(environmentId, subscriber) {
      if (total >= options.maxSubscribers) return undefined;
      let set = byEnvironment.get(environmentId);
      if (set === undefined) {
        set = new Set();
        byEnvironment.set(environmentId, set);
      }
      set.add(subscriber);
      total += 1;
      heartbeat ??= setInterval(heartbeatAll, options.heartbeatMs);
      getLogger().withMetadata({ environmentId, subscribers: set.size }).info("stream connected");
      return {
        emit: (frame) => send(environmentId, subscriber, frame),
        unsubscribe: () => drop(environmentId, subscriber),
      };
    },
    broadcast(environmentId, version) {
      const set = byEnvironment.get(environmentId);
      if (set === undefined) return;
      const frame = versionFrame(version);
      for (const subscriber of [...set]) send(environmentId, subscriber, frame);
    },
    closeEnvironment(environmentId) {
      const set = byEnvironment.get(environmentId);
      if (set === undefined) return;
      for (const subscriber of [...set]) drop(environmentId, subscriber);
    },
    count(environmentId) {
      if (environmentId === undefined) return total;
      return byEnvironment.get(environmentId)?.size ?? 0;
    },
  };
}
