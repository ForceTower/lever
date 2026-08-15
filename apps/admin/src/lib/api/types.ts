/**
 * The wire shapes of `/v1/admin`, mirroring apps/api. Kept as hand-written
 * types rather than imported from the service: the dashboard ships separately
 * (spec 0001 §9.4) and is only allowed to depend on the API's HTTP contract.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ParameterType = "boolean" | "string" | "number" | "json";

export const PARAMETER_TYPES: ParameterType[] = ["boolean", "string", "number", "json"];

export function isParameterType(value: string): value is ParameterType {
  return (PARAMETER_TYPES as string[]).includes(value);
}

export type Clause =
  | { kind: "platform"; op: "eq"; value: string }
  | { kind: "platform"; op: "in"; value: string[] }
  | { kind: "appVersion"; op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"; value: string }
  | { kind: "attribute"; attribute: string; op: "eq" | "neq"; value: string }
  | { kind: "attribute"; attribute: string; op: "in" | "notIn"; value: string[] }
  | { kind: "attribute"; attribute: string; op: "exists" };

export type ClauseKind = Clause["kind"];

export interface Project {
  id: string;
  key: string;
  name: string;
  createdAt: number;
}

export interface Environment {
  id: string;
  projectId: string;
  key: string;
  clientKey: string;
  createdAt: number;
}

export interface EnvironmentDetail extends Environment {
  latestVersion: number;
  draftDirty: boolean;
}

export interface EnvironmentOverview extends EnvironmentDetail {
  parameterCount: number;
  conditionCount: number;
}

export interface ProjectOverview extends Project {
  environments: EnvironmentOverview[];
}

export interface Condition {
  id: string;
  environmentId: string;
  name: string;
  clauses: Clause[];
  updatedAt: number;
}

export interface ConditionalValue {
  id: string;
  parameterId: string;
  conditionId: string;
  value: JsonValue;
  position: number;
}

export interface Parameter {
  id: string;
  environmentId: string;
  key: string;
  type: ParameterType;
  defaultValue: JsonValue;
  description: string | null;
  updatedAt: number;
  conditionalValues: ConditionalValue[];
}

/** A parameter as a published version froze it: conditions inlined, no description. */
export interface SnapshotParameter {
  type: ParameterType;
  defaultValue: JsonValue;
  conditionalValues: { condition: { name: string; clauses: Clause[] }; value: JsonValue }[];
}

export interface SnapshotDiff {
  added: { key: string; after: SnapshotParameter }[];
  removed: { key: string; before: SnapshotParameter }[];
  changed: { key: string; before: SnapshotParameter; after: SnapshotParameter }[];
}

export interface PublishPreview {
  draftDirty: boolean;
  diff: SnapshotDiff;
}

export interface PublishedVersion {
  version: number;
  author: string;
  publishedAt: number;
  rollbackOf: number | null;
  diff: SnapshotDiff;
}

export type Permission =
  | "config:read"
  | "config:write"
  | "config:publish"
  | "config:admin"
  | "accounts:manage";

export interface Account {
  id: string;
  username: string;
  name: string;
  createdAt: number;
  disabled: boolean;
  permissions: Permission[];
  credentialCount: number;
}

/** What a completed passkey ceremony hands back (§8.1.4). */
export interface IssuedSession {
  token: string;
  expiresAt: number;
  account: Account;
}
