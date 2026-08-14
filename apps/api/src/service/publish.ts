import { withTransaction, type Db, type Repos } from "../db";
import type { Version } from "../db/version-repo";
import { isBusyError, isConstraintError, LeverError, notFound } from "../error";
import { getLogger } from "../logger";
import { canonicalize } from "./canonicalize";
import { buildDraftSnapshot } from "./draft";
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
  preview(environmentId: string): Promise<PublishPreview>;
  publish(
    environmentId: string,
    input: { author: string; expectedVersion?: number | undefined },
  ): Promise<PublishedVersion>;
  /** Republishes version `n` as `N+1` after rewriting the draft to match it (§8.4). */
  rollback(environmentId: string, version: number, author: string): Promise<PublishedVersion>;
  listVersions(environmentId: string): Promise<VersionSummary[]>;
  getVersion(environmentId: string, version: number): Promise<VersionDetail>;
}

export function createPublishService(
  db: Db,
  repos: Repos,
  resolveCache: ResolveCache,
): PublishService {
  const ensureEnvironment = async (environmentId: string): Promise<void> => {
    if ((await repos.environments.getById(environmentId)) === undefined) {
      throw notFound("environment");
    }
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
   * FK. Runs inside the rollback transaction with its repos.
   */
  const rewriteDraft = async (
    txRepos: Repos,
    environmentId: string,
    snapshot: Snapshot,
  ): Promise<void> => {
    const conditionByName = new Map(
      (await txRepos.conditions.listByEnvironment(environmentId)).map(
        (condition) => [condition.name, condition] as const,
      ),
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
      const existing = conditionByName.get(name);
      if (existing === undefined) {
        conditionIds.set(
          name,
          (await txRepos.conditions.create({ environmentId, name, clauses })).id,
        );
      } else {
        if (canonicalize(existing.clauses) !== canonicalize(clauses)) {
          await txRepos.conditions.update(existing.id, { clauses });
        }
        conditionIds.set(name, existing.id);
      }
    }

    const existingParameters = await txRepos.parameters.listByEnvironment(environmentId);
    const parameterByKey = new Map(existingParameters.map((p) => [p.key, p] as const));
    for (const [key, snapshotParameter] of Object.entries(snapshot.parameters)) {
      const existing = parameterByKey.get(key);
      let parameterId: string;
      if (existing === undefined) {
        parameterId = (
          await txRepos.parameters.create({
            environmentId,
            key,
            type: snapshotParameter.type,
            defaultValue: snapshotParameter.defaultValue,
          })
        ).id;
      } else {
        parameterId = existing.id;
        await txRepos.parameters.update(existing.id, {
          type: snapshotParameter.type,
          defaultValue: snapshotParameter.defaultValue,
        });
      }
      await txRepos.parameters.replaceConditionalValues(
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
        await txRepos.parameters.remove(parameter.id);
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

  const asPublishConflict = (error: unknown): never => {
    if (isBusyError(error) || isConstraintError(error)) {
      throw new LeverError(409, "publish_conflict", "another publish is in progress", {
        cause: error,
      });
    }
    throw error;
  };

  return {
    async preview(environmentId) {
      await ensureEnvironment(environmentId);
      const latest = await repos.versions.latest(environmentId);
      const snapshot = await buildDraftSnapshot(repos, environmentId);
      const draftBytes = canonicalize(snapshot);
      return {
        draftDirty: draftBytes !== (latest?.snapshot ?? emptySnapshotBytes),
        diff: diffAgainst(latest, snapshot),
      };
    },

    async publish(environmentId, { author, expectedVersion }) {
      await ensureEnvironment(environmentId);
      const { inserted, previous, snapshot } = await withTransaction(db, async (txRepos) => {
        const latest = await txRepos.versions.latest(environmentId);
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
        const built = snapshotSchema.parse(await buildDraftSnapshot(txRepos, environmentId));
        const bytes = canonicalize(built);
        if (bytes === (latest?.snapshot ?? emptySnapshotBytes)) {
          throw new LeverError(409, "nothing_to_publish", "draft matches the published config");
        }
        const row = await txRepos.versions.insert({
          environmentId,
          version: latestNumber + 1,
          snapshot: bytes,
          author,
        });
        return { inserted: row, previous: latest, snapshot: built };
      }).catch(asPublishConflict);
      afterCommit(environmentId, inserted, snapshot);
      return toPublished(inserted, diffAgainst(previous, snapshot));
    },

    async rollback(environmentId, version, author) {
      await ensureEnvironment(environmentId);
      const target = await repos.versions.get(environmentId, version);
      if (target === undefined) throw notFound("version");
      const snapshot = parseSnapshot(target.snapshot);
      const { inserted, previous } = await withTransaction(db, async (txRepos) => {
        await rewriteDraft(txRepos, environmentId, snapshot);
        const rebuilt = canonicalize(await buildDraftSnapshot(txRepos, environmentId));
        if (rebuilt !== target.snapshot) {
          // Publishing bytes the draft does not reproduce would desync the
          // §8.4 invariant that rollback leaves draft === published.
          throw new Error(`rollback: rewritten draft diverged from version ${version}`);
        }
        const latest = await txRepos.versions.latest(environmentId);
        // No nothing_to_publish check (§8.4): rolling back to the live
        // version is the "reset a diverged draft" move, and the duplicate
        // snapshot is itself audit-worthy.
        const row = await txRepos.versions.insert({
          environmentId,
          version: (latest?.version ?? 0) + 1,
          snapshot: target.snapshot,
          author,
          rollbackOf: version,
        });
        return { inserted: row, previous: latest };
      }).catch(asPublishConflict);
      afterCommit(environmentId, inserted, snapshot);
      return toPublished(inserted, diffAgainst(previous, snapshot));
    },

    async listVersions(environmentId) {
      await ensureEnvironment(environmentId);
      const versions = await repos.versions.list(environmentId);
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

    async getVersion(environmentId, version) {
      await ensureEnvironment(environmentId);
      const entry = await repos.versions.get(environmentId, version);
      if (entry === undefined) throw notFound("version");
      const snapshot = parseSnapshot(entry.snapshot);
      const predecessor =
        version > 1 ? await repos.versions.get(environmentId, version - 1) : undefined;
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
