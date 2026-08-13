import type { Environment, EnvironmentRepo } from "../../db/environment-repo";
import type { ProjectRepo } from "../../db/project-repo";
import type { VersionRepo } from "../../db/version-repo";
import { isConstraintError, LeverError, notFound } from "../../error";
import { canonicalize } from "../canonicalize";
import { buildDraftSnapshot, type DraftRepos } from "../draft";
import type { ResolveCache } from "../resolve-cache";
import { buildSnapshot } from "../snapshot";

/** The §8.2 environment detail: client key, latest version, dirty flag. */
export interface EnvironmentDetail extends Environment {
  latestVersion: number;
  draftDirty: boolean;
}

export interface EnvironmentsService {
  listByProject(projectId: string): Environment[];
  create(projectId: string, key: string): Environment;
  get(id: string): EnvironmentDetail;
  /** The old key is invalid the moment this returns (§8.2). */
  rotateClientKey(id: string): Environment;
  remove(id: string, confirm: string): void;
}

export function createEnvironmentsService(
  repos: DraftRepos & {
    projects: ProjectRepo;
    environments: EnvironmentRepo;
    versions: VersionRepo;
  },
  resolveCache: ResolveCache,
): EnvironmentsService {
  const getOrThrow = (id: string): Environment => {
    const environment = repos.environments.getById(id);
    if (environment === undefined) throw notFound("environment");
    return environment;
  };

  const emptySnapshotBytes = canonicalize(buildSnapshot([]));

  return {
    listByProject(projectId) {
      if (repos.projects.getById(projectId) === undefined) throw notFound("project");
      return repos.environments.listByProject(projectId);
    },
    create(projectId, key) {
      if (repos.projects.getById(projectId) === undefined) throw notFound("project");
      try {
        return repos.environments.create({ projectId, key });
      } catch (error) {
        if (isConstraintError(error)) {
          throw new LeverError(
            409,
            "already_exists",
            `environment key "${key}" already exists in this project`,
          );
        }
        throw error;
      }
    },
    get(id) {
      const environment = getOrThrow(id);
      const latest = repos.versions.latest(id);
      const draftBytes = canonicalize(buildDraftSnapshot(repos, id));
      const publishedBytes = latest?.snapshot ?? emptySnapshotBytes;
      return {
        ...environment,
        latestVersion: latest?.version ?? 0,
        draftDirty: draftBytes !== publishedBytes,
      };
    },
    rotateClientKey(id) {
      const previous = getOrThrow(id);
      const rotated = repos.environments.rotateClientKey(id);
      if (rotated === undefined) throw notFound("environment");
      resolveCache.clientKeyRotated(previous, rotated);
      return rotated;
    },
    remove(id, confirm) {
      const environment = getOrThrow(id);
      if (confirm !== environment.key) {
        throw new LeverError(
          400,
          "confirm_mismatch",
          `body must echo the environment key "${environment.key}" to delete it`,
        );
      }
      repos.environments.remove(id);
      resolveCache.environmentDeleted(environment);
    },
  };
}
