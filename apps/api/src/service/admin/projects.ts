import type { EnvironmentRepo } from "../../db/environment-repo";
import type { Project, ProjectRepo } from "../../db/project-repo";
import { isConstraintError, LeverError, notFound } from "../../error";
import type { ResolveCache } from "../resolve-cache";

export interface ProjectsService {
  list(): Promise<Project[]>;
  create(input: { key: string; name: string }): Promise<Project>;
  get(id: string): Promise<Project>;
  rename(id: string, name: string): Promise<Project>;
  /** Cascades away every environment and its version chain — hence the confirm echo (§8.2). */
  remove(id: string, confirm: string): Promise<void>;
}

export function createProjectsService(
  repos: { projects: ProjectRepo; environments: EnvironmentRepo },
  resolveCache: ResolveCache,
): ProjectsService {
  const get = async (id: string): Promise<Project> => {
    const project = await repos.projects.getById(id);
    if (project === undefined) throw notFound("project");
    return project;
  };

  return {
    list: () => repos.projects.list(),
    async create(input) {
      try {
        return await repos.projects.create(input);
      } catch (error) {
        if (isConstraintError(error)) {
          throw new LeverError(409, "already_exists", `project key "${input.key}" already exists`);
        }
        throw error;
      }
    },
    get,
    async rename(id, name) {
      await get(id);
      const renamed = await repos.projects.rename(id, name);
      if (renamed === undefined) throw notFound("project");
      return renamed;
    },
    async remove(id, confirm) {
      const project = await get(id);
      if (confirm !== project.key) {
        throw new LeverError(
          400,
          "confirm_mismatch",
          `body must echo the project key "${project.key}" to delete it`,
        );
      }
      const environments = await repos.environments.listByProject(id);
      await repos.projects.remove(id);
      for (const environment of environments) resolveCache.environmentDeleted(environment);
    },
  };
}
