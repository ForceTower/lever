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
  listByProject(projectId: string): Promise<Environment[]>;
  create(projectId: string, key: string): Promise<Environment>;
  get(id: string): Promise<EnvironmentDetail>;
  /** The old key is invalid the moment this returns (§8.2). */
  rotateClientKey(id: string): Promise<Environment>;
  remove(id: string, confirm: string): Promise<void>;
}

export function createEnvironmentsService(
  repos: DraftRepos & {
    projects: ProjectRepo;
    environments: EnvironmentRepo;
    versions: VersionRepo;
  },
  resolveCache: ResolveCache,
): EnvironmentsService {
  const getOrThrow = async (id: string): Promise<Environment> => {
    const environment = await repos.environments.getById(id);
    if (environment === undefined) throw notFound("environment");
    return environment;
  };

  const ensureProject = async (projectId: string): Promise<void> => {
    if ((await repos.projects.getById(projectId)) === undefined) throw notFound("project");
  };

  const emptySnapshotBytes = canonicalize(buildSnapshot([]));

  return {
    async listByProject(projectId) {
      await ensureProject(projectId);
      return repos.environments.listByProject(projectId);
    },
    async create(projectId, key) {
      await ensureProject(projectId);
      try {
        const environment = await repos.environments.create({ projectId, key });
        resolveCache.environmentCreated(environment);
        return environment;
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
    async get(id) {
      const environment = await getOrThrow(id);
      const latest = await repos.versions.latest(id);
      const draftBytes = canonicalize(await buildDraftSnapshot(repos, id));
      const publishedBytes = latest?.snapshot ?? emptySnapshotBytes;
      return {
        ...environment,
        latestVersion: latest?.version ?? 0,
        draftDirty: draftBytes !== publishedBytes,
      };
    },
    async rotateClientKey(id) {
      const previous = await getOrThrow(id);
      const rotated = await repos.environments.rotateClientKey(id);
      if (rotated === undefined) throw notFound("environment");
      resolveCache.clientKeyRotated(previous, rotated);
      return rotated;
    },
    async remove(id, confirm) {
      const environment = await getOrThrow(id);
      if (confirm !== environment.key) {
        throw new LeverError(
          400,
          "confirm_mismatch",
          `body must echo the environment key "${environment.key}" to delete it`,
        );
      }
      await repos.environments.remove(id);
      resolveCache.environmentDeleted(environment);
    },
  };
}
