import type { Db } from "./kysely";
import type { ProjectsTable } from "./schema";

export interface Project {
  id: string;
  key: string;
  name: string;
  createdAt: number;
}

export interface ProjectRepo {
  create(input: { key: string; name: string }): Promise<Project>;
  getById(id: string): Promise<Project | undefined>;
  getByKey(key: string): Promise<Project | undefined>;
  list(): Promise<Project[]>;
  rename(id: string, name: string): Promise<Project | undefined>;
  remove(id: string): Promise<boolean>;
}

function toProject(row: ProjectsTable): Project {
  return { id: row.id, key: row.key, name: row.name, createdAt: row.created_at };
}

export function createProjectRepo(db: Db): ProjectRepo {
  const getById = async (id: string): Promise<Project | undefined> => {
    const row = await db.selectFrom("projects").selectAll().where("id", "=", id).executeTakeFirst();
    return row === undefined ? undefined : toProject(row);
  };

  return {
    async create({ key, name }) {
      const project: Project = { id: Bun.randomUUIDv7(), key, name, createdAt: Date.now() };
      await db
        .insertInto("projects")
        .values({ id: project.id, key, name, created_at: project.createdAt })
        .execute();
      return project;
    },
    getById,
    async getByKey(key) {
      const row = await db
        .selectFrom("projects")
        .selectAll()
        .where("key", "=", key)
        .executeTakeFirst();
      return row === undefined ? undefined : toProject(row);
    },
    async list() {
      const rows = await db.selectFrom("projects").selectAll().orderBy("key").execute();
      return rows.map(toProject);
    },
    async rename(id, name) {
      await db.updateTable("projects").set({ name }).where("id", "=", id).execute();
      return getById(id);
    },
    async remove(id) {
      const result = await db.deleteFrom("projects").where("id", "=", id).executeTakeFirst();
      // `> 0n`, not `=== 1n`: SQLite reports cascaded child rows in the change
      // count, so an entity with dependents deletes more than one row.
      return result.numDeletedRows > 0n;
    },
  };
}
