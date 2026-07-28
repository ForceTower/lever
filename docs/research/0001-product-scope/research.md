# 0001 — Lever: self-hosted remote config for every project

- **Status:** pre-implementation (scope settled 2026-07-27)
- **Date started:** 2026-07-27
- **Scope:** the whole product — the config service, the client SDKs (Kotlin, Swift,
  TypeScript), and a minimal admin dashboard.

> Research documents capture where we came from, what we're thinking, and what purpose
> we're after — _before_ a spec pins down the how. A spec should be able to cite this
> document for every "why".

## 1. Purpose — what we're after

Firebase Remote Config is becoming a paid product. Every personal project that gates
features on it inherits a bill and a dependency on Google's console. The goal is **one
self-hosted deployment serving remote config to all personal projects** — mobile, web,
and server — preserving the semantics the apps already rely on (fetch-and-activate,
offline cache, code-default floor, near-instant propagation) with a developer experience
at least as good as the thing it replaces.

Concretely, after v1 an operator can:

- Define typed parameters per project, target them by platform / app version / custom
  attributes, and publish an immutable, diffable, rollback-able version.
- Flip a feature gate from a phone during an incident and watch foregrounded apps pick
  it up within seconds.
- Add lever to a brand-new project by dropping in an SDK, a URL, and a client key.

## 2. Where we came from — actual usage (audited 2026-07-27)

The flagship consumer is a pair of mobile apps (Android + iOS) sharing one Firebase
Remote Config project. The audit of what is _actually used_:

- **9 parameters**: 7 boolean feature gates + 2 strings (a captcha site key and base
  URL). Boolean-heavy, low-cardinality, low churn.
- **Semantics exercised**: fetch-and-activate on launch; 12-hour minimum fetch interval
  with a DEBUG bypass; Remote Config's own disk cache keeps last-activated values
  across launches (the offline story); the realtime update listener flips gates live
  mid-session; Android and iOS values are managed independently so a feature can ship
  on one platform first.
- **Every read goes through one hand-written wrapper class per app.** Migration to
  lever means replacing the guts of exactly one file per platform — the cheapest
  possible migration story, and a shape lever's SDKs should encourage for every
  consumer.
- The projects' backend does **not** consume Remote Config (its Firebase Admin usage is
  push messaging only). Server-side operational levers there use a separate Redis-based
  mechanism, deliberately out of lever's scope: process-internal operational config and
  client-facing product config are different animals with different guarantees.

**Build vs adopt.** Flagsmith, GrowthBook, and Unleash are self-hostable and credible.
Rejected: each brings its own multi-service stack to host and upgrade for what is,
today, ~10 parameters — and none matches the exact Firebase semantics the apps encode.
The usage surface is small enough that owning the whole plane is cheaper than operating
someone else's.

## 3. The landscape — the forks and how they were called

### 3.1 Evaluation location: **server-side** (chosen)

| Option | SDK cost | Rule privacy | Caching |
| --- | --- | --- | --- |
| **Server-side eval** — client sends context, server returns resolved values | ~200 lines per SDK | Rules never leave the server | ETag per (version, context) |
| Client-side eval — server ships rules, SDK evaluates | Full rule engine ×3 languages, kept consistent forever | Rules readable by anyone with the payload | One payload per env, CDN-able |

For a solo maintainer of three SDKs, the rule engine must exist **once**. Server-side
evaluation makes each SDK a thin HTTP client: GET + ETag/304 + disk cache + typed
getters. It also keeps targeting rules private — no leaking "feature X coming" strings
to APK spelunkers. The caching downside (per-context responses) is irrelevant at the
intended scale, and ETag still short-circuits the common case. A raw-rules endpoint for
local evaluation can be added later without breaking anything; it is not v1.

### 3.2 Realtime propagation: **SSE in the MVP**

Instant gate flips are part of the semantics being replaced (the apps use Firebase's
realtime listener today), so push ships in v1 — but as the *thin* version:

- The SSE stream carries **version nudges only** (`{"version": N}`), never values. On a
  nudge the SDK runs its normal fetch-and-activate. Push is an accelerant for the poll
  path, not a second source of truth — a dead stream degrades to min-interval polling,
  never to broken config.
- The deployment sits behind Cloudflare Tunnel, whose edge cuts idle proxied
  connections after ~100 s. The server writes a heartbeat comment every ~25 s, which
  also keeps mobile-carrier NAT happy.
- Clients hold the stream only while foregrounded, reconnect with jittered backoff, and
  dedupe on version (already at N → ignore the nudge).

### 3.3 Storage: **SQLite** (`bun:sqlite`)

Read-heavy, tiny write volume, single-node deployment: SQLite is the right weight —
zero extra infrastructure, one file to back up. All access goes through a repository
seam so a promotion to Postgres, if multi-node ever happens, is a contained swap.
Resolved-config reads should additionally be served from an in-process cache of the
published version, making the hot path allocation-only.

### 3.4 Home: **standalone public repo**

Lever is general-purpose and contains nothing project-sensitive, so it lives in its own
public repository — which also makes the SDKs naturally publishable (Maven Central /
SPM / npm) instead of vendored. Config *values* are, by design, visible to app users;
lever's docs must say plainly: **never put secrets in config values**.

## 4. Strategy — the shape

### 4.1 Concepts

- **Project** → **Environment** (prod / staging / dev; each with its own client key
  `pk_…`) → **Parameters**.
- A parameter has a **type** (`boolean | string | number | json`), a **default value**,
  and an ordered list of **conditional values** — first matching condition wins,
  mirroring the Firebase model the apps already map onto.
- **Conditions** target a small, explicit context: `platform`, `appVersion` (semver
  operators — "enable from 5.2.0"), and free-form custom attributes. "Ship Android
  before iOS" becomes one platform condition instead of two consoles.
- **Publishing creates an immutable version** (author, timestamp, diff against the
  previous version). Rollback is republishing an old version as a new one. The version
  chain _is_ the audit log.

### 4.2 The resolve endpoint

`GET /v1/resolve` authenticated by the environment's client key, with the context as
query parameters. Response: fully resolved `{ values, version }` plus an `ETag`;
`If-None-Match` returns `304`. Values carry their declared types so SDK getters can be
strict (a type mismatch falls back to the code default and warns, never throws).

### 4.3 The stream endpoint

`GET /v1/stream`, same client-key auth. Emits the current version on connect (catching
up anything missed while backgrounded), then a nudge per publish, with heartbeats per
§3.2. Publishing broadcasts to the environment's subscribers.

### 4.4 SDKs — Kotlin, Swift, TypeScript

All three implement the same tiny contract, shaped after the wrapper classes the apps
already have:

```kotlin
val lever = Lever(
    baseUrl = "https://config.example.dev",
    key = BuildConfig.LEVER_KEY,
    context = LeverContext(appVersion = BuildConfig.VERSION_NAME),
)
lever.fetchAndActivate()                              // launch
lever.getBoolean("enable_enrollment", default = false)
lever.updates                                         // flow, re-emits on activate
```

- **Fetch-and-activate**: fetched values are staged; nothing changes mid-read until
  `activate()`. A push nudge fetch-and-activates automatically (matching today's
  realtime behavior), with an opt-out for apps that want launch-only flips.
- **Three-layer floor**: live values → disk-cached last-activated values (offline) →
  code defaults (first run / server unreachable). The app always works.
- **Min fetch interval** (default 12 h) with a debug bypass, honored by the poll path;
  nudges bypass it by design.
- **Context** carries platform, appVersion, custom attributes, and an optional stable
  client id — unused in v1, reserved as the future bucketing key for percentage
  rollouts so adding them requires no SDK change.

### 4.5 Admin surface

REST API first; a minimal dashboard on top (list parameters, edit values and
conditions, publish with a diff preview, rollback). The dashboard is not optional
polish: the primary real-world interaction is "flip a gate from wherever you are during
an incident." Client keys are public identifiers scoped to reads of one environment;
all writes require admin auth.

### 4.6 Stack

Bun + Hono service, `bun:sqlite` behind the repository seam, one Docker image, deployed
on a single-node host fronted by Cloudflare Tunnel. The dashboard is a static SPA
served by the same container.

## 5. The cut

**MVP:** the service (projects, environments, typed parameters, platform/appVersion/
custom-attr conditions, immutable publish + rollback), resolve with ETag, SSE nudges,
admin REST + minimal dashboard, per-env client keys + admin auth, and the three SDKs
with the §4.4 contract.

**v1.x:** percentage rollouts (stable hash over the client id → sticky bucketing, no
server state), a codegen CLI (`lever pull --kotlin`) emitting typed wrapper classes,
raw-rules endpoint for server-side consumers that want local evaluation.

## 6. Non-goals

- **A/B experimentation with metrics.** That is an analytics product; lever stops at
  deterministic value assignment.
- **Per-user server-stored overrides.** Targeting is rule-based over client context,
  not a per-user database.
- **Client-side rule evaluation** as a baseline (§3.1; possible later add-on).
- **Secrets distribution.** Config values are readable by end users; the docs must be
  loud about this.

## 7. Risks

- **One home-hosted node becomes a dependency of every project.** Mitigated by the SDK
  floor semantics (§4.4): an outage means stale config, never broken apps. This must be
  covered by SDK tests, not just intent.
- **SSE connection volume through the tunnel.** Hundreds of idle connections are
  trivial for Bun and cloudflared, but this is the first metric to watch; the poll
  fallback caps the blast radius if streams must be shed.
- **Three SDKs, one maintainer.** Server-side eval keeps them thin; a shared
  contract-test fixture set (same inputs → same resolved values, same fallback
  behavior) keeps them honest.
- **Public client keys.** They are identifiers, not credentials — they authorize
  nothing but reading one environment's resolved config, which is public to app users
  anyway. Rules and the admin surface stay behind real auth.

## 8. Next step

Spec 0001: the service — SQLite schema, resolve/stream endpoints, admin REST, auth.
Then the TypeScript SDK first (dogfooded by the dashboard itself), Kotlin and Swift
after, migrating the flagship apps' wrapper classes as the acceptance test.
