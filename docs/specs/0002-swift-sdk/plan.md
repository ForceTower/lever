# Plan 0002 — implementing the Swift SDK

- **Status:** not started
- **Spec:** [0002 — the Swift SDK](./spec.md)
- **Shape:** eleven milestones across two repos — `lever-swift` (M1–M8, M10) and
  this monorepo (M9), with the flagship migration (M11) as acceptance. Each
  milestone is one PR that lands green and useful on its own.

Sequencing is bottom-up: model → storage → client core → transport → runtime →
SSE, so every layer's tests need only the layers beneath it, and the seams the
spec demands for determinism (injected clock, RNG, transport, notification
source — spec §10) exist from the first milestone that needs them, not
retrofitted.

## M1 — repo scaffold

`lever-swift` repo: `Package.swift` exactly per spec §1 (tools 6.0, language mode
v6, five platforms, zero dependencies, single `Lever` product), empty target +
test target, MIT license, README stub carrying the two loud sentences (values are
public — never put secrets in config; `pk_` keys are identifiers, not
credentials). CI skeleton: `swift test` on macOS + `xcodebuild test` on an iOS
simulator, build-only watchOS/tvOS/visionOS jobs.

**Done when:** CI is green on a trivial test across all five platform jobs.

## M2 — model layer

`LeverKey` + `LeverKeys` + the typed initializers with their internal decoder
closures (spec §2.2), the §2.3 read-resolution semantics as a pure function over a
raw payload (absent / mismatch / decode), `LeverError`, `LeverContext`,
`LeverPlatform`, `LeverConfiguration`, `LeverLogSink` + `OSLogSink`, and the §3
configuration validation (semver check + zero-padding, attribute-limit dropping,
key shape check) against an injected sink.

**Done when:** the decode matrix passes — every typed initializer × {present,
absent, wrong type, fractional→`Int`, out-of-range `Int`, failing `json`} — plus
the §10.2 validation cases, all through a recording log sink asserting the exact
warn/info/error behavior including the per-`(key, version)` dedupe.

## M3 — storage

Cache codec + store (spec §7): key-hash file naming, atomic writes, raw-payload
round-trip, `clientId` generation on first run, corrupt/wrong-schema → warn +
first-run behavior. File-system tests run against a temp directory.

**Done when:** round-trip, corruption, schema-bump, and stable-hash tests pass;
a byte-for-byte fixture guards the file format against accidental drift.

## M4 — client core

`LeverClient` minus networking: the `Mutex` state box (activated / staged /
`lastKnownVersion` / etag / clock fields), synchronous `value(for:)` +
`@dynamicMemberLookup` reads with JSON memoization, `activate()` with raw-diff
`changedKeys`, cache load in `init` and persist on activation, manual
`Observable` conformance via `ObservationRegistrar`, the multi-consumer `updates`
streams, and the `Lever` namespace with its `preconditionFailure` misuse rules
(spec §2.1, §4). Staged payloads are injected directly by tests — no transport
yet.

**Done when:** §10.2 staging semantics pass (stage-then-read stability, no-op
activate emits nothing, `changedKeys` exact), observation fires on change only
(asserted via `withObservationTracking`), `updates` delivers to multiple
concurrent consumers, and init-from-cache serves values before any async work.

## M5 — transport: resolve

`LeverTransport` protocol + the `URLSession` live implementation (ephemeral
config per spec §6.1), request construction (auth header, context query items,
`If-None-Match`), response mapping (200 decode / 304 / 401 / other / network /
`invalidResponse`), wired into `LeverClient.fetch()` with in-flight coalescing.
The scripted transport double lands here and becomes the tool every later
milestone tests with.

**Done when:** request-construction tests pass byte-exact against recorded spec
0001 §6 shapes; the 200/304/401/5xx/decode-failure matrix maps to the right
staging + `lastKnownVersion` + etag + clock effects; coalescing collapses
concurrent fetches to one request.

## M6 — runtime: scheduling and lifecycle

The runtime actor (spec §5): injected `Clock`, the automatic fetch path on init,
the interval clock + in-session timer, explicit-fetch-always-hits-network,
foreground/background reaction via an injected notification source (live
implementation binds the per-platform notification names behind `#if canImport`).

**Done when:** manual-clock tests prove: init inside the interval issues no
request, outside it fetches; the in-session timer fires at
`lastFetchAt + interval` and re-arms; background cancels it; explicit `fetch()`
ignores the interval; nudge-path fetches (stubbed trigger) bypass and reset the
clock.

## M7 — SSE

Parser first (pure function over byte chunks: frames across boundaries,
heartbeats, CRLF/LF, `retry:` discarded), then the §6.2 state machine on the
runtime actor: idle watchdog, full-jitter backoff with injected RNG, 503
`Retry-After` floor, 401 stop-until-foreground, foreground/background
connect/teardown, and §5.3 nudge dedupe against `lastKnownVersion` with the
`autoActivateOnNudge` toggle.

**Done when:** the §10.3 suite passes on manual clock + scripted byte streams,
including the two subtle cases: replayed connect frame after a missed publish →
exactly one fetch, and a *lower* announced version → fetch (identity, not
ordering).

## M8 — the floor suite

Spec §10.1, end-to-end through the public API only (`configure`/`Lever.shared`
and instance clients), with the transport double failing in every way: first-run
offline, cache-warm offline, 401 non-wiping on both endpoints, corrupt cache,
mismatch floor. This is research 0001 §7's "tests, not intent" milestone — it
gates calling the SDK functional.

**Done when:** every floor case passes end-to-end, and a README section documents
the three-layer guarantee with a pointer to this suite.

## M9 — contract fixtures (monorepo)

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
`cacheDirectory` at the App Group. Run it against the deployed service; live-flip
a gate; kill the network and relaunch. API friction found here feeds 0.x
releases — 1.0 is tagged only after this ships.

**Done when:** the flagship runs on lever in production with Firebase Remote
Config removed, and any spec deviations discovered are folded back into spec 0002
before the 1.0 tag.

## Order and parallelism

M1→M8 are strictly sequential (each builds on the last). M9 is independent after
M1 and can proceed any time; M10 needs M8 + M9. M11 needs M10. The
critical path is the M2–M7 core; M8 is small once the seams exist, because every
behavior it exercises was already unit-proven a layer down.
