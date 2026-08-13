import type { Database } from "bun:sqlite";

/**
 * `snapshot` is the canonical JSON bytes exactly as published (§3.3) — kept as
 * a string end to end so byte equality (ETag, no-op publish, immutability
 * tests) never depends on a parse/re-serialize round trip.
 */
export interface Version {
  environmentId: string;
  version: number;
  snapshot: string;
  author: string;
  publishedAt: number;
  rollbackOf: number | null;
}

/**
 * Versions are append-only (§8.3): this interface deliberately exposes no
 * update or delete — immutability by construction.
 */
export interface VersionRepo {
  insert(input: {
    environmentId: string;
    version: number;
    snapshot: string;
    author: string;
    rollbackOf?: number | undefined;
  }): Version;
  get(environmentId: string, version: number): Version | undefined;
  latest(environmentId: string): Version | undefined;
  /** 0 when nothing is published — the §6.3 "version": 0 case. */
  latestNumber(environmentId: string): number;
  /** Descending, newest first (§8.5). */
  list(environmentId: string): Version[];
}

interface VersionRow {
  environment_id: string;
  version: number;
  snapshot: string;
  author: string;
  published_at: number;
  rollback_of: number | null;
}

function toVersion(row: VersionRow): Version {
  return {
    environmentId: row.environment_id,
    version: row.version,
    snapshot: row.snapshot,
    author: row.author,
    publishedAt: row.published_at,
    rollbackOf: row.rollback_of,
  };
}

export function createVersionRepo(db: Database): VersionRepo {
  return {
    insert({ environmentId, version, snapshot, author, rollbackOf }) {
      const row: Version = {
        environmentId,
        version,
        snapshot,
        author,
        publishedAt: Date.now(),
        rollbackOf: rollbackOf ?? null,
      };
      db.query<undefined, [string, number, string, string, number, number | null]>(
        `INSERT INTO versions (environment_id, version, snapshot, author, published_at, rollback_of)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        row.environmentId,
        row.version,
        row.snapshot,
        row.author,
        row.publishedAt,
        row.rollbackOf,
      );
      return row;
    },
    get(environmentId, version) {
      const row = db
        .query<VersionRow, [string, number]>(
          "SELECT * FROM versions WHERE environment_id = ? AND version = ?",
        )
        .get(environmentId, version);
      return row === null ? undefined : toVersion(row);
    },
    latest(environmentId) {
      const row = db
        .query<VersionRow, [string]>(
          "SELECT * FROM versions WHERE environment_id = ? ORDER BY version DESC LIMIT 1",
        )
        .get(environmentId);
      return row === null ? undefined : toVersion(row);
    },
    latestNumber(environmentId) {
      const row = db
        .query<{ latest: number | null }, [string]>(
          "SELECT MAX(version) AS latest FROM versions WHERE environment_id = ?",
        )
        .get(environmentId);
      return row?.latest ?? 0;
    },
    list(environmentId) {
      return db
        .query<VersionRow, [string]>(
          "SELECT * FROM versions WHERE environment_id = ? ORDER BY version DESC",
        )
        .all(environmentId)
        .map(toVersion);
    },
  };
}
