/**
 * RFC 8785 (JCS) canonical JSON serialization (spec 0001 §3.3).
 *
 * Snapshot bytes and resolve response bodies both come from this one function:
 * no-op publish detection and the resolve ETag hang on byte equality. JS gives
 * us most of JCS for free — `JSON.stringify` already emits shortest-form
 * numbers (ECMAScript Number::toString, which JCS adopts) and JCS's minimal
 * string escaping; the sort below compares keys by UTF-16 code units, which is
 * exactly what JS `<` on strings does.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("canonicalize: non-finite numbers are not valid JSON");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
  return `{${entries.join(",")}}`;
}
