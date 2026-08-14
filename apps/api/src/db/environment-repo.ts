import type { Db } from "./kysely";
import type { EnvironmentsTable } from "./schema";

export interface Environment {
  id: string;
  projectId: string;
  key: string;
  clientKey: string;
  createdAt: number;
}

export interface EnvironmentRepo {
  create(input: { projectId: string; key: string }): Promise<Environment>;
  getById(id: string): Promise<Environment | undefined>;
  getByClientKey(clientKey: string): Promise<Environment | undefined>;
  listByProject(projectId: string): Promise<Environment[]>;
  /** Warm-up scan for the resolve cache's auth index (spec 0001 §6.4). */
  listAll(): Promise<Environment[]>;
  /** Returns the environment with its new key; the old key is gone with the update. */
  rotateClientKey(id: string): Promise<Environment | undefined>;
  remove(id: string): Promise<boolean>;
}

const CLIENT_KEY_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Client keys are public identifiers, not credentials (research §7) — the
// slight modulo bias here costs nothing.
function generateClientKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let key = "pk_";
  for (const byte of bytes) key += CLIENT_KEY_ALPHABET[byte % CLIENT_KEY_ALPHABET.length];
  return key;
}

function toEnvironment(row: EnvironmentsTable): Environment {
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    clientKey: row.client_key,
    createdAt: row.created_at,
  };
}

export function createEnvironmentRepo(db: Db): EnvironmentRepo {
  const getById = async (id: string): Promise<Environment | undefined> => {
    const row = await db
      .selectFrom("environments")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined ? undefined : toEnvironment(row);
  };

  return {
    async create({ projectId, key }) {
      const environment: Environment = {
        id: Bun.randomUUIDv7(),
        projectId,
        key,
        clientKey: generateClientKey(),
        createdAt: Date.now(),
      };
      await db
        .insertInto("environments")
        .values({
          id: environment.id,
          project_id: environment.projectId,
          key: environment.key,
          client_key: environment.clientKey,
          created_at: environment.createdAt,
        })
        .execute();
      return environment;
    },
    getById,
    async getByClientKey(clientKey) {
      const row = await db
        .selectFrom("environments")
        .selectAll()
        .where("client_key", "=", clientKey)
        .executeTakeFirst();
      return row === undefined ? undefined : toEnvironment(row);
    },
    async listByProject(projectId) {
      const rows = await db
        .selectFrom("environments")
        .selectAll()
        .where("project_id", "=", projectId)
        .orderBy("key")
        .execute();
      return rows.map(toEnvironment);
    },
    async listAll() {
      const rows = await db.selectFrom("environments").selectAll().execute();
      return rows.map(toEnvironment);
    },
    async rotateClientKey(id) {
      await db
        .updateTable("environments")
        .set({ client_key: generateClientKey() })
        .where("id", "=", id)
        .execute();
      return getById(id);
    },
    async remove(id) {
      const result = await db.deleteFrom("environments").where("id", "=", id).executeTakeFirst();
      return result.numDeletedRows === 1n;
    },
  };
}
