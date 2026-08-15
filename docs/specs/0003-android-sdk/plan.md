# Plan 0003 — implementing the Android SDK

- **Status:** not started
- **Spec:** [0003 — the Android SDK](./spec.md)
- **Shape:** eleven milestones — `lever-android` (M1–M9), the flagship audit
  (M10, the app's repo + a note back into research 0003), and the flagship
  migration (M11) as acceptance. Each milestone is one PR that lands green and
  useful on its own.

Sequencing is bottom-up, copied from plan 0002 because it worked: model →
storage → client core → transport → runtime → SSE, so every layer's tests need
only the layers beneath it, and the determinism seams (transport double,
notification source with initial state, wall clock, RNG; spec 0003 §10) exist
from the first milestone that needs them. Two lessons from the Swift plan's
review passes are pre-applied: the transport is built against the authoritative
HTTP fixtures from day one (they already exist — Swift M9 authored them), and
the platform spike happens before any milestone depends on the risky choices.

## M1 — repo scaffold, publishing plumbing, and the platform spike

`lever-android` repo: single library module per spec §1 (Kotlin 2.x, JVM
toolchain 17, minSdk 26, `explicitApi()`, binary-compatibility validator with an
empty baseline), MIT license, README stub carrying the two loud sentences
(values are public — never put secrets in config; `pk_` keys are identifiers,
not credentials). CI skeleton: JVM unit tests + lint on push, one instrumented
smoke test on a Gradle-managed emulator — CI emulator setup is a known tar pit,
so it is proven here, not discovered in M8.

Two risk-retirement acceptance items:

- **The spike**: a throwaway-quality but compiling skeleton of the spec §2
  public surface plus the risky ingredients — `explicitApi` over the whole
  surface (including the reified `json` factory, which must be `public inline`),
  the single-threaded-dispatcher runtime scope, `MutableSharedFlow` emission
  from a synchronous `activate()`, the `ProcessLifecycleOwner` binding with
  initial state — plus a tiny consumer fixture (an app module in the repo
  consuming the library like a real dependency, declaring a `Flags` object and
  an operator read).
- **The publishing pipe**: Central namespace verification for `dev.forcetower`,
  signing keys in CI secrets, and a `0.0.x` dry-run publish that resolves into
  the consumer fixture by coordinates. Publishing friction must not be
  discovered at 0.1.0.

**Done when:** CI is green (JVM + managed-device smoke), the consumer fixture
compiles against the surface skeleton, and a dry-run artifact resolves from
Central staging by coordinates.

## M2 — model layer

`LeverKey` + the typed factories with their internal decoders (spec §2.2),
the read-resolution semantics as a pure function over a raw payload (per
spec 0002 §2.3: absent / mismatch / decode, with `int`/`long` range rules),
`LeverException`, `LeverContext`, `LeverPlatform`, `LeverConfiguration`,
`LeverLogSink` + `LogcatSink`, and the full validation pass (spec §3 →
spec 0002 §3: base-URL canonicalization + the one throwing case, semver
zero-padding, UTF-16 wire-limit mirroring with omission of overlong reserved
fields, deterministic attribute dropping, key shape check, interval clamping)
against an injected sink.

**Done when:** the decode matrix passes — every factory × {present, absent,
wrong type, fractional→integer, out-of-`Int`-range, out-of-`Long`-range,
failing `json` through both the reified and explicit-serializer factories} —
plus the validation cases (Unicode boundaries via UTF-16 length, 21 valid
attributes under different insertion orders selecting the same 20, overlong
platform/appVersion omitted, base path/trailing slash/scheme/query handling,
unparseable URL throwing, interval input across negative/zero/sub-60 s/60 s),
all through a recording log sink asserting warn/info/error behavior including
the per-`(key, version, type)` dedupe.

## M3 — storage

Cache codec + store (spec §7 → spec 0002 §7): the identity/snapshot file split,
key-hash naming over `canonicalBaseURL + namespace`, atomic writes, raw-payload
round-trip, first-run identity-only persistence via exclusive create (loser
re-reads the winner), corrupt/wrong-schema → warn + first-run behavior,
write-failure policy, `noBackupFilesDir` default resolution. File-system tests
run against temp directories on the JVM — no Android APIs in the codec.

**Done when:** round-trip, corruption, schema-bump, and stable-hash tests pass;
`clientId` and (with `cacheNamespace` set) the snapshot survive a simulated key
rotation; concurrent first initialization converges on one identity; and the
byte-for-byte format fixtures are **copied from lever-swift's** and pass
unmodified — "one cache format, not one per SDK" (spec §7) enforced by shared
bytes, not by intent.

## M4 — client core

`LeverClient` minus networking: the lock-protected state box (activated +
staged representations each owning their etag/fetchedAt metadata, derived
`lastKnownVersion` — spec 0002 §4), synchronous `get`/`value` reads with
type-keyed JSON memoization, `activate()` with representation-commit vs.
value-change semantics and raw-diff `changedKeys`, cache load in the
constructor and persist on commit, the `updates` shared flow, `close()`
teardown, and the `Lever` object with its `IllegalStateException` misuse rules
(spec §2.1, §4). Staged representations are injected directly by tests — no
transport yet.

**Done when:** the spec 0002 §10.2 staging semantics pass (stage-then-read
stability, no-op activate emits nothing, `changedKeys` exact, metadata-only
commits advance `activatedVersion`/ETag/cache silently, first activation of
version 0 yields `activatedVersion == 0`); the same wire key decodes correctly
through two Kotlin types; a reentrant log sink does not deadlock
(no-callout-under-lock); `updates` delivers to multiple concurrent collectors
and emission from synchronous `activate()` never blocks; reads serve cached
values before any coroutine runs; and singleton tests use an internal testing
reset while the production `IllegalStateException` stays intact.

## M5 — transport: resolve, against the fixtures

The transport seam + the OkHttp live implementation (dedicated client pinned
per spec §6.1), request construction, response mapping surfaced as
`LeverException`, wired into `fetch()` with in-flight coalescing and its
cancellation semantics. The scripted transport double and the **fixture replay
harness** land here together — the fixtures already exist
(`packages/contract-fixtures/fixtures/http/`, authored in Swift M9), so
Android transport is built against authoritative tapes from its first test,
via the pinned-SHA monorepo checkout in CI.

Test provenance splits as in plan 0002 M5: fixtures pin what the real service
can emit (request shapes, 200/304/401/server statuses, ETags, bodies);
SDK-local scripted tests cover what it cannot (non-HTTP transport events,
redirect refusal, cancellation, malformed responses).

**Done when:** request-construction tests pass byte-exact against the contract
fixtures; the full spec 0002 §6.1 status/ETag/version matrix maps to the right
representation metadata + clock effects, including 304 ownership (activated
confirmed persists freshness; staged confirmed never touches activated state;
fetch-200-stage → fetch-304 → activate; unsolicited 304 → `InvalidResponse`);
an invalid 200 body changes nothing; coalescing collapses concurrent fetches to
one request; one waiter's cancellation leaves the shared fetch running and
rethrows `CancellationException` unwrapped.

## M6 — runtime: scheduling and lifecycle

The runtime scope (spec §5): the two time seams (wall-clock provider +
virtual-time dispatcher), the automatic fetch path on construction, the
interval clock + in-session timer with the hot-loop guards, the
`ProcessLifecycleOwner`-backed notification source behind its seam (initial
state included), cache-only mode (`automaticUpdates = false`), and `close()`
cancelling everything.

**Done when:** `runTest` virtual-time tests prove: construction inside the
interval issues no request, outside it fetches; the timer fires at
`lastFetchAt + interval` and re-arms; zero interval never loops (no timer),
sub-60 s polls at the floor while lifecycle edges keep the configured value,
exactly 60 s runs as configured; a failed automatic fetch re-arms from the
attempt, including first-run offline; wall-clock jumps do not disturb the
timer; background cancels the timer; a client constructed while already
foregrounded runs the foreground path (Robolectric where the real
`ProcessLifecycleOwner` is exercised); explicit `fetch()` ignores the
interval; a cache-only client starts no fetch/timer/lifecycle/SSE while reads
and explicit fetch still work; `close()` cancels every job and no callback
fires after it.

## M7 — SSE

Parser first — a port of the Swift parser (pure function over byte chunks:
frames across boundaries, heartbeats, CRLF/LF, `retry:` discarded, the 1 MiB
frame bound) — then the spec 0002 §6.2 state machine on the runtime: connect
validation before any byte reaches the parser, idle watchdog (OkHttp read
timeout disabled on the stream call), full-jitter backoff with injected RNG,
503 `Retry-After` floor, 401 stop-until-foreground, foreground/background
connect/teardown, and §5.3 nudge handling — dedupe against `lastKnownVersion`,
the pending token during an in-flight fetch, the `autoActivateOnNudge` toggle.

**Done when:** the spec 0002 §10.3 suite passes on virtual time + scripted byte
streams, including connect validation (a 200 HTML error page fails fast into
backoff), the replayed connect frame after a missed publish → exactly one
fetch, a *lower* announced version → fetch, the pending-nudge orderings (one
follow-up, several coalesce to one, already-covered yields none), backgrounding
during connect/backoff tearing down cleanly, and stream cancellation never
logged or retried as a transport failure.

## M8 — the floor suite

Spec 0002 §10.1 end-to-end through the public API only (`Lever.configure` and
explicit clients), transport double failing in every way: first-run offline,
cache-warm offline, 401 non-wiping on both endpoints, corrupt cache, mismatch
floor, key rotation with a warm offline cache (namespaced and default),
cache-write failure, and the single-writer/cache-only-reader topology across
two clients sharing a directory. Research 0001 §7's "tests, not intent"
milestone — it gates calling the SDK functional.

**Done when:** every floor case passes end-to-end, and a README section
documents the three-layer guarantee with a pointer to this suite.

## M9 — release 0.1.0

README completed (install coordinates, `Application.onCreate` configure with
the StrictMode note, `Flags` pattern, DEBUG interval recipe, `cacheNamespace`
recommendation, cache-only reader mode, nudge auto-activation opt-out), R8
consumer rules verified against a minified consumer fixture build, BCV baseline
committed, docs pass over KDoc on the public surface. Tag **0.1.0** and publish
to Central through the M1 pipe.

**Done when:** the full CI matrix is green on the tag and the published
artifact resolves into a fresh sample app by coordinates alone.

## M10 — the flagship audit (parallel)

The research 0003 §2 audit debt, paid in the flagship's repo: key inventory
(names, types, defaults), where values cross module boundaries, whether the
realtime listener is wired, min-SDK reality, process topology (any
multi-process surprises), and the seam flags are published through today. The
outcome is a migration checklist appended to research 0003 — the SDK does not
change; the *plan* for M11 does, if the audit surprises.

**Done when:** research 0003 records the audit findings and M11's checklist,
and any assumption this plan got wrong is corrected here before M11 starts.

## M11 — acceptance: the flagship migration

Per spec §9, in the flagship app's repo: `Lever.configure` in
`Application.onCreate`, the Remote Config wrapper's guts replaced by a `Flags`
object with defaults declared exactly once, a coroutine bridging `updates` into
the app's existing flag seam, and a stable `cacheNamespace` set. Run against
the deployed service; live-flip a gate; kill the network and relaunch; simulate
a client-key rotation and relaunch offline to confirm the namespaced cache
still serves. API friction found here feeds 0.x releases — 1.0 is tagged only
after this ships, with any spec deviations folded back into spec 0003 first.

**Done when:** the flagship's Android app runs on lever in production with
Firebase Remote Config removed, and spec 0003 reflects anything the migration
taught.

## Order and parallelism

M1→M8 are strictly sequential (each builds on the last). M10 is independent of
all of them and can start immediately — it should, since its findings can only
cheapen M11. M9 needs M8; M11 needs M9 + M10. The critical path is the M2–M7
core, and it should move faster than Swift's did: the fixtures, the behavioral
contract, and both review passes are inherited, not re-litigated — where a
question comes up that spec 0002 already answered, the answer is the citation,
not a new debate.
