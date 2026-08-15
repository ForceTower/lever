/**
 * GET /v1/resolve — the hot path (spec 0001 §6). Zero I/O per request: the
 * clientKeyAuth middleware resolves the compiled environment from the cache,
 * evaluation is pure, and the body is canonical JSON so the ETag is a strong
 * validator over exact bytes.
 */
import { LeverError } from "../error";
import type { JsonValue } from "../service/canonicalize";
import { canonicalize } from "../service/canonicalize";
import { evaluate, type ResolveContext } from "../service/evaluate";
import { createHono } from "./index";
import { clientKeyAuth } from "./middleware";

// Reserved query names: platform, appVersion, clientId, key (§6.2). The
// attr. prefix keeps custom attributes disjoint from them forever.
const ATTRIBUTE_PREFIX = "attr.";
const MAX_ATTRIBUTES = 20;
const MAX_ATTRIBUTE_NAME = 64;
const MAX_ATTRIBUTE_VALUE = 256;
const MAX_RESERVED_VALUE = 64;

// Constant, so the recorded contract fixtures stay a faithful capture without
// needing a normalization step. `message` is non-contractual either way (§5.1).
const RESOLVED_MESSAGE = JSON.stringify("Configuration resolved");

function badContext(message: string): LeverError {
  return new LeverError(400, "validation_failed", message);
}

/**
 * §6.2: reserved names come through as-is, custom attributes as
 * `attr.<name>=<value>`, unprefixed unrecognized parameters are ignored
 * (forward compatibility), repeats take the first value. Input limits enforce
 * a bounded surface — the client key is public.
 */
export function parseResolveContext(queries: Record<string, string[]>): ResolveContext {
  const first = (name: string): string | undefined => queries[name]?.[0];

  for (const name of ["platform", "appVersion", "clientId"]) {
    const value = first(name);
    if (value !== undefined && value.length > MAX_RESERVED_VALUE) {
      throw badContext(`${name} must be at most ${MAX_RESERVED_VALUE} chars`);
    }
  }

  const attributes: Record<string, string> = {};
  let count = 0;
  for (const [name, values] of Object.entries(queries)) {
    // Reserved names are read above; unprefixed unrecognized ones are ignored.
    if (!name.startsWith(ATTRIBUTE_PREFIX)) continue;
    const attribute = name.slice(ATTRIBUTE_PREFIX.length);
    const value = values[0];
    if (attribute.length === 0 || attribute.length > MAX_ATTRIBUTE_NAME) {
      throw badContext(`attribute names must be 1-${MAX_ATTRIBUTE_NAME} chars`);
    }
    if (value === undefined || value.length > MAX_ATTRIBUTE_VALUE) {
      throw badContext(`attribute values must be at most ${MAX_ATTRIBUTE_VALUE} chars`);
    }
    count += 1;
    if (count > MAX_ATTRIBUTES) {
      throw badContext(`at most ${MAX_ATTRIBUTES} attributes per request`);
    }
    attributes[attribute] = value;
  }

  const context: ResolveContext = { attributes };
  const platform = first("platform");
  if (platform !== undefined) context.platform = platform;
  const appVersion = first("appVersion");
  if (appVersion !== undefined) context.appVersion = appVersion;
  const clientId = first("clientId");
  if (clientId !== undefined) context.clientId = clientId;
  return context;
}

function etagFor(body: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  return `"${hash.slice(0, 16)}"`;
}

/** Any member of the If-None-Match list matches, `*` matches everything. */
function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((member) => {
    const trimmed = member.trim();
    return (trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed) === etag;
  });
}

export const resolveRoutes = createHono();

resolveRoutes.get("/", clientKeyAuth(), (c) => {
  const compiled = c.get("compiledEnv");
  const context = parseResolveContext(c.req.queries());

  const values: Record<string, JsonValue> = {};
  if (compiled.snapshot !== undefined) {
    const evaluated = evaluate(compiled.snapshot, context, compiled.semverOperands);
    for (const [key, resolved] of Object.entries(evaluated)) {
      values[key] = { type: resolved.type, value: resolved.value };
    }
  }
  // The §6.3 payload, canonical bytes (§3.3) — the version is inside, so a
  // publish always changes the ETag even if resolved values coincide.
  const payload = canonicalize({ version: compiled.version, values });
  // Hashed over the payload alone, never the envelope (§6.4): the validator
  // is a function of resolved config, so no wording change to `message` can
  // invalidate a client's cache.
  const etag = etagFor(payload);

  c.header("ETag", etag);
  c.header("Cache-Control", "private, no-cache");
  if (ifNoneMatchHits(c.req.header("If-None-Match"), etag)) {
    return c.body(null, 304);
  }
  c.header("Content-Type", "application/json");
  // Spliced rather than re-serialized so the canonical payload bytes the ETag
  // covers are exactly the bytes on the wire.
  return c.body(`{"ok":true,"message":${RESOLVED_MESSAGE},"data":${payload},"error":null}`, 200);
});
