import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { clearSession, loadSession, notifyUnauthorized } from "@/lib/api/session";
import type {
  Condition,
  Clause,
  Environment,
  EnvironmentDetail,
  IssuedSession,
  JsonValue,
  Parameter,
  ParameterType,
  Project,
  ProjectOverview,
  PublishPreview,
  PublishedVersion,
  ConditionalValue,
} from "@/lib/api/types";
import { API_BASE_URL } from "@/lib/env";

/**
 * A refusal from the service, carrying the §5.1 envelope's `error.code` — the
 * part a caller may branch on — alongside the human-facing message the API
 * already wrote. The dashboard shows that message rather than inventing its
 * own: the API's wording is the one that knows what actually happened.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface Envelope {
  ok: boolean;
  message: string;
  data: unknown;
  error: { code: string; details?: unknown } | null;
}

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === "object" && value !== null && "ok" in value && "data" in value;
}

function errorOf(envelope: Envelope): { code: string } | null {
  const { error } = envelope;
  return typeof error === "object" && error !== null && "code" in error ? error : null;
}

function messageOf(envelope: Envelope): string | null {
  return typeof envelope.message === "string" ? envelope.message : null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const session = loadSession();
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  if (session !== null) headers.set("Authorization", `Bearer ${session.token}`);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/v1/admin${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, "network_error", "Could not reach the Lever service.");
  }

  const body: unknown = await response.json().catch(() => null);
  const envelope = isEnvelope(body) ? body : null;

  if (!response.ok || envelope?.ok !== true) {
    // A 401 on a request that carried a session means the session died in use;
    // a 401 during the ceremony itself is just a failed attempt.
    if (response.status === 401 && session !== null) {
      clearSession();
      notifyUnauthorized();
    }
    throw new ApiError(
      response.status,
      envelope === null ? "unexpected" : (errorOf(envelope)?.code ?? "unexpected"),
      (envelope === null ? null : messageOf(envelope)) ?? response.statusText,
    );
  }
  // The only assertion in the transport: `data` is whatever the route documents
  // it returns, and the types in ./types are this app's copy of that contract.
  return envelope.data as T;
}

function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export interface ParameterInput {
  key: string;
  type: ParameterType;
  defaultValue: JsonValue;
  description?: string;
}

export interface ParameterPatch {
  key?: string;
  type?: ParameterType;
  defaultValue?: JsonValue;
  description?: string | null;
}

export const api = {
  auth: {
    /**
     * The §8.1.3 login ceremony. `username` is optional — omitted, the platform
     * offers whichever passkey it holds for this deployment.
     */
    async login(username?: string): Promise<IssuedSession> {
      const { challengeId, options } = await send<{
        challengeId: string;
        options: PublicKeyCredentialRequestOptionsJSON;
      }>("POST", "/auth/login/options", username === undefined ? {} : { username });
      const response = await startAuthentication({ optionsJSON: options });
      return send<IssuedSession>("POST", "/auth/login/verify", { challengeId, response });
    },

    /** Trades a one-time enrollment code for a passkey on this device (§8.1.2). */
    async register(code: string, credentialName: string): Promise<IssuedSession> {
      const { challengeId, options } = await send<{
        challengeId: string;
        options: PublicKeyCredentialCreationOptionsJSON;
      }>("POST", "/auth/register/options", { code });
      const response = await startRegistration({ optionsJSON: options });
      return send<IssuedSession>("POST", "/auth/register/verify", {
        code,
        challengeId,
        credentialName,
        response,
      });
    },

    logout: () => send<null>("POST", "/auth/logout"),
  },

  overview: () => request<ProjectOverview[]>("/overview"),

  projects: {
    create: (input: { key: string; name: string }) => send<Project>("POST", "/projects", input),
    rename: (id: string, name: string) => send<Project>("PATCH", `/projects/${id}`, { name }),
    remove: (id: string, confirm: string) => send<null>("DELETE", `/projects/${id}`, { confirm }),
  },

  environments: {
    get: (id: string) => request<EnvironmentDetail>(`/environments/${id}`),
    create: (projectId: string, key: string) =>
      send<Environment>("POST", `/projects/${projectId}/environments`, { key }),
    rotateKey: (id: string) => send<Environment>("POST", `/environments/${id}/rotate-key`),
    remove: (id: string, confirm: string) =>
      send<null>("DELETE", `/environments/${id}`, { confirm }),
  },

  conditions: {
    list: (envId: string) => request<Condition[]>(`/environments/${envId}/conditions`),
    create: (envId: string, input: { name: string; clauses: Clause[] }) =>
      send<Condition>("POST", `/environments/${envId}/conditions`, input),
    update: (id: string, patch: { name?: string; clauses?: Clause[] }) =>
      send<Condition>("PATCH", `/conditions/${id}`, patch),
    remove: (id: string) => send<null>("DELETE", `/conditions/${id}`),
  },

  parameters: {
    list: (envId: string) => request<Parameter[]>(`/environments/${envId}/parameters`),
    create: (envId: string, input: ParameterInput) =>
      send<Parameter>("POST", `/environments/${envId}/parameters`, input),
    update: (id: string, patch: ParameterPatch) =>
      send<Parameter>("PATCH", `/parameters/${id}`, patch),
    remove: (id: string) => send<null>("DELETE", `/parameters/${id}`),
    /** The whole ordered list at once — the API offers no partial reorder (§8.2). */
    replaceConditionalValues: (id: string, values: { conditionId: string; value: JsonValue }[]) =>
      send<ConditionalValue[]>("PUT", `/parameters/${id}/conditional-values`, values),
  },

  publish: {
    preview: (envId: string) => request<PublishPreview>(`/environments/${envId}/diff`),
    /**
     * `expectedVersion` is what makes a stale tab fail loudly: the service
     * refuses with `publish_conflict` when someone else published in between
     * (§8.3), instead of burying a diff this operator never saw.
     */
    publish: (envId: string, expectedVersion: number) =>
      send<PublishedVersion>("POST", `/environments/${envId}/publish`, { expectedVersion }),
  },
};
