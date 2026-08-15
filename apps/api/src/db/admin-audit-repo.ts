import type { Db } from "./kysely";
import type { AdminAuditTable } from "./schema";

export interface AdminAuditEntry {
  id: string;
  accountId: string | null;
  username: string;
  sessionId: string | null;
  method: string;
  path: string;
  status: number;
  body: unknown;
  createdAt: number;
}

/**
 * §8.1.6. Append-only by construction, like `versions`: no update, no delete.
 * `accountId` and `username` are copied rather than joined so a deleted account
 * does not erase the record of what it did.
 */
export interface AdminAuditRepo {
  insert(input: {
    accountId: string | null;
    username: string;
    sessionId: string | null;
    method: string;
    path: string;
    status: number;
    body: unknown;
  }): Promise<void>;
  list(limit: number): Promise<AdminAuditEntry[]>;
}

function toEntry(row: AdminAuditTable): AdminAuditEntry {
  let body: unknown = null;
  if (row.body !== null) {
    try {
      body = JSON.parse(row.body);
    } catch {
      body = null;
    }
  }
  return {
    id: row.id,
    accountId: row.account_id,
    username: row.username,
    sessionId: row.session_id,
    method: row.method,
    path: row.path,
    status: row.status,
    body,
    createdAt: row.created_at,
  };
}

export function createAdminAuditRepo(db: Db): AdminAuditRepo {
  return {
    async insert({ accountId, username, sessionId, method, path, status, body }) {
      await db
        .insertInto("admin_audit")
        .values({
          id: Bun.randomUUIDv7(),
          account_id: accountId,
          username,
          session_id: sessionId,
          method,
          path,
          status,
          body: body === null || body === undefined ? null : JSON.stringify(body),
          created_at: Date.now(),
        })
        .execute();
    },
    async list(limit) {
      const rows = await db
        .selectFrom("admin_audit")
        .selectAll()
        .orderBy("created_at", "desc")
        .limit(limit)
        .execute();
      return rows.map(toEntry);
    },
  };
}
