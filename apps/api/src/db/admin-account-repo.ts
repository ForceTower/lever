import type { Permission } from "../service/permissions";
import type { Db } from "./kysely";
import type { AdminAccountsTable, AdminCredentialsTable, AdminEnrollmentsTable } from "./schema";

export interface AdminAccount {
  id: string;
  username: string;
  name: string;
  createdAt: number;
  disabledAt: number | null;
}

export interface AdminCredential {
  id: string;
  accountId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface AdminEnrollment {
  id: string;
  accountId: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

/**
 * The §3.2.1 account aggregate: the account row plus everything that cascades
 * from it — credentials, enrollment codes, and permission grants.
 */
export interface AdminAccountRepo {
  create(input: { username: string; name: string }): Promise<AdminAccount>;
  getById(id: string): Promise<AdminAccount | undefined>;
  getByUsername(username: string): Promise<AdminAccount | undefined>;
  list(): Promise<AdminAccount[]>;
  update(
    id: string,
    input: { name?: string; disabledAt?: number | null },
  ): Promise<AdminAccount | undefined>;
  remove(id: string): Promise<boolean>;
  count(): Promise<number>;

  /** Raw column values — the service maps them onto the §8.1.5 vocabulary. */
  listGrants(accountId: string): Promise<string[]>;
  replaceGrants(accountId: string, permissions: Permission[]): Promise<void>;
  /** Accounts holding a permission, for the §8.1.5 last-holder guard. */
  countHolders(permission: Permission): Promise<number>;

  addCredential(input: {
    id: string;
    accountId: string;
    publicKey: Uint8Array;
    counter: number;
    transports: string[];
    name: string;
  }): Promise<AdminCredential>;
  getCredential(id: string): Promise<AdminCredential | undefined>;
  listCredentials(accountId: string): Promise<AdminCredential[]>;
  removeCredential(id: string): Promise<boolean>;
  touchCredential(id: string, counter: number): Promise<void>;

  createEnrollment(input: {
    accountId: string;
    codeHash: string;
    expiresAt: number;
  }): Promise<AdminEnrollment>;
  /** Unconsumed and unexpired only — an expired code is indistinguishable from an unknown one. */
  findLiveEnrollment(codeHash: string, now: number): Promise<AdminEnrollment | undefined>;
  consumeEnrollment(id: string, now: number): Promise<boolean>;
}

function toAccount(row: AdminAccountsTable): AdminAccount {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  };
}

function toCredential(row: AdminCredentialsTable): AdminCredential {
  return {
    id: row.id,
    accountId: row.account_id,
    // bun:sqlite hands BLOBs back as Uint8Array; @simplewebauthn wants exactly that.
    publicKey: row.public_key,
    counter: row.counter,
    transports: parseTransports(row.transports),
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function parseTransports(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function toEnrollment(row: AdminEnrollmentsTable): AdminEnrollment {
  return {
    id: row.id,
    accountId: row.account_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

export function createAdminAccountRepo(db: Db): AdminAccountRepo {
  const getById = async (id: string): Promise<AdminAccount | undefined> => {
    const row = await db
      .selectFrom("admin_accounts")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined ? undefined : toAccount(row);
  };

  const getCredential = async (id: string): Promise<AdminCredential | undefined> => {
    const row = await db
      .selectFrom("admin_credentials")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined ? undefined : toCredential(row);
  };

  return {
    async create({ username, name }) {
      const account: AdminAccount = {
        id: Bun.randomUUIDv7(),
        username,
        name,
        createdAt: Date.now(),
        disabledAt: null,
      };
      await db
        .insertInto("admin_accounts")
        .values({
          id: account.id,
          username,
          name,
          created_at: account.createdAt,
          disabled_at: null,
        })
        .execute();
      return account;
    },
    getById,
    async getByUsername(username) {
      const row = await db
        .selectFrom("admin_accounts")
        .selectAll()
        .where("username", "=", username)
        .executeTakeFirst();
      return row === undefined ? undefined : toAccount(row);
    },
    async list() {
      const rows = await db.selectFrom("admin_accounts").selectAll().orderBy("username").execute();
      return rows.map(toAccount);
    },
    async update(id, input) {
      const patch: { name?: string; disabled_at?: number | null } = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.disabledAt !== undefined) patch.disabled_at = input.disabledAt;
      if (Object.keys(patch).length > 0) {
        await db.updateTable("admin_accounts").set(patch).where("id", "=", id).execute();
      }
      return getById(id);
    },
    async remove(id) {
      const result = await db.deleteFrom("admin_accounts").where("id", "=", id).executeTakeFirst();
      // `> 0n`, not `=== 1n`: SQLite reports cascaded child rows in the change
      // count, so an entity with dependents deletes more than one row.
      return result.numDeletedRows > 0n;
    },
    async count() {
      const row = await db
        .selectFrom("admin_accounts")
        .select((eb) => eb.fn.countAll().as("total"))
        .executeTakeFirst();
      return Number(row?.total ?? 0);
    },

    async listGrants(accountId) {
      const rows = await db
        .selectFrom("admin_grants")
        .select("permission")
        .where("account_id", "=", accountId)
        .orderBy("permission")
        .execute();
      // The column is TEXT; a row written by an older build simply never matches
      // a requirePermission check once the service filters it.
      return rows.map((row) => row.permission);
    },
    async replaceGrants(accountId, permissions) {
      await db.deleteFrom("admin_grants").where("account_id", "=", accountId).execute();
      if (permissions.length === 0) return;
      const grantedAt = Date.now();
      await db
        .insertInto("admin_grants")
        .values(
          permissions.map((permission) => ({
            account_id: accountId,
            permission,
            granted_at: grantedAt,
          })),
        )
        .execute();
    },
    async countHolders(permission) {
      const row = await db
        .selectFrom("admin_grants")
        .innerJoin("admin_accounts", "admin_accounts.id", "admin_grants.account_id")
        .select((eb) => eb.fn.countAll().as("total"))
        .where("admin_grants.permission", "=", permission)
        // A disabled account cannot log in, so it cannot be the holder that keeps
        // the door open — counting it would let the last usable admin be removed.
        .where("admin_accounts.disabled_at", "is", null)
        .executeTakeFirst();
      return Number(row?.total ?? 0);
    },

    async addCredential({ id, accountId, publicKey, counter, transports, name }) {
      const credential: AdminCredential = {
        id,
        accountId,
        publicKey,
        counter,
        transports,
        name,
        createdAt: Date.now(),
        lastUsedAt: null,
      };
      await db
        .insertInto("admin_credentials")
        .values({
          id,
          account_id: accountId,
          public_key: publicKey,
          counter,
          transports: JSON.stringify(transports),
          name,
          created_at: credential.createdAt,
          last_used_at: null,
        })
        .execute();
      return credential;
    },
    getCredential,
    async listCredentials(accountId) {
      const rows = await db
        .selectFrom("admin_credentials")
        .selectAll()
        .where("account_id", "=", accountId)
        .orderBy("created_at")
        .execute();
      return rows.map(toCredential);
    },
    async removeCredential(id) {
      const result = await db
        .deleteFrom("admin_credentials")
        .where("id", "=", id)
        .executeTakeFirst();
      // `> 0n`, not `=== 1n`: SQLite reports cascaded child rows in the change
      // count, so an entity with dependents deletes more than one row.
      return result.numDeletedRows > 0n;
    },
    async touchCredential(id, counter) {
      await db
        .updateTable("admin_credentials")
        .set({ counter, last_used_at: Date.now() })
        .where("id", "=", id)
        .execute();
    },

    async createEnrollment({ accountId, codeHash, expiresAt }) {
      const enrollment: AdminEnrollment = {
        id: Bun.randomUUIDv7(),
        accountId,
        createdAt: Date.now(),
        expiresAt,
        consumedAt: null,
      };
      await db
        .insertInto("admin_enrollments")
        .values({
          id: enrollment.id,
          account_id: accountId,
          code_hash: codeHash,
          created_at: enrollment.createdAt,
          expires_at: expiresAt,
          consumed_at: null,
        })
        .execute();
      return enrollment;
    },
    async findLiveEnrollment(codeHash, now) {
      const row = await db
        .selectFrom("admin_enrollments")
        .selectAll()
        .where("code_hash", "=", codeHash)
        .where("consumed_at", "is", null)
        .where("expires_at", ">", now)
        .executeTakeFirst();
      return row === undefined ? undefined : toEnrollment(row);
    },
    async consumeEnrollment(id, now) {
      // The `consumed_at IS NULL` guard makes redemption single-use even if two
      // requests race the same code: exactly one update reports a changed row.
      const result = await db
        .updateTable("admin_enrollments")
        .set({ consumed_at: now })
        .where("id", "=", id)
        .where("consumed_at", "is", null)
        .executeTakeFirst();
      return result.numUpdatedRows === 1n;
    },
  };
}
