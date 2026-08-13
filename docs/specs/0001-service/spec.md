# Spec 0001 — The service

- **Status:** draft
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
    admin/              # dashboard SPA (later spec; served by the api container, §9.4)
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
    api/
      index.ts          # createHono, typed context, error helpers, zValidator wrapper
      middleware.ts     # clientKeyAuth, adminAuth
      resolve.ts        # GET /v1/resolve
      stream.ts         # GET /v1/stream
      admin/            # /v1/admin/* route modules (projects, environments,
                        #   parameters, conditions, versions)
    service/
      evaluate.ts       # pure rule evaluation (snapshot + context → values)
      resolve-cache.ts  # in-process compiled-snapshot cache (§6.4)
      publish.ts        # snapshot build, diff, publish, rollback
      stream.ts         # SSE subscriber registry, broadcast, heartbeat
      admin/            # CRUD services over the repositories
    db/
      index.ts          # openDb: bun:sqlite handle, pragmas, migration runner
      migrations/       # 0001-init.ts, … (§9.3)
      *-repo.ts         # repository seam (§3.4)
  Dockerfile
```

Routes bind to services, services depend on repositories, repositories own SQL. Env
follows the reference idiom: a zod-parsed `envVarsSchema` plus a lazily built, cached
registry (`getEnv()`) of constructed services, injected into Hono's `Bindings`.

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

SQLite via `bun:sqlite` (research §3.3). One file, opened with `journal_mode = WAL`,
`foreign_keys = ON`, `busy_timeout = 5000`, `synchronous = NORMAL`.

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
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,          -- 1, 2, 3… per environment
  snapshot       TEXT NOT NULL,             -- canonical JSON (§3.3)
  author         TEXT NOT NULL,             -- admin token name (§8.1)
  published_at   INTEGER NOT NULL,
  rollback_of    INTEGER,                   -- version this republishes, when rollback
  PRIMARY KEY (environment_id, version),
  FOREIGN KEY (environment_id, rollback_of)
    REFERENCES versions(environment_id, version)
);

CREATE INDEX idx_conditions_env ON conditions(environment_id);
CREATE INDEX idx_parameters_env ON parameters(environment_id);
```

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
response bodies, and a contract fixture asserts its exact output bytes (§10.2).

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

All SQL lives in `src/db/*-repo.ts`, one module per aggregate (`project-repo.ts`,
`environment-repo.ts`, `parameter-repo.ts`, `condition-repo.ts`, `version-repo.ts`),
each exporting a factory that takes the `bun:sqlite` handle and returns a plain
interface of typed methods. Services and routes see only these interfaces — the
promised contained swap to Postgres (research §3.3) reimplements the factories and
nothing above them. Multi-statement operations (publish, rollback) run inside a
transaction helper exposed by `db/index.ts`.

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

- Success responses return the resource or payload directly — no envelope. The resolve
  body is exactly the research's `{ values, version }` (§4.2), and wrapping only the
  admin API would make two dialects.
- Errors are `{ "error": { "code": "…", "message": "…", "details": … } }` with the
  matching HTTP status. `code` is a stable machine-readable slug (`not_found`,
  `invalid_key`, `validation_failed`, `publish_conflict`, `nothing_to_publish`, …).
  `details` carries zod's treeified issues on validation failures.
- A `LeverError extends Error { statusCode, code }` thrown anywhere is mapped by
  `app.onError`; anything else logs and returns a bare 500.
- All request bodies, query params, and path params are zod-validated via a
  `zValidator` wrapper that renders failures in the shape above.
- CORS: `/v1/resolve` and `/v1/stream` answer cross-origin browsers for the origins
  in `LEVER_ALLOWED_ORIGINS` (default `*` — resolved values are public by design,
  research §3.4), with `Access-Control-Expose-Headers: ETag`; without that header
  browsers hide the ETag from cross-origin JS and the 304 path silently degrades to
  full refetches. `/v1/admin` gets no CORS — the dashboard is served same-origin from
  this container (§9.4).
- `GET /healthz` returns `{ "name": "lever", "version": "…" }` for container
  healthchecks.

## 6. `GET /v1/resolve`

The hot path (research §4.2).

### 6.1 Auth

The environment's client key, sent as `Authorization: Bearer pk_…` or, as a fallback
for `EventSource`-style clients that cannot set headers, `?key=pk_…` (shared with
§7). An unknown key is `401 { code: "invalid_key" }`. Client keys authorize exactly
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
  "version": 42,
  "values": {
    "enable_enrollment": { "type": "boolean", "value": true },
    "captcha_site_key":  { "type": "string",  "value": "…" }
  }
}
```

Values carry their declared types so SDK getters can be strict without a schema
exchange (research §4.2). An environment with no published version resolves as
`{ "version": 0, "values": {} }` — the SDK's code-default floor covers it (research
§4.4).

### 6.4 ETag and the in-process cache

- **ETag** is a strong validator: `"<sha256 hex, first 16 chars>"` over the exact
  canonical response body (which already includes the version, so a publish always
  changes the ETag even if resolved values happen to coincide for this context).
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

SSE nudges (research §3.2, §4.3). Same client-key auth as §6.1.

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
  the SDK fetches whenever the announced version *differs* from its last activated
  one, and updates its own notion of current only from fetch responses, never from
  nudge frames. Equality (not `≤`) keeps clients self-healing when the sequence is not
  monotonic — a database restored from backup, an environment deleted and recreated —
  and prices any stale or duplicate frame (including the connect interleaving above)
  at exactly one fetch that 304s.
- Subscriber count per environment is exposed in logs on connect/disconnect — the
  research names connection volume as the first metric to watch (§7).

## 8. Admin surface — `/v1/admin`

REST first; the dashboard is a client of this API (research §4.5).

### 8.1 Auth

`LEVER_ADMIN_TOKENS` env var: comma-separated `name:secret` pairs. Names are
`[a-z0-9-]{1,32}` and unique; secrets are `[A-Za-z0-9]{32,}` — the charsets make the
`,`/`:` delimiters unambiguous without an escaping scheme, and the parse (part of the
§9.1 boot validation) refuses to start on a malformed or duplicate entry rather than
leaving a token silently unreachable. Requests send `Authorization: Bearer <secret>`;
comparison is constant-time; failures log at warn. The matched name becomes
`versions.author` on publish. There is no login throttle: with a ≥ 190-bit enforced
secret floor, online guessing is not a realistic path, and per-IP throttling behind a
tunnel buys proxy-attribution complexity for nothing. The dashboard prompts for a
token once and keeps it in browser storage on the operator's own device — no
server-side session state.

Why this and nothing more: lever is self-hosted by its operator (research §1) — a user
table, password reset, and session machinery would be the largest subsystem in the
service, serving one or two humans. Static named tokens live in a password manager,
rotate by editing the env and restarting, and still give the version chain real
attribution. All writes require admin auth; client keys can never reach `/v1/admin`
(research §4.5, §7).

### 8.2 CRUD routes

Standard shapes, all zod-validated, all returning the §5 conventions:

| Route | Methods |
| --- | --- |
| `/projects` | `GET` list, `POST` create |
| `/projects/:projectId` | `GET`, `PATCH` (name), `DELETE` |
| `/projects/:projectId/environments` | `GET`, `POST` (key; client key generated server-side) |
| `/environments/:envId` | `GET` (incl. client key, latest version, dirty flag), `DELETE` |
| `/environments/:envId/rotate-key` | `POST` — new `pk_…`, old key invalid immediately |
| `/environments/:envId/conditions` | `GET`, `POST` (name + clauses) |
| `/conditions/:conditionId` | `PATCH`, `DELETE` (409 while referenced — §3.2 RESTRICT) |
| `/environments/:envId/parameters` | `GET`, `POST` (key, type, defaultValue, description) |
| `/parameters/:parameterId` | `GET`, `PATCH`, `DELETE` |
| `/parameters/:parameterId/conditional-values` | `PUT` — replaces the full ordered list `[{conditionId, value}]` |

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
  insert version `N+1` with author and timestamp. A busy error or versions-PK
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
  LEVER_ADMIN_TOKENS: z.string().transform(parseAdminTokens), // "name:secret,…" (§8.1)
  LEVER_ALLOWED_ORIGINS: z.string().default("*"),             // CORS for /v1 reads (§5)
  SSE_HEARTBEAT_MS: z.coerce.number().default(25_000),
  SSE_MAX_SUBSCRIBERS: z.coerce.number().default(2_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});
```

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

Numbered TypeScript modules in `src/db/migrations/` (`0001-init.ts`, …), each
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
mounted volume (`/data`); `HEALTHCHECK` hits `/healthz`. The image also serves
`apps/admin`'s built static SPA from the same Hono app (research §4.6) — the static
route is wired in this spec (a no-op empty directory until the dashboard spec lands).
Deployment examples stay generic (a volume, a port, a tunnel in front); no personal
infrastructure specifics.

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
cases keyed by canonical response bodies, including a canonicalization case that pins
`canonicalize()`'s exact output bytes (§3.3).

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
- **Auth**: client key cannot reach `/v1/admin`; wrong/rotated key → 401 on resolve
  and stream; bad admin token → 401.

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
