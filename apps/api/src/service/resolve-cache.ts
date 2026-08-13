import type { Environment } from "../db/environment-repo";
import type { Snapshot } from "./snapshot";

/**
 * The in-process resolve cache seam (spec 0001 §6.4): every admin mutation
 * that affects resolution notifies it through exactly one code path, so the
 * real implementation (Phase 5) can keep its two maps — `clientKey →
 * environmentId` and `environmentId → CompiledEnv` — current without a second
 * bookkeeping site. Until then the admin services run against the no-op
 * implementation; resolve does not exist yet, so there is nothing to keep
 * warm.
 */
export interface ResolveCache {
  environmentCreated(environment: Environment): void;
  /** Also the hook that closes the environment's SSE streams (§7, Phase 5). */
  environmentDeleted(environment: Environment): void;
  /** Re-keys the auth index atomically — the old key 401s immediately (§6.4). */
  clientKeyRotated(previous: Environment, rotated: Environment): void;
  /** Publish and rollback swap the compiled entry after commit (Phase 4/5). */
  published(environmentId: string, version: number, snapshot: Snapshot): void;
}

export function createNoopResolveCache(): ResolveCache {
  return {
    environmentCreated() {},
    environmentDeleted() {},
    clientKeyRotated() {},
    published() {},
  };
}
