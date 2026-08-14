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
  published_at: number;
  rollback_of: number | null;
}

export interface DatabaseSchema {
  projects: ProjectsTable;
  environments: EnvironmentsTable;
  conditions: ConditionsTable;
  parameters: ParametersTable;
  parameter_conditional_values: ParameterConditionalValuesTable;
  versions: VersionsTable;
}
