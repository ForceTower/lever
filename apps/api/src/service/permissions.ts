/**
 * The §8.1.5 permission vocabulary. The split follows blast radius, not CRUD
 * shape: `config:write` only ever changes a draft nobody is serving (§3.1),
 * `config:publish` changes what every client resolves, and `config:admin`
 * covers the two acts that break live clients or destroy an audit log —
 * deleting an environment and rotating its key.
 */
export const PERMISSIONS = [
  "config:read",
  "config:write",
  "config:publish",
  "config:admin",
  "accounts:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
