import type { Db } from "./kysely";
import type { AdminSessionsTable } from "./schema";

export interface AdminSession {
  id: string;
  accountId: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * §8.1.4 sessions. The row *is* the revocation record: the bearer token is a
 * signed JWT whose `jti` is this row's id, so a token stays verifiable but
 * stops being accepted the moment its row is revoked, expires, or disappears.
 * No token material is stored here.
 */
export interface AdminSessionRepo {
  create(input: {
    id: string;
    accountId: string;
    expiresAt: number;
    ip: string | null;
    userAgent: string | null;
  }): Promise<AdminSession>;
  /** Unexpired and unrevoked only; anything else is indistinguishable from unknown. */
  findLiveById(id: string, now: number): Promise<AdminSession | undefined>;
  getById(id: string): Promise<AdminSession | undefined>;
  listByAccount(accountId: string): Promise<AdminSession[]>;
  revoke(id: string, now: number): Promise<boolean>;
  revokeAllForAccount(accountId: string, now: number): Promise<number>;
  /** Boot-time sweep of rows long past expiry (§8.1.4). */
  deleteExpiredBefore(cutoff: number): Promise<number>;
}

function toSession(row: AdminSessionsTable): AdminSession {
  return {
    id: row.id,
    accountId: row.account_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    ip: row.ip,
    userAgent: row.user_agent,
  };
}

export function createAdminSessionRepo(db: Db): AdminSessionRepo {
  return {
    async create({ id, accountId, expiresAt, ip, userAgent }) {
      const session: AdminSession = {
        id,
        accountId,
        createdAt: Date.now(),
        expiresAt,
        revokedAt: null,
        ip,
        userAgent,
      };
      await db
        .insertInto("admin_sessions")
        .values({
          id: session.id,
          account_id: accountId,
          created_at: session.createdAt,
          expires_at: expiresAt,
          revoked_at: null,
          ip,
          user_agent: userAgent,
        })
        .execute();
      return session;
    },
    async findLiveById(id, now) {
      const row = await db
        .selectFrom("admin_sessions")
        .selectAll()
        .where("id", "=", id)
        .where("revoked_at", "is", null)
        .where("expires_at", ">", now)
        .executeTakeFirst();
      return row === undefined ? undefined : toSession(row);
    },
    async getById(id) {
      const row = await db
        .selectFrom("admin_sessions")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? undefined : toSession(row);
    },
    async listByAccount(accountId) {
      const rows = await db
        .selectFrom("admin_sessions")
        .selectAll()
        .where("account_id", "=", accountId)
        .orderBy("created_at", "desc")
        .execute();
      return rows.map(toSession);
    },
    async revoke(id, now) {
      const result = await db
        .updateTable("admin_sessions")
        .set({ revoked_at: now })
        .where("id", "=", id)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return result.numUpdatedRows === 1n;
    },
    async revokeAllForAccount(accountId, now) {
      const result = await db
        .updateTable("admin_sessions")
        .set({ revoked_at: now })
        .where("account_id", "=", accountId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
    async deleteExpiredBefore(cutoff) {
      const result = await db
        .deleteFrom("admin_sessions")
        .where("expires_at", "<", cutoff)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
