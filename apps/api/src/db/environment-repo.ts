import type { Database } from "bun:sqlite";

export interface Environment {
  id: string;
  projectId: string;
  key: string;
  clientKey: string;
  createdAt: number;
}

export interface EnvironmentRepo {
  create(input: { projectId: string; key: string }): Environment;
  getById(id: string): Environment | undefined;
  getByClientKey(clientKey: string): Environment | undefined;
  listByProject(projectId: string): Environment[];
  /** Warm-up scan for the resolve cache's auth index (spec 0001 §6.4). */
  listAll(): Environment[];
  /** Returns the environment with its new key; the old key is gone with the update. */
  rotateClientKey(id: string): Environment | undefined;
  remove(id: string): boolean;
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

interface EnvironmentRow {
  id: string;
  project_id: string;
  key: string;
  client_key: string;
  created_at: number;
}

function toEnvironment(row: EnvironmentRow): Environment {
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    clientKey: row.client_key,
    createdAt: row.created_at,
  };
}

export function createEnvironmentRepo(db: Database): EnvironmentRepo {
  const getById = (id: string): Environment | undefined => {
    const row = db
      .query<EnvironmentRow, [string]>("SELECT * FROM environments WHERE id = ?")
      .get(id);
    return row === null ? undefined : toEnvironment(row);
  };

  return {
    create({ projectId, key }) {
      const environment: Environment = {
        id: Bun.randomUUIDv7(),
        projectId,
        key,
        clientKey: generateClientKey(),
        createdAt: Date.now(),
      };
      db.query<undefined, [string, string, string, string, number]>(
        "INSERT INTO environments (id, project_id, key, client_key, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        environment.id,
        environment.projectId,
        environment.key,
        environment.clientKey,
        environment.createdAt,
      );
      return environment;
    },
    getById,
    getByClientKey(clientKey) {
      const row = db
        .query<EnvironmentRow, [string]>("SELECT * FROM environments WHERE client_key = ?")
        .get(clientKey);
      return row === null ? undefined : toEnvironment(row);
    },
    listByProject(projectId) {
      return db
        .query<EnvironmentRow, [string]>(
          "SELECT * FROM environments WHERE project_id = ? ORDER BY key",
        )
        .all(projectId)
        .map(toEnvironment);
    },
    listAll() {
      return db.query<EnvironmentRow, []>("SELECT * FROM environments").all().map(toEnvironment);
    },
    rotateClientKey(id) {
      db.query<undefined, [string, string]>(
        "UPDATE environments SET client_key = ? WHERE id = ?",
      ).run(generateClientKey(), id);
      return getById(id);
    },
    remove(id) {
      return (
        db.query<undefined, [string]>("DELETE FROM environments WHERE id = ?").run(id).changes === 1
      );
    },
  };
}
