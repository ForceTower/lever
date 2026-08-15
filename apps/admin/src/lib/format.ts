import type { Clause, JsonValue, ParameterType } from "@/lib/api/types";

/** Object keys sorted, so a value's rendering never depends on insertion order. */
function stable(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key] ?? null)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** How a value reads in the UI: strings stay quoted so `"true"` cannot pass for `true`. */
export function valueText(value: JsonValue): string {
  return stable(value);
}

export function shortValue(value: JsonValue, max = 40): string {
  const text = valueText(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The text a value editor starts with: JSON pretty-printed, everything else raw. */
export function editorText(type: ParameterType, value: JsonValue): string {
  if (type === "json") return JSON.stringify(value, null, 2);
  return String(value);
}

export function defaultValueFor(type: ParameterType): JsonValue {
  if (type === "boolean") return false;
  if (type === "number") return 0;
  if (type === "json") return {};
  return "";
}

export function valueMatchesType(type: ParameterType, value: JsonValue): boolean {
  return type === "json" || typeof value === type;
}

export type ParseResult = { ok: true; value: JsonValue } | { ok: false; message: string };

/** Editor text → a value of the parameter's type, or the reason it is not one. */
export function parseValue(type: ParameterType, text: string): ParseResult {
  if (type === "json") {
    try {
      return { ok: true, value: JSON.parse(text) as JsonValue };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `Invalid JSON: ${reason}` };
    }
  }
  if (type === "number") {
    const parsed = Number(text);
    if (text.trim() === "" || Number.isNaN(parsed)) {
      return { ok: false, message: "value must be a number" };
    }
    return { ok: true, value: parsed };
  }
  if (type === "boolean") return { ok: true, value: text === "true" };
  return { ok: true, value: text };
}

/** The clause vocabulary of §4, rendered the way the API stores it. */
export function clauseText(clause: Clause): string {
  if (clause.kind === "platform") return `platform ${clause.op} ${JSON.stringify(clause.value)}`;
  if (clause.kind === "appVersion")
    return `appVersion ${clause.op} ${JSON.stringify(clause.value)}`;
  if (clause.op === "exists") return `attribute ${clause.attribute} exists`;
  return `attribute ${clause.attribute} ${clause.op} ${JSON.stringify(clause.value)}`;
}

export function isStrictSemver(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    value,
  );
}

export function relativeDay(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
