import type { Database } from "bun:sqlite";
import type { ConditionRepo } from "../db/condition-repo";
import type { EnvironmentRepo } from "../db/environment-repo";
import type { ParameterRepo } from "../db/parameter-repo";
import type { Version, VersionRepo } from "../db/version-repo";
import { withImmediateTransaction } from "../db";
import { isBusyError, isConstraintError, LeverError, notFound } from "../error";
import { canonicalize } from "./canonicalize";
import { buildDraftSnapshot } from "./draft";
import { getLogger } from "../logger";
import type { ResolveCache } from "./resolve-cache";
import {
  buildSnapshot,
  diffSnapshots,
  parseSnapshot,
  snapshotSchema,
  type Clause,
  type Snapshot,
  type SnapshotDiff,
} from "./snapshot";

export interface PublishPreview {
  draftDirty: boolean;
  diff: SnapshotDiff;
}

export interface PublishedVersion {
  version: number;
  author: string;
  publishedAt: number;
  rollbackOf: number | null;
  diff: SnapshotDiff;
}

export interface VersionSummary {
  version: number;
  author: string;
  publishedAt: number;
  rollbackOf: number | null;
  diff: { added: number; removed: number; changed: number };
}

export interface VersionDetail {
  version: number;
  author: string;
  publishedAt: number;
  rollbackOf: number | null;
  snapshot: Snapshot;
  diff: SnapshotDiff;
}

export interface PublishService {
  /** The publish preview (§8.3): the would-be diff against the latest version. */
  preview(environmentId: string): PublishPreview;
  publish(
    environmentId: string,
    input: { author: string; expectedVersion?: number | undefined },
  ): PublishedVersion;
  /** Republishes version `n` as `N+1` after rewriting the draft to match it (§8.4). */
  rollback(environmentId: string, version: number, author: string): PublishedVersion;
  listVersions(environmentId: string): VersionSummary[];
  getVersion(environmentId: string, version: number): VersionDetail;
}

interface PublishRepos {
  environments: EnvironmentRepo;
  parameters: ParameterRepo;
  conditions: ConditionRepo;
  versions: VersionRepo;
}

export function createPublishService(
  db: Database,
  repos: PublishRepos,
  resolveCache: ResolveCache,
): PublishService {
  const ensureEnvironment = (environmentId: string): void => {
    if (repos.environments.getById(environmentId) === undefined) throw notFound("environment");
  };

  const emptySnapshotBytes = canonicalize(buildSnapshot([]));

  const diffAgainst = (previous: Version | undefined, snapshot: Snapshot): SnapshotDiff =>
    diffSnapshots(previous === undefined ? undefined : parseSnapshot(previous.snapshot), snapshot);

  /**
   * The §8.4 draft rewrite: a key-matched upsert, not a wipe. Parameters keep
   * their row ids and descriptions; snapshot conditions upsert by name;
   * parameters absent from the snapshot are deleted; conditions the snapshot
   * never references are left untouched. Conditional values are replaced
   * wholesale — no condition rows are deleted, keeping clear of the RESTRICT
   * FK. Runs inside the rollback transaction.
   */
  const rewriteDraft = (environmentId: string, snapshot: Snapshot): void => {
    const conditionIdByName = new Map(
      repos.conditions
        .listByEnvironment(environmentId)
        .map((condition) => [condition.name, condition] as const),
    );
    const wantedClauses = new Map<string, Clause[]>();
    for (const parameter of Object.values(snapshot.parameters)) {
      for (const cv of parameter.conditionalValues) {
        if (!wantedClauses.has(cv.condition.name)) {
          wantedClauses.set(cv.condition.name, cv.condition.clauses);
        }
      }
    }
    const conditionIds = new Map<string, string>();
    for (const [name, clauses] of wantedClauses) {
      const existing = conditionIdByName.get(name);
      if (existing === undefined) {
        conditionIds.set(name, repos.conditions.create({ environmentId, name, clauses }).id);
      } else {
        if (canonicalize(existing.clauses) !== canonicalize(clauses)) {
          repos.conditions.update(existing.id, { clauses });
        }
        conditionIds.set(name, existing.id);
      }
    }

    const existingParameters = repos.parameters.listByEnvironment(environmentId);
    const parameterByKey = new Map(existingParameters.map((p) => [p.key, p] as const));
    for (const [key, snapshotParameter] of Object.entries(snapshot.parameters)) {
      const existing = parameterByKey.get(key);
      const parameterId =
        existing?.id ??
        repos.parameters.create({
          environmentId,
          key,
          type: snapshotParameter.type,
          defaultValue: snapshotParameter.defaultValue,
        }).id;
      if (existing !== undefined) {
        repos.parameters.update(existing.id, {
          type: snapshotParameter.type,
          defaultValue: snapshotParameter.defaultValue,
        });
      }
      repos.parameters.replaceConditionalValues(
        parameterId,
        snapshotParameter.conditionalValues.map((cv) => {
          const conditionId = conditionIds.get(cv.condition.name);
          if (conditionId === undefined) {
            throw new Error(`rollback: condition "${cv.condition.name}" was not upserted`);
          }
          return { conditionId, value: cv.value };
        }),
      );
    }
    for (const parameter of existingParameters) {
      if (snapshot.parameters[parameter.key] === undefined) {
        repos.parameters.remove(parameter.id);
      }
    }
  };

  const afterCommit = (environmentId: string, inserted: Version, snapshot: Snapshot): void => {
    // §8.3 ordering: swap the resolve-cache entry, then broadcast the SSE
    // nudge. The nudge broadcast joins this seam in Phase 5.
    resolveCache.published(environmentId, inserted.version, snapshot);
    getLogger()
      .withMetadata({ environmentId, version: inserted.version, author: inserted.author })
      .info("published");
  };

  const toPublished = (inserted: Version, diff: SnapshotDiff): PublishedVersion => ({
    version: inserted.version,
    author: inserted.author,
    publishedAt: inserted.publishedAt,
    rollbackOf: inserted.rollbackOf,
    diff,
  });

  return {
    preview(environmentId) {
      ensureEnvironment(environmentId);
      const latest = repos.versions.latest(environmentId);
      const snapshot = buildDraftSnapshot(repos, environmentId);
      const draftBytes = canonicalize(snapshot);
      return {
        draftDirty: draftBytes !== (latest?.snapshot ?? emptySnapshotBytes),
        diff: diffAgainst(latest, snapshot),
      };
    },

    publish(environmentId, { author, expectedVersion }) {
      ensureEnvironment(environmentId);
      try {
        const { inserted, previous, snapshot } = withImmediateTransaction(db, () => {
          const latest = repos.versions.latest(environmentId);
          const latestNumber = latest?.version ?? 0;
          if (expectedVersion !== undefined && expectedVersion !== latestNumber) {
            throw new LeverError(
              409,
              "publish_conflict",
              `expected version ${expectedVersion} but latest is ${latestNumber}`,
            );
          }
          // Validated at publish time so evaluation may assume well-formed
          // snapshots (§4).
          const built = snapshotSchema.parse(buildDraftSnapshot(repos, environmentId));
          const bytes = canonicalize(built);
          if (bytes === (latest?.snapshot ?? emptySnapshotBytes)) {
            throw new LeverError(409, "nothing_to_publish", "draft matches the published config");
          }
          const row = repos.versions.insert({
            environmentId,
            version: latestNumber + 1,
            snapshot: bytes,
            author,
          });
          return { inserted: row, previous: latest, snapshot: built };
        });
        afterCommit(environmentId, inserted, snapshot);
        return toPublished(inserted, diffAgainst(previous, snapshot));
      } catch (error) {
        if (isBusyError(error) || isConstraintError(error)) {
          throw new LeverError(409, "publish_conflict", "another publish is in progress", {
            cause: error,
          });
        }
        throw error;
      }
    },

    rollback(environmentId, version, author) {
      ensureEnvironment(environmentId);
      const target = repos.versions.get(environmentId, version);
      if (target === undefined) throw notFound("version");
      const snapshot = parseSnapshot(target.snapshot);
      try {
        const { inserted, previous } = withImmediateTransaction(db, () => {
          rewriteDraft(environmentId, snapshot);
          const rebuilt = canonicalize(buildDraftSnapshot(repos, environmentId));
          if (rebuilt !== target.snapshot) {
            // Publishing bytes the draft does not reproduce would desync the
            // §8.4 invariant that rollback leaves draft === published.
            throw new Error(`rollback: rewritten draft diverged from version ${version}`);
          }
          const latest = repos.versions.latest(environmentId);
          // No nothing_to_publish check (§8.4): rolling back to the live
          // version is the "reset a diverged draft" move, and the duplicate
          // snapshot is itself audit-worthy.
          const row = repos.versions.insert({
            environmentId,
            version: (latest?.version ?? 0) + 1,
            snapshot: target.snapshot,
            author,
            rollbackOf: version,
          });
          return { inserted: row, previous: latest };
        });
        afterCommit(environmentId, inserted, snapshot);
        return toPublished(inserted, diffAgainst(previous, snapshot));
      } catch (error) {
        if (isBusyError(error) || isConstraintError(error)) {
          throw new LeverError(409, "publish_conflict", "another publish is in progress", {
            cause: error,
          });
        }
        throw error;
      }
    },

    listVersions(environmentId) {
      ensureEnvironment(environmentId);
      const versions = repos.versions.list(environmentId);
      // Descending list; each diff is against its predecessor, derived on read (§3.4).
      return versions.map((entry, index) => {
        const predecessor = versions[index + 1];
        const diff = diffAgainst(predecessor, parseSnapshot(entry.snapshot));
        return {
          version: entry.version,
          author: entry.author,
          publishedAt: entry.publishedAt,
          rollbackOf: entry.rollbackOf,
          diff: {
            added: diff.added.length,
            removed: diff.removed.length,
            changed: diff.changed.length,
          },
        };
      });
    },

    getVersion(environmentId, version) {
      ensureEnvironment(environmentId);
      const entry = repos.versions.get(environmentId, version);
      if (entry === undefined) throw notFound("version");
      const snapshot = parseSnapshot(entry.snapshot);
      const predecessor = version > 1 ? repos.versions.get(environmentId, version - 1) : undefined;
      return {
        version: entry.version,
        author: entry.author,
        publishedAt: entry.publishedAt,
        rollbackOf: entry.rollbackOf,
        snapshot,
        diff: diffAgainst(predecessor, snapshot),
      };
    },
  };
}
