import type { Db } from "./kysely";
import type { VersionsTable } from "./schema";

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
  /** Best-effort join back to a live account; `author` is the durable record (§3.2). */
  authorAccountId: string | null;
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
    authorAccountId?: string | undefined;
    rollbackOf?: number | undefined;
  }): Promise<Version>;
  get(environmentId: string, version: number): Promise<Version | undefined>;
  latest(environmentId: string): Promise<Version | undefined>;
  /** 0 when nothing is published — the §6.3 "version": 0 case. */
  latestNumber(environmentId: string): Promise<number>;
  /** Descending, newest first (§8.5). */
  list(environmentId: string): Promise<Version[]>;
}

function toVersion(row: VersionsTable): Version {
  return {
    environmentId: row.environment_id,
    version: row.version,
    snapshot: row.snapshot,
    author: row.author,
    authorAccountId: row.author_account_id,
    publishedAt: row.published_at,
    rollbackOf: row.rollback_of,
  };
}

export function createVersionRepo(db: Db): VersionRepo {
  return {
    async insert({ environmentId, version, snapshot, author, authorAccountId, rollbackOf }) {
      const row: Version = {
        environmentId,
        version,
        snapshot,
        author,
        authorAccountId: authorAccountId ?? null,
        publishedAt: Date.now(),
        rollbackOf: rollbackOf ?? null,
      };
      await db
        .insertInto("versions")
        .values({
          environment_id: row.environmentId,
          version: row.version,
          snapshot: row.snapshot,
          author: row.author,
          author_account_id: row.authorAccountId,
          published_at: row.publishedAt,
          rollback_of: row.rollbackOf,
        })
        .execute();
      return row;
    },
    async get(environmentId, version) {
      const row = await db
        .selectFrom("versions")
        .selectAll()
        .where("environment_id", "=", environmentId)
        .where("version", "=", version)
        .executeTakeFirst();
      return row === undefined ? undefined : toVersion(row);
    },
    async latest(environmentId) {
      const row = await db
        .selectFrom("versions")
        .selectAll()
        .where("environment_id", "=", environmentId)
        .orderBy("version", "desc")
        .limit(1)
        .executeTakeFirst();
      return row === undefined ? undefined : toVersion(row);
    },
    async latestNumber(environmentId) {
      const row = await db
        .selectFrom("versions")
        .select((eb) => eb.fn.max("version").as("latest"))
        .where("environment_id", "=", environmentId)
        .executeTakeFirst();
      return row?.latest ?? 0;
    },
    async list(environmentId) {
      const rows = await db
        .selectFrom("versions")
        .selectAll()
        .where("environment_id", "=", environmentId)
        .orderBy("version", "desc")
        .execute();
      return rows.map(toVersion);
    },
  };
}
