# Plan 0002 — implementing the Swift SDK

- **Status:** M1–M10 landed; M11 (the flagship migration) is the remaining acceptance
- **Spec:** [0002 — the Swift SDK](./spec.md)
- **Shape:** eleven milestones across two repos — `lever-swift` (M1–M8, M10) and
  this monorepo (M9), with the flagship migration (M11) as acceptance. Each
  milestone is one PR that lands green and useful on its own.

Sequencing is bottom-up: model → storage → client core → transport → runtime →
SSE, so every layer's tests need only the layers beneath it, and the seams the
spec demands for determinism (injected clock, RNG, transport, notification
source — spec §10) exist from the first milestone that needs them, not
retrofitted.

## M1 — repo scaffold and the isolation spike

`lever-swift` repo: `Package.swift` exactly per spec §1 (tools 6.0, language mode
v6, five platforms, zero dependencies, single `Lever` product), empty target +
test target, MIT license, README stub carrying the two loud sentences (values are
public — never put secrets in config; `pk_` keys are identifiers, not
credentials). CI skeleton: `swift test` on macOS + `xcodebuild test` on an iOS
simulator, build-only watchOS/tvOS/visionOS jobs.

M1's acceptance is a **spike**, not just scaffolding: a throwaway-quality but
compiling skeleton of the proposed public surface plus the risky ingredients —
`Synchronization.Mutex`, manual `Observable` via `ObservationRegistrar`, the
`#if canImport` lifecycle imports, `URLSession.bytes` — built across all five
platform targets, and the two consumer fixtures from spec §1 (`MainActor`-default
and nonisolated-default, each with a `LeverKeys` extension and a dynamic-member
read). Strict-concurrency and isolation choices are the hardest decisions to
reverse; this proves them before any milestone depends on them.

**Done when:** CI is green across all five platform jobs and both consumer
fixtures compile against the surface skeleton.

## M2 — model layer

`LeverKey` + `LeverKeys` + the typed initializers with their internal decoder
closures (spec §2.2), the §2.3 read-resolution semantics as a pure function over a
raw payload (absent / mismatch / decode), `LeverError`, `LeverContext`,
`LeverPlatform`, `LeverConfiguration`, `LeverLogSink` + `OSLogSink`, and the §3
configuration validation (base-URL canonicalization, semver check + zero-padding,
UTF-16 wire-limit mirroring with omission of overlong reserved fields,
deterministic attribute dropping, key shape check, interval clamping) against an
injected sink.

**Done when:** the decode matrix passes — every typed initializer × {present,
absent, wrong type, fractional→`Int`, out-of-range `Int`, failing `json`} — plus
the §10.2 validation cases (Unicode/UTF-16 boundaries, 21 valid attributes under
different insertion orders selecting the same 20, overlong platform/appVersion
omitted, base path/trailing slash/scheme/query handling, interval input across
negative/zero/sub-60 s/60 s with the right logs), all through a recording
log sink asserting the warn/info/error behavior including the
per-`(key, version, type)` dedupe.

## M3 — storage

Cache codec + store (spec §7): the identity/snapshot file split, key-hash naming
over `canonicalBaseURL + namespace`, atomic writes, raw-payload round-trip,
first-run identity-only persistence (`clientId` before any fetch exists),
corrupt/wrong-schema → warn + first-run behavior, write-failure policy.
File-system tests run against a temp directory.

**Done when:** round-trip, corruption, schema-bump, and stable-hash tests pass;
`clientId` and (with `cacheNamespace` set) the snapshot survive a simulated key
rotation; concurrent first initialization converges on one identity via
exclusive create (the loser re-reads the winner); a byte-for-byte fixture per
file guards the formats against accidental drift.

## M4 — client core

`LeverClient` minus networking: the `Mutex` state box (activated + staged
representations each owning their etag/fetchedAt metadata, derived
`lastKnownVersion` — spec §4), synchronous `value(for:)` +
`@dynamicMemberLookup` reads with JSON memoization, `activate()` with raw-diff
`changedKeys`, cache load in `init` and persist on activation, manual
`Observable` conformance via `ObservationRegistrar`, the multi-consumer `updates`
streams, and the `Lever` namespace with its `preconditionFailure` misuse rules
(spec §2.1, §4). Staged payloads are injected directly by tests — no transport
yet.

**Done when:** §10.2 staging semantics pass (stage-then-read stability, no-op
activate emits nothing, `changedKeys` exact, metadata-only commits advance
`activatedVersion`/ETag/cache silently, first activation of version 0 yields
`activatedVersion == 0`), observation fires on value change only (asserted via
`withObservationTracking`), the same wire key decodes correctly through two
`Value` types, a reentrant log sink/observation callback does not deadlock
(no-callout-under-lock), `updates` delivers to multiple concurrent consumers, and
init-from-cache serves values before any async work. Public-API singleton tests
use an internal testing reset; the production `preconditionFailure` stays intact.

## M5 — transport: resolve

`LeverTransport` protocol + the `URLSession` live implementation (ephemeral
config pinned per spec §6.1), request construction (auth header, context query
items, `If-None-Match`), response mapping (200 decode / 304 / 401 / other-2xx /
refused redirect / non-HTTP / network / `invalidResponse`), wired into
`LeverClient.fetch()` with in-flight coalescing and its cancellation semantics.
The scripted transport double lands here and becomes the tool every later
milestone tests with. Coalescing, cancellation, and the pending-nudge token are
one state machine — the fetch-operation half lands here (the nudge *trigger*
arrives with SSE in M7).

Test provenance is split by what each source can actually pin: the M9 fixtures
cover what the real service can emit — request URLs/headers, 200/304/401/server
statuses, ETags, bodies — while SDK-local scripted transport/session tests cover
the Foundation-only events the service cannot produce: non-HTTP responses,
redirect delegate behavior, cancellation, malformed platform responses.

**Done when:** request-construction tests pass byte-exact against the M9 contract
fixtures; the full §6.1 status/ETag/version matrix maps to the right
representation metadata + clock effects, including 304 ownership (activated
confirmed persists freshness; staged confirmed never touches activated state;
fetch-200-stage → fetch-304 → activate; unsolicited 304 →
`invalidResponse`); an invalid 200 body changes nothing (atomicity); coalescing
collapses concurrent fetches to one request; one waiter's cancellation leaves
the shared fetch running and rethrows `CancellationError`.

## M6 — runtime: scheduling and lifecycle

The runtime actor (spec §5): the two injected time seams (wall-clock provider +
monotonic clock), the automatic fetch path on init, the interval clock +
in-session timer with its hot-loop guards, explicit-fetch-always-hits-network,
foreground/background reaction via an injected notification source that reports
an initial state (live implementation binds the per-platform notification names
behind `#if canImport`), and client/runtime teardown.

**Done when:** manual-clock tests prove: init inside the interval issues no
request, outside it fetches; the in-session timer fires at
`lastFetchAt + interval` and re-arms; a zero interval held foregrounded never
loops (no timer), a sub-60 s interval polls at the 60 s floor while lifecycle
edges keep the configured value, and exactly 60 s runs as configured; a
cache-only client (`automaticUpdates = false`) starts no fetch, timer, lifecycle
observer, or stream while reads and explicit fetch still work; a failed
automatic fetch re-arms from the
attempt, including first-run offline; a wall-clock jump does not disturb the
monotonic timer; background cancels it; a client constructed while already
active runs the foreground path; explicit `fetch()` ignores the interval;
nudge-path fetches (stubbed trigger) bypass and reset the clock; deallocating
the client cancels every task and no callback fires after teardown.

## M7 — SSE

Parser first (pure function over byte chunks: frames across boundaries,
heartbeats, CRLF/LF, `retry:` discarded, the 1 MiB frame bound), then the §6.2
state machine on the runtime actor: idle watchdog, full-jitter backoff with
injected RNG, 503 `Retry-After` floor, 401 stop-until-foreground,
foreground/background connect/teardown, and §5.3 nudge handling — dedupe against
`lastKnownVersion`, the pending token for nudges during an in-flight fetch, and
the `autoActivateOnNudge` toggle.

**Done when:** the §10.3 suite passes on manual clock + scripted byte streams,
including connect validation (a 200 HTML error page fails fast into backoff
without entering the parser; wrong/missing media type, redirect, and non-HTTP
responses map per §6.2) and the subtle cases: replayed connect frame after a
missed publish → exactly one fetch; a *lower* announced version → fetch
(identity, not ordering);
the F4 ordering — a nudge landing mid-fetch yields exactly one follow-up fetch,
several coalesce to one, an already-covered one yields none; backgrounding during
connect/backoff tears down cleanly; stream cancellation is never logged or
retried as a transport failure.

## M8 — the floor suite

Spec §10.1, end-to-end through the public API only (`configure`/`Lever.shared`
and instance clients), with the transport double failing in every way: first-run
offline, cache-warm offline, 401 non-wiping on both endpoints, corrupt cache,
mismatch floor, key rotation with a warm offline cache (namespaced and default),
cache-write failure, and the single-writer/reader cache topology across two
clients sharing a directory. This is research 0001 §7's "tests, not intent"
milestone — it gates calling the SDK functional.

**Done when:** every floor case passes end-to-end, and a README section documents
the three-layer guarantee with a pointer to this suite.

## M9 — contract fixtures (monorepo, lands before M5)

Numbered by repo, not by order: this milestone is independent after M1 and must
land **before M5**, so the transport is built against the authoritative HTTP
fixtures rather than locally recorded shapes reconciled only at release.

In **this repo**: author `packages/contract-fixtures/fixtures/http/` in the
spec §10.4 step format — the minimum set (fresh 200, repeat 304, `{version: 0}`,
401 warm-cache, type mismatch, empty-context defaults) — and extend the service's
integration tests to generate/verify each fixture against the real server, so the
tapes can never drift from reality. Update the contract-fixtures README to close
its open promise.

**Done when:** `bun run check` verifies every fixture against the live service in
CI.

## M10 — fixture replay + release

In `lever-swift`: the replay harness feeding §10.4 fixtures through the transport
double, CI's pinned-SHA monorepo checkout wired up, platform test matrix
finalized, README completed (install, configure, `LeverKeys` pattern, DEBUG
interval recipe, App Group cache, opt-out of nudge auto-activation). Tag
**0.1.0**.

**Done when:** the full matrix is green on the tag and the package resolves into
a fresh sample app by URL.

## M11 — acceptance: the flagship migration

Per spec §9, in the flagship app's repo: replace the Remote Config app-target
file with `Lever.configure` + the `updates`→UserDefaults bridge, replace the
flags file with a `LeverKeys` extension (11 keys, defaults declared once), point
`cacheDirectory` at the App Group, and set a stable `cacheNamespace` (e.g.
`"prod"`) — the warm floor across key rotation depends on it. Run it against the
deployed service; live-flip a gate; kill the network and relaunch; simulate a
client-key rotation and relaunch offline to confirm the namespaced cache still
serves. API friction found here feeds 0.x
releases — 1.0 is tagged only after this ships.

**Done when:** the flagship runs on lever in production with Firebase Remote
Config removed, and any spec deviations discovered are folded back into spec 0002
before the 1.0 tag.

## Order and parallelism

M1→M8 are strictly sequential (each builds on the last). M9 is independent after
M1 but must land before M5, which consumes its fixtures; M10 needs M8 + M9. M11
needs M10. The critical path is the M2–M7 core; M8 is small once the seams exist,
because every behavior it exercises was already unit-proven a layer down.
