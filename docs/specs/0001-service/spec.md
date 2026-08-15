# Spec 0001 — The service

- **Status:** implemented, including the 2026-08-14 amendment — the response envelope
  (§5.1), passkey admin auth (§8.1), and the separately hosted dashboard (§9.4), per
  research §4.2, §4.5, §4.6.
- **Research:** [0001 — product scope](../../research/0001-product-scope/research.md)
- **Scope:** the backend service only — SQLite schema, resolve/stream endpoints, admin
  REST, auth, and the cross-cutting plumbing (research §8). The dashboard and the three
  SDKs are later specs; this document only reserves their workspace slots.

> Specs pin down the *how* for a research doc's *what*. Every design decision here
> should trace to research 0001; deviations start with amending the research doc, not
> this file.

## 1. Monorepo layout

Bun workspace monorepo, one repo for the whole product (research §3.4):

```
lever/
  package.json          # workspaces: apps/*, packages/*; scripts: check/fix/fmt/lint
  .mise.toml            # pins bun
  apps/
    api/                # this spec — the Bun + Hono service
    admin/              # dashboard SPA (later spec; its own deployment, own domain, §9.4)
  packages/
    sdk-ts/             # TypeScript SDK (later spec)
    contract-fixtures/  # shared resolve fixtures (§10.2) — JSON only, no runtime code
```

Root scripts use oxlint (type-aware) and oxfmt: `check` (lint + format check), `fix`,
`fmt`, `lint`. `apps/api` layout:

```
apps/api/
  src/
    index.ts            # entry: migrate, warm cache, Bun.serve
    app.ts              # Hono app assembly, top-level middleware, onError
    env.ts              # zod-validated env vars + service registry
    error.ts            # LeverError
    logger.ts           # request-scoped structured logging
    admin-enroll.ts     # `admin:enroll` CLI — bootstrap and recovery (§8.1.2)
    api/
      index.ts          # createHono, typed context, envelope helpers, zValidator wrapper
      middleware.ts     # clientKeyAuth, adminAuth, requirePermission, adminAudit
      resolve.ts        # GET /v1/resolve
      stream.ts         # GET /v1/stream
      admin/            # /v1/admin/* route modules (auth, accounts, projects,
                        #   environments, parameters, conditions, versions)
                        #   plus passkey-schemas.ts (§8.1 request validation)
    service/
      evaluate.ts       # pure rule evaluation (snapshot + context → values)
      resolve-cache.ts  # in-process compiled-snapshot cache (§6.4)
      publish.ts        # snapshot build, diff, publish, rollback
      stream.ts         # SSE subscriber registry, broadcast, heartbeat
      webauthn.ts       # passkey ceremonies over @simplewebauthn/server (§8.1)
      tokens.ts         # session JWT sign/verify (§8.1.4)
      permissions.ts    # the §8.1.5 permission vocabulary
      admin-auth.ts     # accounts, enrollment codes, sessions, grants (§8.1)
      admin/            # CRUD services over the repositories
    db/
      index.ts          # openDb (pragmas), migration runner, createRepos, withTransaction
      kysely.ts         # Kysely dialect over bun:sqlite (§3.5)
      schema.ts         # Kysely table types mirroring §3.2
      migrations/       # 0001-init.ts, … (§9.3)
      *-repo.ts         # repository seam (§3.4)
  Dockerfile
```

Routes bind to services, services depend on repositories, repositories own SQL. Env
follows the reference idiom: a zod-parsed `envVarsSchema` plus a lazily built, cached
registry (`getEnv()`) of constructed services, injected into Hono's `Bindings` — so a
handler reaches its dependencies as `c.env.services.…` rather than through a factory
argument. Route modules are correspondingly **module-level `Hono` constants**
(`export const projectRoutes = createHono()`), not functions that take services and
return a router; `app.ts` installs the registry in one middleware and mounts them.
That is what keeps `createApp(env)` the only injection point, which is in turn what
lets every test hold its own `:memory:` database (§10).

One routing rule worth stating, because getting it wrong is silent: a router that
applies a blanket `use("*", requirePermission(…))` must be mounted under its own path
prefix. Mounted at `/`, that middleware matches every admin request and gates the whole
surface on one permission — which is why the identity routes live under `/accounts` and
`/sessions` rather than declaring absolute paths on a router mounted at the root.

## 2. Domain model

Four aggregates, mirroring research §4.1:

- **Project** — a namespace with a slug and display name.
- **Environment** — prod/staging/dev within a project. Owns exactly one public client
  key (`pk_…`) and everything below it: parameters, conditions, versions.
- **Parameter** — a typed key (`boolean | string | number | json`) with a default
  value and an ordered list of conditional values; first matching condition wins.
- **Condition** — a **named, environment-scoped** targeting rule: a list of clauses
  over `platform` / `appVersion` / custom attributes, ANDed together. Parameters
  reference conditions by id.
- **Version** — an immutable published snapshot of one environment's config, with
  author and timestamp; the version chain is the audit log (research §4.1).

Named, reusable conditions are a deliberate spec-level call — research §4.1 describes
conditions without making them first-class entities. Two grounds. First, the research
pins "mirroring the Firebase model the apps already map onto", and Firebase conditions
*are* named entities defined once and attached to parameters; the console workflow
being migrated from uses them directly, and the dashboard should not regress it.
Second, the audited usage (research §2) is precisely the reuse case: one
platform/version rule shared across seven boolean gates. With inline per-parameter
clauses, retargeting "android ≥ 5.2.0" means editing every gate — the wrong shape for
flipping things fast during an incident. The price — one table, two routes, RESTRICT
semantics, snapshot inlining, rollback upsert rules — is paid explicitly in §3, §8.2,
and §8.4.

Parameters and conditions belong to the environment, not the project — that is what
lets Android and iOS (or prod and staging) diverge freely (research §2). Keys that
should match across environments are a dashboard convenience (copy/promote), not a
schema constraint.

## 3. Storage

SQLite via `bun:sqlite` (research §3.3), queried through Kysely (§3.5). One file,
opened with `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`,
`synchronous = NORMAL`.

### 3.1 Draft vs published

The normalized tables below (projects → conditional values) **are the draft**: the
single mutable working state the admin API edits. Publishing serializes the draft into
a self-contained canonical JSON **snapshot** and appends it to `versions`; the resolve
path reads only snapshots, never draft tables. There is no draft-versioning or
multi-draft machinery — one operator, one working copy, and the diff preview (§8.4)
shows exactly what publish would change. Deleting or editing a draft entity never
touches history: snapshots inline everything they reference, including full condition
definitions, so later edits to a shared condition cannot mutate an already-published
version.

### 3.2 Schema

All ids are UUIDv7 strings (`Bun.randomUUIDv7()`) — sortable, no coordination.
Timestamps are Unix epoch milliseconds (INTEGER). Values are stored JSON-encoded in
TEXT and validated against the parameter's declared type at the API boundary.

```sql
CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,          -- slug: [a-z0-9-]{1,64}
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE environments (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,                 -- "prod" | "staging" | …
  client_key TEXT NOT NULL UNIQUE,          -- "pk_" + 32 chars base62
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, key)
);

CREATE TABLE conditions (
  id             TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  clauses        TEXT NOT NULL,             -- JSON array (§4), zod-validated on write
  updated_at     INTEGER NOT NULL,
  UNIQUE (environment_id, name)
);

CREATE TABLE parameters (
  id             TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  key            TEXT NOT NULL,             -- [a-zA-Z0-9_]{1,64}
  type           TEXT NOT NULL CHECK (type IN ('boolean','string','number','json')),
  default_value  TEXT NOT NULL,             -- JSON-encoded, matches `type`
  description    TEXT,
  updated_at     INTEGER NOT NULL,
  UNIQUE (environment_id, key)
);

CREATE TABLE parameter_conditional_values (
  id           TEXT PRIMARY KEY,
  parameter_id TEXT NOT NULL REFERENCES parameters(id) ON DELETE CASCADE,
  condition_id TEXT NOT NULL REFERENCES conditions(id) ON DELETE RESTRICT,
  value        TEXT NOT NULL,               -- JSON-encoded, matches parameter type
  position     INTEGER NOT NULL,            -- evaluation order within the parameter
  UNIQUE (parameter_id, condition_id),
  UNIQUE (parameter_id, position)           -- order is semantics; collisions are bugs
);

CREATE TABLE versions (
  environment_id    TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL,       -- 1, 2, 3… per environment
  snapshot          TEXT NOT NULL,          -- canonical JSON (§3.3)
  author            TEXT NOT NULL,          -- admin username, captured at publish (§8.1)
  author_account_id TEXT,                   -- no FK: see below
  published_at      INTEGER NOT NULL,
  rollback_of       INTEGER,                -- version this republishes, when rollback
  PRIMARY KEY (environment_id, version),
  FOREIGN KEY (environment_id, rollback_of)
    REFERENCES versions(environment_id, version)
);

CREATE INDEX idx_conditions_env ON conditions(environment_id);
CREATE INDEX idx_parameters_env ON parameters(environment_id);
```

`versions.author` stores the **username as a string copied at publish time**, and
`author_account_id` deliberately carries no foreign key. The version chain is the audit
log (research §4.1) and is append-only (§8.3): a real FK would force either a cascade
that rewrites history when an account is deleted, or a RESTRICT that makes deleting a
departed operator impossible. A copied username keeps attribution readable forever, and
the id stays a best-effort join back to a live account.

### 3.2.1 Admin identity tables

The passkey account model (§8.1). Separate from the config tables above: nothing in the
resolve path reads them, and they are the only tables holding anything credential-like.

```sql
CREATE TABLE admin_accounts (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,        -- [a-z0-9-]{1,32}
  name        TEXT NOT NULL,               -- display name
  created_at  INTEGER NOT NULL,
  disabled_at INTEGER                      -- set → login refused, live sessions die
);

CREATE TABLE admin_credentials (
  id           TEXT PRIMARY KEY,           -- base64url WebAuthn credential id
  account_id   TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
  public_key   BLOB NOT NULL,
  counter      INTEGER NOT NULL,
  transports   TEXT NOT NULL,              -- JSON array of hints
  name         TEXT NOT NULL,              -- operator label: "phone", "laptop"
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE admin_enrollments (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL UNIQUE,        -- sha256 of the single-use enrollment code
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE admin_sessions (
  id         TEXT PRIMARY KEY,             -- UUIDv7; the session token's jti claim
  account_id TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  ip         TEXT,
  user_agent TEXT
);

CREATE TABLE admin_grants (
  account_id TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,                -- §8.1 vocabulary
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, permission)
);

CREATE TABLE admin_audit (
  id         TEXT PRIMARY KEY,
  account_id TEXT,                         -- copied, not FK — as with versions.author
  username   TEXT NOT NULL,
  session_id TEXT,
  method     TEXT NOT NULL,
  path       TEXT NOT NULL,
  status     INTEGER NOT NULL,
  body       TEXT,                          -- request JSON, capped (§8.1)
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_admin_credentials_account ON admin_credentials(account_id);
CREATE INDEX idx_admin_sessions_account ON admin_sessions(account_id);
CREATE INDEX idx_admin_audit_created ON admin_audit(created_at DESC);
```

Nothing here is a secret the server could leak into a useful position: a WebAuthn
public key is public by construction, `admin_sessions` holds no token material at all
(§8.1.4), and enrollment codes are stored only as hashes. That is the property that
makes "SQLite file on one host" an acceptable place for an auth store.

`environments.client_key` is stored plaintext — client keys are public identifiers,
not credentials (research §7), and the dashboard must display them. The `versions`
primary key doubles as the latest-version lookup (`MAX(version)` per environment). No
other read is hot: resolve never touches SQLite after warm-up (§6.4).

Deleting a condition is `RESTRICT`ed while any conditional value references it —
deletion order is explicit, never a silent cascade that changes resolved values. A
conditional value may reference only a condition of its own environment; SQLite
cannot express that FK without denormalizing `environment_id`, so it is a
service-layer invariant checked on every conditional-value write and covered by an
integration test (§10.3).

### 3.3 The snapshot

Canonical JSON per RFC 8785 (JCS): keys sorted by UTF-16 code units (JCS's actual
rule — not code points; the two differ outside the Basic Multilingual Plane), no
insignificant whitespace, shortest-form numbers, minimal escaping. No-op publish detection (§8.3)
and the resolve ETag (§6.4) both hang on byte equality, so the rule is a named spec,
not a serializer habit: one shared `canonicalize()` produces snapshots *and* resolve
response **payloads**, and a contract fixture asserts its exact output bytes (§10.2).
Payload, not body: the §5 envelope wraps the canonical payload and is not itself
canonicalized, which is what keeps a `message` string out of the ETag input (§6.4).

```json
{
  "format": 1,
  "parameters": {
    "enable_enrollment": {
      "type": "boolean",
      "defaultValue": false,
      "conditionalValues": [
        {
          "condition": { "name": "android-5.2+", "clauses": [ … ] },
          "value": true
        }
      ]
    }
  }
}
```

`format` versions the snapshot shape itself: snapshots are stored forever, the clause
vocabulary will grow (typed attributes, percentage rollouts — research §5), and
retrofitting a version field later would change canonical bytes. Evaluation refuses a
format it does not know rather than guessing. Conditions are inlined by value (name +
clauses); parameter order is by key, conditional-value order is the draft's
`position`. The snapshot is the complete input to evaluation — `evaluate(snapshot, context)` is a pure function (§4, §10.2). It is
also deliberately lossy: parameter `description` is draft-only operator metadata,
never client-visible, so editing it neither dirties the diff nor warrants a publish —
and rollback must not destroy it (§8.4).

### 3.4 Diffs — derived, not stored

The research requires each version to carry a diff against its predecessor (§4.1). It
is **derived on read** by structurally comparing adjacent snapshots, not stored:
snapshots are the single source of truth, a derived diff cannot drift from them, and
at this scale (tens of parameters) the comparison is trivial. Diff shape, used by both
`GET …/versions/:n` and the publish preview:

```json
{
  "added":   [ { "key": "…", "after": { … } } ],
  "removed": [ { "key": "…", "before": { … } } ],
  "changed": [ { "key": "…", "before": { … }, "after": { … } } ]
}
```

`before`/`after` are the full snapshot parameter entries, so condition and
conditional-value edits surface as `changed` even when the default is untouched.

### 3.5 Repository seam

All queries live in `src/db/*-repo.ts`, one module per aggregate (`project-repo.ts`,
`environment-repo.ts`, `parameter-repo.ts`, `condition-repo.ts`, `version-repo.ts`),
each exporting a factory that takes a Kysely executor and returns a plain interface
of typed methods. Queries are built with **Kysely** over a small custom dialect
wrapping `bun:sqlite` (`db/kysely.ts`) — the stock SqliteDialect targets
better-sqlite3, and owning the dialect buys two properties: every transaction opens
with `BEGIN IMMEDIATE` (§8.3), and a connection mutex serializes queries on the
single SQLite connection so one request's transaction can never interleave with
another's queries. Migrations are the exception and stay raw SQL on the bare handle:
they run before the query layer exists and their DDL is this spec's §3.2 verbatim.

Services and routes see only the repository interfaces — the promised contained swap
to Postgres (research §3.3) swaps the dialect and schema types and nothing above
them. Multi-statement operations (publish, rollback, conditional-value replacement)
run through `withTransaction` in `db/index.ts`, which hands the callback repositories
bound to the transaction; inside a transaction, all queries must go through those.

## 4. Condition semantics

Evaluation is server-side only (research §3.1) and lives in `service/evaluate.ts` as a
pure function over a snapshot and a **context**:

```ts
interface ResolveContext {
  platform?: string;    // free-form, lowercase by convention: "android", "ios", "web"
  appVersion?: string;  // semver
  clientId?: string;    // reserved for v1.x percentage rollouts (research §4.4)
  attributes: Record<string, string>;
}
```

A **condition** matches when **all** of its clauses match (AND). A **parameter**
resolves to the value of its first matching conditional value in `position` order,
falling back to `defaultValue` — first match wins (research §4.1). Clause schema (zod
at the admin boundary):

```ts
const list = z.array(z.string()).min(1);
const attrName = z.string().min(1).max(64);

const clauseSchema = z.union([
  z.strictObject({ kind: z.literal("platform"), op: z.literal("eq"), value: z.string() }),
  z.strictObject({ kind: z.literal("platform"), op: z.literal("in"), value: list }),
  z.strictObject({
    kind: z.literal("appVersion"),
    op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]),
    value: semverString, // strict semver, validated on write
  }),
  z.strictObject({ kind: z.literal("attribute"), attribute: attrName, op: z.enum(["eq", "neq"]), value: z.string() }),
  z.strictObject({ kind: z.literal("attribute"), attribute: attrName, op: z.enum(["in", "notIn"]), value: list }),
  z.strictObject({ kind: z.literal("attribute"), attribute: attrName, op: z.literal("exists") }),
]);

const clausesSchema = z.array(clauseSchema).min(1);
```

Operator and value shape are validated as pairs — `eq` with a list, `exists` with a
value, or a stray extra field cannot reach the evaluator or get baked into an
immutable snapshot. `clauses` requires at least one clause: a condition that matches
everyone is not a condition, and an accidentally empty array must not silently become
match-all.

Exact matching rules:

- **Missing input never matches.** A clause whose context field is absent (or, for
  `appVersion`, not valid semver) evaluates false — including negated operators
  (`neq`, `notIn`): "not iOS" does not match a context that declared no platform.
  Targeting only ever narrows; an SDK that sends nothing gets pure defaults. This is
  the safe interpretation for feature gates and is trivially portable to the SDK
  contract fixtures.
- **platform** — case-insensitive string equality (`eq`) or membership (`in`).
  Free-form rather than an enum, so a new platform is a client-side decision.
- **appVersion** — semver precedence comparison per the semver spec (prerelease-aware:
  `5.2.0-beta.1 < 5.2.0`). "Enable from 5.2.0" is `gte 5.2.0` (research §4.1). A
  context `appVersion` that is not strict semver (`"5.2"`) never matches any version
  clause — safe, but silent — so the SDK contract must validate `appVersion` at
  configuration time and warn loudly on non-semver input; the failure belongs at the
  integration point, not in resolved defaults nobody can explain.
- **attribute** — string comparison over `attributes[name]`: `eq`/`neq`, list
  membership `in`/`notIn`, and `exists` (any value present; `value` omitted).
  Attributes are strings in v1 (§11).

The engine never throws on malformed context — bad input degrades to non-match. A
snapshot is validated at publish time, so evaluation may assume it is well-formed.

## 5. Wire conventions

### 5.1 The envelope

Every JSON response body — resolve, admin, `/healthz`, and every error — is the same
four-member envelope (research §4.2):

```json
{ "ok": true,  "message": "Resolved 4 parameters", "data": { "…": "…" }, "error": null }
{ "ok": false, "message": "Unknown client key",    "data": null, "error": { "code": "invalid_key" } }
```

- `ok` mirrors `status < 400`; it is redundant with the HTTP status **on purpose**,
  because the one client that matters most (an SDK behind a transport it does not own)
  should not have to trust an intermediary's status rewriting to know what it holds.
- `message` is human-facing and **not a contract**: it is for logs, curl, and dashboard
  toasts. Nothing may branch on it, no fixture asserts it, and no cache validator is
  derived from it (§6.4).
- `data` carries the payload and is `null` on failure. The resolve payload is exactly
  the research's `{ values, version }` (§6.3), now one level down.
- `error` is `null` on success and otherwise `{ code, details? }`. `code` is the stable
  machine-readable slug clients branch on (`not_found`, `invalid_key`,
  `validation_failed`, `publish_conflict`, `nothing_to_publish`, `unauthorized`,
  `forbidden`, …); `details` carries zod's treeified issues on validation failures.

The code lives in `error.code` rather than beside `message` at the top level: an error
is one object a client can pass around whole, and success bodies keep a `null` there
instead of an absent member, so the envelope has exactly four keys in every response.

Two deliberate exemptions, both because they are not JSON response bodies:

- **`304 Not Modified`** has no body at all (§6.4) — an envelope on a 304 would violate
  HTTP and defeat the point of the validator.
- **SSE frames** (§7) are event data, not responses: `data: {"version":42}` stays
  exactly as it is. Wrapping a nudge would put a `message` string on the hot push path
  and force every SDK to unwrap a frame whose entire content is one integer.

### 5.2 Errors and validation

- A `LeverError extends Error { statusCode, code, details? }` thrown anywhere is mapped
  by `app.onError` into the §5.1 failure envelope; anything else logs and returns a 500
  whose `message` is generic and whose `code` is `internal_error`.
- All request bodies, query params, and path params are zod-validated via a `zValidator`
  wrapper that renders failures as `400 validation_failed` with treeified issues in
  `error.details`.

### 5.3 CORS

The dashboard now runs on its own origin (§9.4), so **both** surfaces answer
cross-origin browsers — with different allowlists, because they are different trust
tiers:

- **Read surface** (`/v1/resolve`, `/v1/stream`): origins from `LEVER_ALLOWED_ORIGINS`,
  default `*` — resolved values are public by design (research §3.4). Sends
  `Access-Control-Expose-Headers: ETag`; without it browsers hide the ETag from
  cross-origin JS and the 304 path silently degrades to full refetches.
- **Admin surface** (`/v1/admin`): origins from `LEVER_ADMIN_ORIGINS`, which has **no
  default and rejects `*`** at boot (§9.1). An authenticated surface that echoes any
  origin is how a hostile page reaches an operator's session, and a required var makes
  the operator name their portal rather than inherit a permissive default. Allowed
  headers are `Authorization` and `Content-Type`; allowed methods `GET`, `POST`,
  `PATCH`, `PUT`, `DELETE`, `OPTIONS`; preflights cached 24 h.

`Access-Control-Allow-Credentials` is **not** set on either surface, and cannot be
needed: the admin session travels as a bearer token in `Authorization`, never a cookie
(§8.1). No cookie means no cross-site cookie semantics and no CSRF surface — a
cross-origin page can send a request but has no way to make the browser attach the
operator's credential to it.

`GET /healthz` returns `data: { "name": "lever", "version": "…" }` for container
healthchecks, which only read the status code.

## 6. `GET /v1/resolve`

The hot path (research §4.2).

### 6.1 Auth

The environment's client key, sent as `Authorization: Bearer pk_…` or, as a fallback
for `EventSource`-style clients that cannot set headers, `?key=pk_…` (shared with
§7). An unknown key is a `401` whose `error.code` is `invalid_key`. Client keys authorize exactly
this read surface — resolve and stream for one environment (research §7).

### 6.2 Request

Context arrives as query parameters: the reserved names `platform`, `appVersion`,
`clientId`, and `key`, plus custom attributes carried as `attr.<name>=<value>`. The
prefix keeps the attribute namespace disjoint from reserved names forever — a future
reserved parameter (`locale`, `sdkVersion`, …) can never shadow someone's custom
attribute. Unprefixed unrecognized parameters are ignored (forward compatibility).
One value per name (repeats take the first). Input limits, enforced before evaluation
with a 400: at most 20 attributes, attribute names ≤ 64 chars, values ≤ 256 chars,
`platform`, `appVersion`, and `clientId` ≤ 64 chars — the client key is public, so
the resolve input surface is bounded. No parameter is required — an empty context resolves every
parameter to its default (§4).

### 6.3 Response

```json
{
  "ok": true,
  "message": "Resolved 2 parameters",
  "data": {
    "version": 42,
    "values": {
      "enable_enrollment": { "type": "boolean", "value": true },
      "captcha_site_key":  { "type": "string",  "value": "…" }
    }
  },
  "error": null
}
```

`data` is the canonical payload (§3.3) — the envelope around it is not canonicalized
(§5.1). Values carry their declared types so SDK getters can be strict without a schema
exchange (research §4.2). An environment with no published version resolves with `data`
of `{ "version": 0, "values": {} }` — the SDK's code-default floor covers it (research
§4.4).

SDKs decode the envelope first and treat a malformed or `ok: false` body as a fetch
failure, falling back to the previous snapshot (research §4.4) — never as an empty
`values` map, which would silently resolve every key to its code default while the
server was in fact reachable and healthy.

### 6.4 ETag and the in-process cache

- **ETag** is a strong validator: `"<sha256 hex, first 16 chars>"` over the exact
  canonical response **payload** — the `data` member, not the envelope (§5.1), so the
  validator is a function of resolved config alone and no wording change to `message`
  can ever invalidate a client's cache. The payload already includes the version, so a
  publish always changes the ETag even if resolved values happen to coincide for this
  context.
  `If-None-Match` containing the current ETag (any member of the list) returns `304`
  with the `ETag` header and no body. `Cache-Control: private, no-cache` — clients
  always revalidate; the 304 is the cheap common case (research §3.1).
- **Cache**: `service/resolve-cache.ts` holds two maps warmed at boot: an auth index
  `clientKey → environmentId` built from `environments`, and `environmentId →
  CompiledEnv` — the latest snapshot with semver operands pre-parsed, or an explicit
  version-0 empty entry for a never-published environment, so a valid key always
  resolves per §6.3 instead of falling through to 401. Every admin mutation that
  touches them updates them in one code path: environment create/delete adds/removes
  both entries (delete also closes the environment's streams, §7); key rotation
  re-keys the auth index atomically, so the old key 401s immediately; publish and
  rollback swap the compiled entry after commit. Resolve therefore performs zero I/O:
  two map lookups → pure evaluation → serialization — allocation-only, per research
  §3.3.

## 7. `GET /v1/stream`

SSE nudges (research §3.2, §4.3). Same client-key auth as §6.1. Event frames are exempt
from the §5.1 envelope — they are event data, not response bodies; only the errors that
refuse a connection (401, 503) carry it, since those are ordinary JSON responses.

- **On connect**: register the subscriber in the registry **first**, then read and
  emit the current published version — `event: version` / `data: {"version":42}`
  (version `0` when nothing is published) — catching up whatever was missed while
  backgrounded (research §4.3). The ordering is load-bearing: emit-then-register
  would let a publish land in the gap and nudge a set this subscriber is not in yet —
  a lost update the client would not notice until its next min-interval poll. The
  worst case of register-first is a duplicate nudge, which the SDK's version dedupe
  absorbs; the interleaving has its own test (§10.3). The first frame carries a
  `retry: 15000` hint for `EventSource` clients; native SDKs keep their own jittered
  backoff (research §3.2).
- **On publish or rollback**, broadcast the same event with the new version number to
  every subscriber of that environment. **Version numbers only, never values**
  (research §3.2) — the SDK reacts with its normal fetch-and-activate.
- **Heartbeat**: a comment frame (`: hb`) every 25 s, from one process-wide interval
  walking all subscribers — keeps Cloudflare's ~100 s idle cutoff and mobile-carrier
  NAT from killing the stream (research §3.2). Writes never await one subscriber
  before dispatching to the next, and a write that fails or exceeds a short timeout
  drops that subscriber — one backpressured socket must not stall heartbeats past the
  cutoff for everyone else.
- **Registry**: `service/stream.ts` holds `Map<environmentId, Set<Subscriber>>` where
  a subscriber wraps the SSE stream writer. A subscriber is removed when the request
  aborts or **any write fails** (heartbeat or nudge) — a failed write is the
  disconnect signal; the dead stream is closed and dropped so the registry cannot
  accumulate zombies. Deleting an environment or rotating its key closes and drops
  all of its subscribers — a revoked key must not hold a live stream.
  `SSE_MAX_SUBSCRIBERS` (default 2000) caps the registry; past it, connect returns
  `503` with `Retry-After` and the SDK's min-interval polling carries the load — the
  poll-fallback blast-radius cap the research names (§7), made concrete. Response
  headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
  `X-Accel-Buffering: no`.
- No replay/`Last-Event-ID` machinery: the connect-time emission plus the SDK's dedupe
  ("already at N → ignore", research §3.2) make the stream stateless. The dedupe
  contract is **identity, not ordering**: the wire version is an opaque change token —
  the SDK fetches whenever the announced version *differs* from its **last known**
  one — the version of the newest successfully fetched representation it holds,
  staged or activated (with activation deferred, a fetched-but-unactivated version
  already suppresses repeat nudges) — and updates its own notion of current only
  from fetch responses, never from nudge frames. Equality (not `≤`) keeps clients self-healing when the sequence is not
  monotonic — a database restored from backup, an environment deleted and recreated —
  and prices any stale or duplicate frame (including the connect interleaving above)
  at exactly one fetch that 304s.
- Subscriber count per environment is exposed in logs on connect/disconnect — the
  research names connection volume as the first metric to watch (§7).

## 8. Admin surface — `/v1/admin`

REST first; the dashboard is a client of this API (research §4.5).

### 8.1 Auth — passkey accounts

Admin auth is a WebAuthn login against an account row, yielding a revocable server-side
session (research §4.5). `@simplewebauthn/server` does the cryptography; §3.2.1 holds
the tables. Client keys can never reach `/v1/admin` — they are not in any of them.

#### 8.1.1 Relying party

WebAuthn credentials are bound to the **dashboard's** domain, not the API's, because the
dashboard is what the browser has loaded (§9.4):

- `LEVER_WEBAUTHN_RP_ID` — the portal's registrable domain (`lever.example.dev`).
- `LEVER_WEBAUTHN_ORIGINS` — comma-separated origins accepted as `expectedOrigin`
  (the portal, plus a localhost origin in development).
- `LEVER_WEBAUTHN_RP_NAME` — display name in the platform prompt; defaults to `Lever`.

This is the one piece of configuration where getting it wrong is unrecoverable rather
than merely broken: credentials registered under one RP id are unusable under another,
so **moving the portal to a new domain invalidates every passkey** and requires the
offline enrollment path (§8.1.2). Boot validation rejects an `LEVER_WEBAUTHN_RP_ID` that
is not a suffix of every configured origin's host, which catches the common
misconfiguration — pointing the RP id at the API's domain — at startup instead of at the
first login attempt.

#### 8.1.2 Enrollment

Credentials are created by redeeming a single-use **enrollment code**: 32 base62 chars,
displayed once, stored only as a SHA-256 hash, expiring in 15 minutes
(`admin_enrollments`). Three producers, one redemption path:

- `bun run --cwd apps/api admin:enroll <username> [--name "…"]` — a CLI against the
  database file. It creates the account if absent, granting it the full permission set,
  and prints a code; run against an existing username it just mints another code. This
  is both the **bootstrap** — the answer to "there are no admins yet, so nobody can
  authorize one" — and the **recovery** path research §7 requires for the day every
  credential is lost. It works with the service running or stopped, does not go through
  `getEnv()` (recovery must not depend on the WebAuthn variables being right, which is
  exactly what may be broken when it is needed), and takes no auth: filesystem access to
  the database *is* the authorization, since anything it refused could be done with
  `sqlite3` and one `UPDATE`.
- `POST /accounts` — creating an account mints its first code.
- `POST /accounts/:id/enrollments` — mints another, for a second device. Registering a
  spare credential is the expected steady state, not an edge case.

Redemption is `POST /auth/register/options` (body `{ code }`) then
`POST /auth/register/verify` (body `{ code, credentialName, response }`), which stores
the credential, marks the code consumed, and returns a session (§8.1.4) so enrollment
does not end with an immediate second prompt. `excludeCredentials` lists the account's
existing credentials so the same authenticator cannot be registered twice. Codes are
never written to the audit log (§8.1.6).

#### 8.1.3 Login ceremony

- `POST /auth/login/options` — body `{ username? }`. Returns authentication options with
  `userVerification: "required"`; the challenge is held in process with a 5-minute TTL,
  single-use, tagged `login` so it can never be replayed into a registration. When a
  `username` is supplied and known, `allowCredentials` lists its credentials. **The
  response is identical in shape and status whether or not the username exists** — this
  endpoint is pre-assertion and must not become an oracle for who holds admin access.
- `POST /auth/login/verify` — body `{ challengeId, response }`. Verifies the assertion,
  bumps the stored signature counter and `last_used_at`, and issues a session.

Every failure — unknown credential, bad assertion, disabled account, an account with
zero grants — returns the same `401` with `error.code: "unauthorized"` and a fixed
message. Distinguishing them would leak exactly what the generic response protects.

There is no login throttle. A WebAuthn assertion cannot be guessed at all, and an
enrollment code is ~190 bits behind a 15-minute single-use window; per-IP throttling
behind a tunnel would buy proxy-attribution complexity for nothing. Failures log at
`warn`.

#### 8.1.4 Sessions

A session is a **signed JWT** (HS256) whose `sub` is the account and whose `jti`
is the id of a row in `admin_sessions`. Requests send `Authorization: Bearer <jwt>`.
Claims are pinned to an issuer and an admin audience, so a token minted for anything
else fails verification rather than being merely ignored.

The signature and the row do different jobs, and both are checked on every request.
The signature makes the token self-describing and cheap to reject when it is
forged, expired, or foreign. The row is what makes revocation **instant**: logout,
a disabled account, or an admin closing someone's device all take effect on the
next request, which a signature-only design cannot do without waiting out the
expiry. No token material is stored — the row holds no secret, so a database read
cannot yield a usable credential.

`LEVER_JWT_SECRET` (§9.1) signs them. HS256 over one secret rather than an
asymmetric keypair: lever issues and verifies inside the same process, so a public
key has no second consumer to serve, and a JWK is one more thing for a self-hoster
to generate, rotate, and mis-paste. Rotating the secret invalidates every live
session, which is the intended break-glass behaviour. The algorithm choice is
contained in `service/tokens.ts`.

Per request, `adminAuth` verifies the token, loads the session by its `jti`, and
refuses with the generic `401` unless the row is unexpired and unrevoked, its
account id matches the token's `sub`, that account exists and is not disabled, and
it resolves to **at least one grant**. Grants are read live, never carried as a
claim, so a revoked permission applies on the next request with no re-login — and
an account stripped of every grant is no longer an admin.

Expiry is `LEVER_ADMIN_SESSION_HOURS` (default 8) from issue, and does **not**
slide: re-authenticating is a biometric prompt, cheap enough that extending a
session on activity is not worth the weaker bound. `POST /auth/logout` revokes the
calling session; `DELETE /sessions/:id` revokes another; disabling or deleting an
account kills all of its sessions. Rows past expiry are swept at boot after 30
days, staying joinable from audit rows in the meantime.

`GET /auth/session` returns the current account, its live grants, and the session
expiry — what the portal calls on load to decide between the dashboard and the
login screen.

#### 8.1.5 Permissions

Five slugs, gated per route by a `requirePermission` middleware:

| Permission | Covers |
| --- | --- |
| `config:read` | every `GET` on the config surface (§8.2, §8.5) |
| `config:write` | draft edits: parameters, conditions, conditional values, project/environment create and rename |
| `config:publish` | publish and rollback (§8.3, §8.4) |
| `config:admin` | project/environment `DELETE` and client-key rotation |
| `accounts:manage` | the §8.1 identity surface: accounts, enrollments, grants, sessions |

The split follows blast radius, not CRUD shape. `config:write` only ever changes a draft
nobody is serving (§3.1); `config:publish` changes what every client resolves;
`config:admin` covers the two acts that break live clients or destroy an audit log —
deleting an environment and rotating its key. `accounts:manage` is separate because it
is the permission that can grant permissions.

`POST /accounts/:id/grants` replaces an account's grant set wholesale, for the same
reason conditional values are written as a list (§8.2): a partial grant edit invites a
half-applied permission change. An account may not remove its own `accounts:manage`
grant, and the last account holding it may not be deleted or disabled — the check runs
inside the same transaction as the write, so two concurrent requests cannot strip the
last one between them. Locking every operator out of their own config service is a
mistake the API declines to help with.

#### 8.1.6 Audit

`adminAudit` middleware records every non-`GET` request under `/v1/admin` to
`admin_audit` after the handler runs: account id and username (copied, per §3.2), session
id, method, path, response status, and the JSON request body when it is
`application/json` and under 16 KB. Write failures log and never fail the request —
availability over completeness, and the request logger keeps the trace either way.

Bodies under `/v1/admin/auth/*` and `/accounts/:id/enrollments` are recorded as `null`:
those carry enrollment codes and WebAuthn material, and an audit log that captures
credentials is a liability rather than a record. Method, path, and status are still
recorded, so "someone enrolled a credential at 03:12" remains visible.

The version chain already audits config *content* (research §4.1); this table covers
what the chain cannot see — failed writes, deletions, key rotations, and every change to
who can do any of it.

#### 8.1.7 Why this shape

The previous design was a list of static `name:secret` tokens in an env var, justified
by "a user table and session machinery would be the largest subsystem in the service,
serving one or two humans." Two things overturned it. The dashboard moved to its own
domain (§9.4), so that shared secret would have to be pasted into a browser on an origin
the API does not control and kept there indefinitely — a long-lived bearer credential in
the worst possible place. And passkeys make the account model cheap in exactly the
dimension that argument was about: no password hashing, no reset flow, no email
delivery, no credential-strength policy. What remains is four small tables and one
middleware, and it buys revocation without a restart, per-operator attribution that
survives a shared password manager, and a phishing-resistant login on the phone where
the incident-time gate flip actually happens (research §4.5).

### 8.2 CRUD routes

Standard shapes, all zod-validated, all returning the §5 conventions, all behind
`adminAuth` (§8.1.4) and the permission named per method:

| Route | Methods | Permission |
| --- | --- | --- |
| `/projects` | `GET` list, `POST` create | read / write |
| `/projects/:projectId` | `GET`, `PATCH` (name), `DELETE` | read / write / **admin** |
| `/projects/:projectId/environments` | `GET`, `POST` (key; client key generated server-side) | read / write |
| `/environments/:envId` | `GET` (incl. client key, latest version, dirty flag), `DELETE` | read / **admin** |
| `/environments/:envId/rotate-key` | `POST` — new `pk_…`, old key invalid immediately | **admin** |
| `/environments/:envId/conditions` | `GET`, `POST` (name + clauses) | read / write |
| `/conditions/:conditionId` | `PATCH`, `DELETE` (409 while referenced — §3.2 RESTRICT) | write |
| `/environments/:envId/parameters` | `GET`, `POST` (key, type, defaultValue, description) | read / write |
| `/parameters/:parameterId` | `GET`, `PATCH`, `DELETE` | read / write |
| `/parameters/:parameterId/conditional-values` | `PUT` — replaces the full ordered list `[{conditionId, value}]` | write |

The identity surface (§8.1), on the same conventions. Only `/auth/*` is unauthenticated
— it is how a session is obtained in the first place:

| Route | Methods | Permission |
| --- | --- | --- |
| `/auth/register/options`, `/auth/register/verify` | `POST` | — (enrollment code) |
| `/auth/login/options`, `/auth/login/verify` | `POST` | — |
| `/auth/session` | `GET` — current account, grants, expiry | any grant |
| `/auth/logout` | `POST` — revokes the calling session | any grant |
| `/accounts` | `GET`, `POST` (creates the account and its first enrollment code) | `accounts:manage` |
| `/accounts/:id` | `GET`, `PATCH` (name, disabled), `DELETE` | `accounts:manage` |
| `/accounts/:id/enrollments` | `POST` — mint a code for another credential | `accounts:manage` |
| `/accounts/:id/credentials` | `GET`, and `DELETE /credentials/:credId` | `accounts:manage` |
| `/accounts/:id/grants` | `PUT` — replaces the grant set (§8.1.5) | `accounts:manage` |
| `/accounts/:id/sessions` | `GET`, and `DELETE /sessions/:sessionId` | `accounts:manage` |

Successful `DELETE`s answer `200` with `data: null` rather than `204`. A bare 204 has
no body, and the §5.1 envelope is the whole point of having one dialect — a client
that unwraps every response should not need a special case for the one verb that
returns nothing.

Conditional values are written as a whole ordered list rather than item-by-item:
ordering is first-match-wins semantics (§4), so partial reorders are a footgun the API
refuses to offer. The server assigns `position` 0…n−1 from list order and validates
that every `conditionId` belongs to the parameter's environment (§3.2). Changing a
parameter's `type` revalidates its default and every conditional value against the
new type in one transaction, or rejects.

`DELETE` on a project or environment requires the entity's key echoed in the body
(`{ "confirm": "prod" }`): it cascades away the version chain — that environment's
audit log. This is deliberate (history is scoped to the environment it audits and
dies with it), but it must never happen from a mis-aimed request. Deleting an
environment also closes its stream subscribers and evicts both cache entries (§6.4,
§7), as does key rotation.

The no-secrets invariant (research §3.4) surfaces here, not only in end-user docs:
the parameter endpoints' API documentation and the dashboard's value editors carry
the warning that resolved values are readable by every end user.

Draft edits never touch `versions` or the resolve cache — clients see nothing until
publish (§3.1).

### 8.3 Publish

- `GET /environments/:envId/diff` — the publish preview: builds the would-be snapshot
  from the draft and returns the §3.4 diff against the latest version (everything
  `added` when no version exists), plus `{ draftDirty: boolean }`.
- `POST /environments/:envId/publish` — body `{ expectedVersion?: number }`. In one
  transaction — `BEGIN IMMEDIATE`, as for rollback: taking the write lock up front
  avoids the DEFERRED read→write upgrade that fails mid-transaction under WAL —
  build + canonicalize the snapshot, reject `409 publish_conflict` if
  `expectedVersion` was given and no longer matches the latest (two dashboards racing),
  reject `409 nothing_to_publish` if the snapshot is byte-identical to the latest,
  insert version `N+1` with the timestamp and the authenticated account's username and
  id as `author` / `author_account_id` (§3.2). A busy error or versions-PK
  collision from a concurrent publish also maps to `409 publish_conflict`, never a
  500. After commit: swap the resolve-cache entry, then broadcast the SSE nudge.
  Returns the new version with its diff.

Versions are append-only: no route updates or deletes a row in `versions`, and the
repository seam exposes no mutation for them — immutability is enforced by
construction and covered by tests (§10.3).

### 8.4 Rollback

`POST /environments/:envId/versions/:n/rollback` — republishes version `n` as a new
version (research §4.1): in one `BEGIN IMMEDIATE` transaction, **rewrite the draft**
to match snapshot `n`, then publish it as version `N+1` with `rollback_of = n`.
Resetting the draft is deliberate — leaving a divergent draft behind would resurrect
the rolled-back state on the next casual publish, which is exactly the wrong surprise
mid-incident. Because snapshots are deliberately lossy (§3.3), the rewrite is a
key-matched upsert, not a wipe: parameters present in the snapshot keep their row ids
and descriptions; snapshot conditions upsert by name; parameters absent from the
snapshot are deleted; conditions the snapshot never references are left untouched —
they carry no weight in resolution, and destroying the operator's condition library
would make rollback destructive. Conditional values are replaced wholesale (no
condition rows are deleted, keeping clear of the RESTRICT FK). Rollback skips the
`nothing_to_publish` check: rolling back to the currently live version is the
legitimate "reset a diverged draft to what's running" move, and the duplicate
snapshot it appends is itself audit-worthy. History is untouched; the rollback is one
more link in the chain.

### 8.5 Versions

- `GET /environments/:envId/versions` — descending list: `version`, `author`,
  `publishedAt`, `rollbackOf`, diff summary (counts).
- `GET /environments/:envId/versions/:n` — full snapshot plus the derived diff against
  `n-1`.

## 9. Cross-cutting

### 9.1 Environment config

`env.ts`, zod-parsed at boot; invalid config logs the treeified issues and exits:

```ts
const envVarsSchema = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_PATH: z.string().default("./data/lever.db"),
  LEVER_ALLOWED_ORIGINS: z.string().default("*"),      // CORS for /v1 reads (§5.3)
  LEVER_ADMIN_ORIGINS: z.string(),                     // CORS for /v1/admin — required, no "*"
  LEVER_WEBAUTHN_RP_ID: z.string(),                    // the portal's domain (§8.1.1)
  LEVER_WEBAUTHN_ORIGINS: z.string(),                  // accepted assertion origins
  LEVER_WEBAUTHN_RP_NAME: z.string().default("Lever"),
  LEVER_ADMIN_SESSION_HOURS: z.coerce.number().positive().default(8),
  LEVER_JWT_SECRET: z.string().min(32),                // signs session JWTs (§8.1.4)
  SSE_HEARTBEAT_MS: z.coerce.number().default(25_000),
  SSE_MAX_SUBSCRIBERS: z.coerce.number().default(2_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});
```

Five of these are required with no default, and that is the point: each names a domain
or a secret the operator alone knows, and every plausible default is wrong in a way
that fails late. `LEVER_ADMIN_ORIGINS` additionally **rejects `*`** (§5.3), origin
lists must be bare `scheme://host[:port]` values, and `LEVER_WEBAUTHN_RP_ID` is
cross-checked as a suffix of every `LEVER_WEBAUTHN_ORIGINS` host (§8.1.1) — each
refuses to boot rather than starting a service whose auth is quietly wrong.

`LEVER_ADMIN_TOKENS` is **gone**, along with its parser. Any deployment still setting it
is running the old auth model, so boot fails with a message pointing at
`bun run admin:enroll` (§8.1.2) rather than silently ignoring it and leaving the
operator with no way in.

`getEnv()` builds and caches the registry: parsed vars, the opened database,
repositories, and constructed services — the composition root, per the reference
idiom.

### 9.2 Logging

Structured JSON logs (LogLayer over pino, matching the reference stack), with a
per-request child logger bound via `AsyncLocalStorage` so every log line in a request
shares its context (request id, environment id once authenticated). Resolve logs at
`debug` only — it is the hot path. Publish, rollback, key rotation, auth failures, and
stream connect/disconnect log at `info`. No OTel: single node, `docker logs` is the
observability story; the seam to add a transport later is `logger.ts`.

### 9.3 Migrations

Numbered TypeScript modules in `src/db/migrations/` (`0001-init.ts` for §3.2,
`0002-admin-identity.ts` for §3.2.1, …), each
exporting `up(db)` running raw SQL; applied in filename order inside a transaction and
recorded in a `migrations` table. They run **automatically at boot** before the server
listens — single-node SQLite has no coordination problem, and a container that starts
is a container whose schema is current. No down migrations: the rollback story for a
one-file database is the backup taken before upgrading — made with `VACUUM INTO` (or
`sqlite3 .backup`), never a bare `cp`: copying a live WAL database races its
checkpointer. A `bun run migrate` script exists for running them against a copy.

### 9.4 Docker

One image (research §4.6), mirroring the reference multi-stage shape: `oven/bun` deps
stage (`bun install --frozen-lockfile --production`) → slim runtime stage running
`bun run src/index.ts` as the non-root `bun` user. `DATABASE_PATH` points into a
mounted volume (`/data`); `HEALTHCHECK` hits `/healthz`. Deployment examples stay
generic (a volume, a port, a tunnel in front); no personal infrastructure specifics.

The image serves **the API only**. `apps/admin` is a static SPA with its own build and
its own deployment at its own domain (research §4.6) — any static host will do, and its
spec picks one. Nothing in this container references `apps/admin`, and the two ship
independently: a dashboard release does not restart the service every project depends
on. What couples them is configuration, not packaging — the portal's origin appears here
as `LEVER_ADMIN_ORIGINS` and `LEVER_WEBAUTHN_ORIGINS`, and its domain as
`LEVER_WEBAUTHN_RP_ID` (§9.1). The portal, in turn, is built against the API's base URL.

The service is **single-process by design**: the resolve cache (§6.4) and the SSE
registry (§7) live in process memory, so a second replica would serve stale snapshots
and nudge only its own subscribers. Run exactly one container. If multi-node ever
happens, `resolve-cache.ts` and `stream.ts` are the seam, alongside the §3.5
repository swap the research reserves (§3.3).

### 9.5 Formatting, linting, workspace scripts

oxlint + oxfmt via the root `check`/`fix`/`fmt`/`lint` scripts, wired in the same
change that adds the first code (per CLAUDE.md). `bun test` at the workspace root runs
all suites.

## 10. Testing

`bun test` throughout; integration tests open `:memory:` SQLite through the same
migration runner and drive the real Hono app via `app.request()` — no network, no
mocks of our own layers.

### 10.1 Evaluation unit tests

`service/evaluate.ts` is pure; tests cover every operator, first-match-wins ordering,
AND-of-clauses, missing-context non-match (including `neq`/`notIn`), semver edges
(prerelease ordering, invalid appVersion), and type-tagged output.

### 10.2 Contract fixtures

`packages/contract-fixtures` holds the research §7 fixture set: JSON files of
`{ snapshot, context, expected: { values, … } }` cases. The server's evaluation tests
are **generated from these fixtures**, and the same files later drive the TypeScript,
Kotlin, and Swift SDK test suites — same inputs, same resolved values, one definition
of correct. Fixtures are data-only so every language can consume them verbatim. Server
behavior fixtures (ETag stability, 304, empty-context defaults) live alongside as HTTP
cases keyed by canonical response **payloads**, including a canonicalization case that
pins `canonicalize()`'s exact output bytes (§3.3). The recorded `response.body` is the
full §5.1 envelope an SDK actually receives, captured verbatim: resolve's `message` is a
single constant, so a faithful recording needs no normalization step. It remains
non-contractual — SDKs decode and ignore it (spec 0002), and no replay may assert it.

### 10.3 Integration coverage (minimum bar)

- **Resolve round-trip**: create → publish → resolve with contexts from the fixtures;
  ETag returned; `If-None-Match` → 304; new publish → new ETag and new version; a
  valid key for a never-published environment gets `{ version: 0, values: {} }`, not
  401.
- **Publish immutability**: publish v1, edit draft, publish v2 → v1's snapshot row is
  byte-identical to before; editing a shared condition after publish leaves every
  existing snapshot unchanged; version list is append-only across rollback.
- **Rollback**: publish v1, v2, rollback to v1 → v3 exists with `rollback_of = 1`,
  resolves like v1, the draft matches v1, and parameter descriptions plus
  unreferenced conditions survive the rewrite (§8.4); rollback to the currently live
  version succeeds.
- **Publish conflict**: stale `expectedVersion` → 409; identical snapshot → 409;
  concurrent publishes → one wins, one 409, never a 500.
- **Draft integrity**: a conditional value referencing another environment's
  condition is rejected (§3.2); `PUT` conditional values re-orders deterministically.
- **Stream**: connect → receive current version; publish → receive nudge with the new
  version; a publish interleaved between registration and the connect emission is not
  lost (§7 ordering); environment delete and key rotation close the stream;
  disconnect removes the subscriber (registry observably empty).
- **Client-key auth**: a client key cannot reach `/v1/admin`; wrong/rotated key → 401
  on resolve and stream.
- **Admin auth**: a full ceremony over a WebAuthn double — enroll with a code, log in,
  call an admin route; the code is single-use and expires; a login challenge cannot be
  replayed as a registration challenge; `/auth/login/options` answers identically for a
  known and an unknown username (§8.1.3); every failure mode returns the same generic
  401 body.
- **Sessions**: an expired, revoked, or unknown token → 401; logout revokes exactly the
  calling session; disabling an account kills its live sessions on the next request; a
  grant revoked mid-session takes effect on the next request with no re-login.
- **Permissions**: each route rejects the permission one level below it (a `config:write`
  holder gets 403 on publish, a `config:publish` holder gets 403 on key rotation); an
  account cannot drop its own `accounts:manage`, and the last holder cannot be deleted
  or disabled, including under two concurrent requests.
- **Audit**: a mutating admin request writes exactly one row with the account, path, and
  response status; a failed (4xx) write is recorded too; `/auth/*` and enrollment bodies
  are stored as `null` (§8.1.6); an audit write failure does not fail the request.
- **Envelope**: every JSON response on both surfaces has exactly the four §5.1 members;
  a 304 has an empty body; SSE frames are unwrapped; the resolve ETag is unchanged by a
  differing `message`.
- **CORS**: a `/v1/admin` preflight from a listed origin succeeds and from an unlisted
  one does not; no response on either surface sets
  `Access-Control-Allow-Credentials`; boot refuses `LEVER_ADMIN_ORIGINS=*` and an
  RP id that does not match the configured origins (§8.1.1).

## 11. Open questions

- **Typed custom attributes.** v1 compares attributes as strings; numeric operators
  (`gte` over an integer attribute) are deferred until a real consumer needs them.
- **Environment promotion.** "Copy staging's draft to prod" is a likely dashboard
  affordance; whether it is a server endpoint or a dashboard-side compose over the
  CRUD API is left to the dashboard spec.
- **Key rotation grace.** Rotation invalidates the old key immediately (§8.2). A
  two-active-keys grace window is easy to add later if fleet rollout ever needs it;
  the SDK floor (research §4.4) means a stale key degrades to cached values, not a
  broken app, so v1 keeps the simple rule.
- **Version retention.** Versions are kept forever — at this scale they are tiny and
  they *are* the audit log. Revisit only if a pathological publisher appears.
- **Audit retention.** `admin_audit` grows without bound and, unlike versions, is not
  content-addressed — a busy dashboard session writes a row per click. No pruning in
  v1; the first real growth measurement decides between a retention window and leaving
  it alone.
- **Portal domain migration.** Changing `LEVER_WEBAUTHN_RP_ID` invalidates every
  credential (§8.1.1). The offline `admin:enroll` path makes it survivable but manual.
  Whether to support a second accepted RP id for a cutover window is deferred until a
  move is actually on the table.
- **Machine access to `/v1/admin`.** Passkeys are a human ceremony; a CI job that wants
  to publish has no path today beyond driving a session by hand. Scoped, non-expiring
  service tokens issued *by* an account (and revocable per §8.1.4) are the obvious
  shape, but no consumer needs one yet — and adding them before there is a consumer
  would recreate the static-secret model this spec just retired.
