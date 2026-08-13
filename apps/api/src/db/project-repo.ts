import type { Database } from "bun:sqlite";

export interface Project {
  id: string;
  key: string;
  name: string;
  createdAt: number;
}

export interface ProjectRepo {
  create(input: { key: string; name: string }): Project;
  getById(id: string): Project | undefined;
  getByKey(key: string): Project | undefined;
  list(): Project[];
  rename(id: string, name: string): Project | undefined;
  remove(id: string): boolean;
}

interface ProjectRow {
  id: string;
  key: string;
  name: string;
  created_at: number;
}

function toProject(row: ProjectRow): Project {
  return { id: row.id, key: row.key, name: row.name, createdAt: row.created_at };
}

export function createProjectRepo(db: Database): ProjectRepo {
  const getById = (id: string): Project | undefined => {
    const row = db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(id);
    return row === null ? undefined : toProject(row);
  };

  return {
    create({ key, name }) {
      const project: Project = { id: Bun.randomUUIDv7(), key, name, createdAt: Date.now() };
      db.query<undefined, [string, string, string, number]>(
        "INSERT INTO projects (id, key, name, created_at) VALUES (?, ?, ?, ?)",
      ).run(project.id, project.key, project.name, project.createdAt);
      return project;
    },
    getById,
    getByKey(key) {
      const row = db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE key = ?").get(key);
      return row === null ? undefined : toProject(row);
    },
    list() {
      return db.query<ProjectRow, []>("SELECT * FROM projects ORDER BY key").all().map(toProject);
    },
    rename(id, name) {
      db.query<undefined, [string, string]>("UPDATE projects SET name = ? WHERE id = ?").run(
        name,
        id,
      );
      return getById(id);
    },
    remove(id) {
      return (
        db.query<undefined, [string]>("DELETE FROM projects WHERE id = ?").run(id).changes === 1
      );
    },
  };
}
