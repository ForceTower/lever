import type { Environment, EnvironmentRepo } from "../../db/environment-repo";
import type { Project, ProjectRepo } from "../../db/project-repo";
import type { VersionRepo } from "../../db/version-repo";
import { canonicalize } from "../canonicalize";
import { buildDraftSnapshot, type DraftRepos } from "../draft";
import { buildSnapshot } from "../snapshot";

export interface EnvironmentOverview extends Environment {
  latestVersion: number;
  draftDirty: boolean;
  parameterCount: number;
  conditionCount: number;
}

export interface ProjectOverview extends Project {
  environments: EnvironmentOverview[];
}

export interface OverviewService {
  list(): Promise<ProjectOverview[]>;
}

/**
 * The whole deployment in one read: every project, every environment, and the
 * two facts the dashboard's project list and environment switcher put in front
 * of an operator before they pick anything — what version apps are on, and
 * whether a draft is sitting unpublished. Assembled per environment rather than
 * fetched per screen, because the alternative is one request per environment
 * before the first screen can render.
 */
export function createOverviewService(
  repos: DraftRepos & {
    projects: ProjectRepo;
    environments: EnvironmentRepo;
    versions: VersionRepo;
  },
): OverviewService {
  const emptySnapshotBytes = canonicalize(buildSnapshot([]));

  const describe = async (environment: Environment): Promise<EnvironmentOverview> => {
    const latest = await repos.versions.latest(environment.id);
    const draftBytes = canonicalize(await buildDraftSnapshot(repos, environment.id));
    const parameters = await repos.parameters.listByEnvironment(environment.id);
    const conditions = await repos.conditions.listByEnvironment(environment.id);
    return {
      ...environment,
      latestVersion: latest?.version ?? 0,
      draftDirty: draftBytes !== (latest?.snapshot ?? emptySnapshotBytes),
      parameterCount: parameters.length,
      conditionCount: conditions.length,
    };
  };

  return {
    async list() {
      const projects = await repos.projects.list();
      const overview: ProjectOverview[] = [];
      for (const project of projects) {
        const environments = await repos.environments.listByProject(project.id);
        overview.push({ ...project, environments: await Promise.all(environments.map(describe)) });
      }
      return overview;
    },
  };
}
