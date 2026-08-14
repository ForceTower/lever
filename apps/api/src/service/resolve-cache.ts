/**
 * The in-process resolve cache (spec 0001 §6.4): two maps warmed at boot — an
 * auth index `clientKey → environmentId` and `environmentId → CompiledEnv`.
 * Resolve performs zero I/O: two map lookups → pure evaluation →
 * serialization. Every admin mutation that touches resolution notifies the
 * cache through exactly one code path, and the cache owns the coupled stream
 * effects (§8.3 ordering: swap the entry, then nudge; a deleted environment
 * or rotated key closes its streams).
 */
import type { Repos } from "../db";
import type { Environment } from "../db/environment-repo";
import { getLogger } from "../logger";
import { parseSemver, type Semver } from "./semver";
import { parseSnapshot, type Snapshot } from "./snapshot";
import type { StreamRegistry } from "./stream";

export interface CompiledEnv {
  environmentId: string;
  /** 0 for a never-published environment — a valid key always resolves (§6.3). */
  version: number;
  snapshot: Snapshot | undefined;
  /** Clause operands pre-parsed at compile time (§6.4). */
  semverOperands: ReadonlyMap<string, Semver>;
}

export interface ResolveCache {
  /** Boot-time scan of environments and their latest versions (§6.4). */
  warmUp(repos: Repos): Promise<void>;
  /** The resolve/stream auth + lookup path — two map reads, no I/O. */
  getByClientKey(clientKey: string): CompiledEnv | undefined;
  /** The stream connect emission re-reads the entry after registering (§7). */
  getByEnvironmentId(environmentId: string): CompiledEnv | undefined;
  environmentCreated(environment: Environment): void;
  environmentDeleted(environment: Environment): void;
  clientKeyRotated(previous: Environment, rotated: Environment): void;
  /** Publish and rollback swap the compiled entry after commit, then nudge. */
  published(environmentId: string, version: number, snapshot: Snapshot): void;
}

function compile(environmentId: string, version: number, snapshot: Snapshot): CompiledEnv {
  const semverOperands = new Map<string, Semver>();
  for (const parameter of Object.values(snapshot.parameters)) {
    for (const conditionalValue of parameter.conditionalValues) {
      for (const clause of conditionalValue.condition.clauses) {
        if (clause.kind === "appVersion" && !semverOperands.has(clause.value)) {
          const parsed = parseSemver(clause.value);
          if (parsed !== undefined) semverOperands.set(clause.value, parsed);
        }
      }
    }
  }
  return { environmentId, version, snapshot, semverOperands };
}

function emptyEntry(environmentId: string): CompiledEnv {
  return { environmentId, version: 0, snapshot: undefined, semverOperands: new Map() };
}

export function createResolveCache(streams: StreamRegistry): ResolveCache {
  const authIndex = new Map<string, string>();
  const compiled = new Map<string, CompiledEnv>();

  return {
    async warmUp(repos) {
      for (const environment of await repos.environments.listAll()) {
        authIndex.set(environment.clientKey, environment.id);
        const latest = await repos.versions.latest(environment.id);
        compiled.set(
          environment.id,
          latest === undefined
            ? emptyEntry(environment.id)
            : compile(environment.id, latest.version, parseSnapshot(latest.snapshot)),
        );
      }
      getLogger().withMetadata({ environments: compiled.size }).info("resolve cache warmed");
    },
    getByClientKey(clientKey) {
      const environmentId = authIndex.get(clientKey);
      return environmentId === undefined ? undefined : compiled.get(environmentId);
    },
    getByEnvironmentId(environmentId) {
      return compiled.get(environmentId);
    },
    environmentCreated(environment) {
      authIndex.set(environment.clientKey, environment.id);
      compiled.set(environment.id, emptyEntry(environment.id));
    },
    environmentDeleted(environment) {
      authIndex.delete(environment.clientKey);
      compiled.delete(environment.id);
      // A revoked key must not hold a live stream (§7).
      streams.closeEnvironment(environment.id);
    },
    clientKeyRotated(previous, rotated) {
      // Re-keyed atomically: the old key 401s the moment this returns (§6.4).
      authIndex.delete(previous.clientKey);
      authIndex.set(rotated.clientKey, rotated.id);
      streams.closeEnvironment(rotated.id);
    },
    published(environmentId, version, snapshot) {
      // §8.3 ordering: swap the compiled entry, then broadcast the nudge.
      compiled.set(environmentId, compile(environmentId, version, snapshot));
      streams.broadcast(environmentId, version);
    },
  };
}
