import type { EnvironmentRepo } from "../../db/environment-repo";
import type { Project, ProjectRepo } from "../../db/project-repo";
import { isConstraintError, LeverError, notFound } from "../../error";
import type { ResolveCache } from "../resolve-cache";

export interface ProjectsService {
  list(): Project[];
  create(input: { key: string; name: string }): Project;
  get(id: string): Project;
  rename(id: string, name: string): Project;
  /** Cascades away every environment and its version chain — hence the confirm echo (§8.2). */
  remove(id: string, confirm: string): void;
}

export function createProjectsService(
  repos: { projects: ProjectRepo; environments: EnvironmentRepo },
  resolveCache: ResolveCache,
): ProjectsService {
  const get = (id: string): Project => {
    const project = repos.projects.getById(id);
    if (project === undefined) throw notFound("project");
    return project;
  };

  return {
    list: () => repos.projects.list(),
    create(input) {
      try {
        return repos.projects.create(input);
      } catch (error) {
        if (isConstraintError(error)) {
          throw new LeverError(409, "already_exists", `project key "${input.key}" already exists`);
        }
        throw error;
      }
    },
    get,
    rename(id, name) {
      get(id);
      const renamed = repos.projects.rename(id, name);
      if (renamed === undefined) throw notFound("project");
      return renamed;
    },
    remove(id, confirm) {
      const project = get(id);
      if (confirm !== project.key) {
        throw new LeverError(
          400,
          "confirm_mismatch",
          `body must echo the project key "${project.key}" to delete it`,
        );
      }
      const environments = repos.environments.listByProject(id);
      repos.projects.remove(id);
      for (const environment of environments) resolveCache.environmentDeleted(environment);
    },
  };
}
