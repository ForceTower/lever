import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, api, type ParameterInput, type ParameterPatch } from "@/lib/api";
import type { Clause, JsonValue } from "@/lib/api/types";

export const queryKeys = {
  overview: ["overview"] as const,
  environment: (envId: string) => ["environment", envId] as const,
  parameters: (envId: string) => ["parameters", envId] as const,
  conditions: (envId: string) => ["conditions", envId] as const,
  diff: (envId: string) => ["diff", envId] as const,
};

/**
 * Every draft edit moves the same four facts: the rows, the publish diff, the
 * environment's dirty flag, and the overview that paints it in the switcher.
 * They are refreshed together so a flipped switch cannot leave the sidebar
 * claiming the draft is clean.
 */
function invalidateEnvironment(client: QueryClient, envId: string): void {
  void client.invalidateQueries({ queryKey: queryKeys.parameters(envId) });
  void client.invalidateQueries({ queryKey: queryKeys.conditions(envId) });
  void client.invalidateQueries({ queryKey: queryKeys.diff(envId) });
  void client.invalidateQueries({ queryKey: queryKeys.environment(envId) });
  void client.invalidateQueries({ queryKey: queryKeys.overview });
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function toastError(error: unknown): void {
  toast.error(errorMessage(error));
}

export function useOverview() {
  return useQuery({ queryKey: queryKeys.overview, queryFn: () => api.overview() });
}

/**
 * The environment's place in the deployment — its project, its siblings, its
 * counts — read out of the one overview the shell already holds rather than
 * refetched per screen.
 */
export function useEnvironmentSummary(envId: string) {
  const overview = useOverview();
  for (const project of overview.data ?? []) {
    const environment = project.environments.find((candidate) => candidate.id === envId);
    if (environment !== undefined) return { project, environment, projects: overview.data ?? [] };
  }
  return { project: undefined, environment: undefined, projects: overview.data ?? [] };
}

export function useEnvironment(envId: string) {
  return useQuery({
    queryKey: queryKeys.environment(envId),
    queryFn: () => api.environments.get(envId),
  });
}

export function useParameters(envId: string) {
  return useQuery({
    queryKey: queryKeys.parameters(envId),
    queryFn: () => api.parameters.list(envId),
  });
}

export function useConditions(envId: string) {
  return useQuery({
    queryKey: queryKeys.conditions(envId),
    queryFn: () => api.conditions.list(envId),
  });
}

/** The draft-vs-published diff — what every "not live yet" marker is derived from. */
export function usePublishPreview(envId: string) {
  return useQuery({ queryKey: queryKeys.diff(envId), queryFn: () => api.publish.preview(envId) });
}

function useEnvironmentMutation<TVariables, TData>(
  envId: string,
  mutationFn: (variables: TVariables) => Promise<TData>,
  onDone?: (data: TData) => void,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (data) => {
      invalidateEnvironment(client, envId);
      onDone?.(data);
    },
    onError: toastError,
  });
}

export function useCreateProject(onDone?: (id: string) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { key: string; name: string }) => api.projects.create(input),
    onSuccess: (project) => {
      void client.invalidateQueries({ queryKey: queryKeys.overview });
      onDone?.(project.id);
    },
  });
}

export function useRenameProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.projects.rename(id, name),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.overview });
      toast.success("Project renamed");
    },
    onError: toastError,
  });
}

export function useDeleteProject(onDone?: () => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm: string }) =>
      api.projects.remove(id, confirm),
    onSuccess: (_data, { confirm }) => {
      void client.invalidateQueries({ queryKey: queryKeys.overview });
      toast.success(`Project ${confirm} deleted`);
      onDone?.();
    },
    onError: toastError,
  });
}

export function useCreateEnvironment(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api.environments.create(projectId, key),
    onSuccess: (environment) => {
      void client.invalidateQueries({ queryKey: queryKeys.overview });
      toast.success(`Environment ${environment.key} created`);
    },
    onError: toastError,
  });
}

export function useRotateClientKey(envId: string) {
  return useEnvironmentMutation(
    envId,
    () => api.environments.rotateKey(envId),
    () => {
      toast.success("Client key rotated");
    },
  );
}

export function useDeleteEnvironment(envId: string, onDone?: () => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (confirm: string) => api.environments.remove(envId, confirm),
    onSuccess: (_data, confirm) => {
      void client.invalidateQueries({ queryKey: queryKeys.overview });
      toast.success(`Environment ${confirm} deleted`);
      onDone?.();
    },
    onError: toastError,
  });
}

export function useCreateParameter(envId: string, onDone?: (id: string) => void) {
  return useEnvironmentMutation(
    envId,
    (input: ParameterInput) => api.parameters.create(envId, input),
    (parameter) => onDone?.(parameter.id),
  );
}

export function useUpdateParameter(envId: string, onDone?: () => void) {
  return useEnvironmentMutation(
    envId,
    ({ id, patch }: { id: string; patch: ParameterPatch }) => api.parameters.update(id, patch),
    () => onDone?.(),
  );
}

export function useDeleteParameter(envId: string, onDone?: () => void) {
  return useEnvironmentMutation(
    envId,
    (id: string) => api.parameters.remove(id),
    () => {
      toast.success("Parameter removed from the draft");
      onDone?.();
    },
  );
}

export function useReplaceConditionalValues(envId: string) {
  return useEnvironmentMutation(
    envId,
    ({ id, values }: { id: string; values: { conditionId: string; value: JsonValue }[] }) =>
      api.parameters.replaceConditionalValues(id, values),
  );
}

export function useSaveCondition(envId: string, onDone?: () => void) {
  return useEnvironmentMutation(
    envId,
    ({ id, name, clauses }: { id: string | null; name: string; clauses: Clause[] }) =>
      id === null
        ? api.conditions.create(envId, { name, clauses })
        : api.conditions.update(id, { name, clauses }),
    () => onDone?.(),
  );
}

export function useDeleteCondition(envId: string, onDone?: () => void) {
  return useEnvironmentMutation(
    envId,
    (id: string) => api.conditions.remove(id),
    () => {
      toast.success("Condition deleted");
      onDone?.();
    },
  );
}

/**
 * No error toast: a `publish_conflict` is the one refusal that needs a screen
 * of its own — the reviewed diff is stale, and the page says so and offers to
 * reload it (§8.3).
 */
export function usePublish(envId: string, onDone: (version: number) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (expectedVersion: number) => api.publish.publish(envId, expectedVersion),
    onSuccess: (published) => {
      invalidateEnvironment(client, envId);
      onDone(published.version);
    },
  });
}
