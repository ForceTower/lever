/**
 * Kysely table types mirroring the §3.2 schema (snake_case columns as
 * persisted). JSON-encoded TEXT columns (`clauses`, `default_value`, `value`)
 * stay `string` here — parsing and validation happen in the repositories'
 * row-to-domain mappers.
 */

export interface ProjectsTable {
  id: string;
  key: string;
  name: string;
  created_at: number;
}

export interface EnvironmentsTable {
  id: string;
  project_id: string;
  key: string;
  client_key: string;
  created_at: number;
}

export interface ConditionsTable {
  id: string;
  environment_id: string;
  name: string;
  clauses: string;
  updated_at: number;
}

export interface ParametersTable {
  id: string;
  environment_id: string;
  key: string;
  type: string;
  default_value: string;
  description: string | null;
  updated_at: number;
}

export interface ParameterConditionalValuesTable {
  id: string;
  parameter_id: string;
  condition_id: string;
  value: string;
  position: number;
}

export interface VersionsTable {
  environment_id: string;
  version: number;
  snapshot: string;
  author: string;
  author_account_id: string | null;
  published_at: number;
  rollback_of: number | null;
}

/** §3.2.1 — the passkey account model. Nothing in the resolve path reads these. */

export interface AdminAccountsTable {
  id: string;
  username: string;
  name: string;
  created_at: number;
  disabled_at: number | null;
}

export interface AdminCredentialsTable {
  id: string;
  account_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

export interface AdminEnrollmentsTable {
  id: string;
  account_id: string;
  code_hash: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export interface AdminSessionsTable {
  /** The session token's `jti` claim (§8.1.4). */
  id: string;
  account_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  ip: string | null;
  user_agent: string | null;
}

export interface AdminGrantsTable {
  account_id: string;
  permission: string;
  granted_at: number;
}

export interface AdminAuditTable {
  id: string;
  account_id: string | null;
  username: string;
  session_id: string | null;
  method: string;
  path: string;
  status: number;
  body: string | null;
  created_at: number;
}

export interface DatabaseSchema {
  projects: ProjectsTable;
  environments: EnvironmentsTable;
  conditions: ConditionsTable;
  parameters: ParametersTable;
  parameter_conditional_values: ParameterConditionalValuesTable;
  versions: VersionsTable;
  admin_accounts: AdminAccountsTable;
  admin_credentials: AdminCredentialsTable;
  admin_enrollments: AdminEnrollmentsTable;
  admin_sessions: AdminSessionsTable;
  admin_grants: AdminGrantsTable;
  admin_audit: AdminAuditTable;
}
