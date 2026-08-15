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
A third inheritance is spelled out per milestone below: every spec 0002
§12/§12.1 resolution (identity publication, commit sequencing, singleton
reservation, the unified init trigger, nudge join semantics, frame-budget
accounting, saturating time, `clientId` canonicalization) appears as a **named
acceptance test in its owning milestone** — transitive citation is not a test.

## M1 — repo scaffold, publishing plumbing, and the platform spike

Gated on M10's platform-floor and process-topology findings (see M10) — the
facts that could invalidate minSdk 26 or the single-process lifecycle
assumptions must be known before the shape becomes implementation.

`lever-android` repo: single library module per spec §1 (**exact** Kotlin, AGP,
dependency, and publishing-plugin versions pinned in the version catalog — no
"2.x"/"current stable" left in build inputs; minSdk 26, `explicitApi()`), MIT
license, README stub carrying the two loud sentences (values are public — never
put secrets in config; `pk_` keys are identifiers, not credentials). ABI
validation runs in CI from this milestone with the **skeleton's ABI dump
committed** — an empty baseline under a declared surface gates nothing;
evaluate the Kotlin Gradle plugin's built-in ABI validation against the
standalone kotlinx validator and pin one. CI skeleton: JVM unit tests + lint on
push, one instrumented smoke test on a Gradle-managed emulator — CI emulator
setup is a known tar pit, so it is proven here, not discovered in M8.

Two risk-retirement acceptance items:

- **The spike**: a throwaway-quality but compiling skeleton of the spec §2
  public surface plus the risky ingredients — `explicitApi` over the whole
  surface (including the reified `json` factory, which must be `public inline`),
  the single-threaded-dispatcher runtime scope and its clean shutdown (the
  thread must be provably released, not leaked), channel-per-collector emission
  from a synchronous `activate()`, and the `ProcessLifecycleOwner` binding
  installing its observer and reading the initial state atomically on the main
  thread — plus a tiny consumer fixture (an app module in the repo consuming
  the library like a real dependency, declaring a `Flags` object and an
  operator read).
- **The publishing pipe**, without publishing anything immutable: build, sign,
  and upload a user-managed deployment to the Central Portal; wait for
  `VALIDATED`; resolve it by coordinates in the consumer fixture through the
  Portal's authenticated manual-testing repository; then **drop the
  deployment**. Central releases are immutable and are not scaffolding — the
  first real publication is M9's 0.1.0. Namespace verification for
  `dev.forcetower` (covering the `dev.forcetower.lever` group) and CI signing
  keys land here.

**Done when:** CI is green (JVM + managed-device smoke) with the ABI check
enforcing the committed dump, the consumer fixture compiles against the
declared surface, and a validated deployment resolves through the
manual-testing repository and is dropped without a release.

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
integer lexemes at the JavaScript safe-integer boundary — 2⁵³ − 1, 2⁵³, and
2⁵³ + 1 **all decode exactly into `Long`** per the shared decoder rule
(spec §2.2: wire behavior, no Android-only safe-range mismatch),
failing `json` through both the reified and explicit-serializer factories} —
plus the validation cases (Unicode boundaries via UTF-16 length, 21 valid
attributes under different insertion orders selecting the same 20, overlong
platform/appVersion omitted, the base-URL throwing matrix — non-http(s)
schemes, missing host, relative input, userinfo — alongside query/fragment
stripping and byte-exact base-path joining, interval input across
negative/zero/sub-60 s/60 s/over-365-days/`Duration.INFINITE` with saturating
arithmetic at the extremes, and mutation of the caller's original attributes
map never changing the validated context), all through a recording log sink
asserting warn/info/error behavior including the per-`(key, version, type)`
dedupe.

## M3 — storage

Cache codec + store (spec §7 → spec 0002 §7 + §12/§12.1): the identity/snapshot
file split, key-hash naming over `canonicalBaseURL + namespace`, atomic writes,
raw-payload round-trip, first-run identity persistence via **temp-file +
hard-link publication** (the name never exists before its complete bytes; the
loser's link fails and it re-reads the winner), `clientId` canonicalization
(unparseable regenerates; non-canonical casing rewrites in place),
corrupt/wrong-schema → warn + first-run behavior, timestamp validity (negative
Unix seconds are corrupt; extreme values saturate, never overflow),
write-failure policy, `noBackupFilesDir` default resolution. File-system tests
run against temp directories on the JVM — no Android APIs in the codec.

**Done when:** round-trip, corruption, schema-bump, and stable-hash tests pass;
`clientId` and (with `cacheNamespace` set) the snapshot survive a simulated key
rotation; racing first initializers converge on one **complete** UUID with no
reader ever observing an empty or partial identity file; an uppercase UUID is
canonicalized without changing identity while garbage regenerates; negative
and extreme timestamps behave per spec; the **cross-SDK format promise** holds
as specified — lever-swift's committed format fixtures decode unmodified, and
an emit-then-decode round-trip asserts schema- and value-identity (bytes
explicitly not compared); and one instrumented test exercises the
link/atomic-replace primitives on the real `noBackupFilesDir` filesystem, not
only the host JVM's.

## M4 — client core

`LeverClient` minus networking: the lock-protected state box (activated +
staged representations each owning their etag/fetchedAt metadata, derived
`lastKnownVersion` — spec 0002 §4), synchronous `get`/`value` reads with
type-keyed JSON memoization, `activate()` with representation-commit vs.
value-change semantics and raw-diff `changedKeys`, cache load in the
constructor and persist through the commit gate with §12.1 sequencing
(spec §4 — synchronous activation is a durability boundary), the
channel-per-collector `updates` fan-out with `trySend` delivery, the full
`close()` contract with its commit-gate linearization, and the `Lever` object
with its reserved atomic installation and `IllegalStateException` misuse rules
(spec §2.1, §4). Staged representations are injected directly by tests — no
transport yet; the races that need a real fetch or a real 304 belong to M5.

**Done when:** the spec 0002 §10.2 staging semantics pass (stage-then-read
stability, no-op activate emits nothing, `changedKeys` exact, metadata-only
commits advance `activatedVersion`/ETag/cache silently, first activation of
version 0 yields `activatedVersion == 0`); the same wire key decodes correctly
through two Kotlin types; a log sink performing synchronous reads while
handling a message does not deadlock (no-callout-under-lock; control ops from
a sink are documented as programmer error, not tested as supported); the
**commit gate is a durability boundary and a strict-order turnstile** —
reconstructing a client immediately after `activate()` returns observes the
new snapshot without advancing any test dispatcher, a process-death simulation
at the return boundary restores the committed snapshot, activation invoked
from the runtime dispatcher does not deadlock, and two concurrent activations
whose gate-arrival order is inverted from their commit order are processed in
commit order end to end — disk, log, *and* collector event order all match
activation order (asserted on the delivered sequence, not only final disk
state), with a failed persist logging and still advancing its ticket; `updates` delivers every post-subscription update to multiple
concurrent collectors, a deliberately stalled collector absorbs a burst with
no loss and no blocking of synchronous `activate()`, and close completes
current collectors while later ones get an already-completed flow; the
**close linearization** is proven with barriers, not stress — an activation
paused after its state-lock phase makes a concurrent `close()` wait for its
persist/log/deliver phase, an activation arriving after the closed mark
returns `false` with no write, no log, and no delivery, a channel closed
between capture and `trySend` neither blocks nor throws, no sink invocation
begins and no new update is enqueued after `close()` returns while a stalled
collector still drains what was enqueued before the boundary, and close never
waits on a stalled collector — plus repeated and concurrent close, reads
surviving, control ops behaving per spec §4, and closing the installed
`Lever.shared` throwing; concurrent `configure`
produces exactly one installed client with no orphaned runtime, and a failed
construction releases the reservation; reads serve cached values before any
coroutine runs; and singleton tests use an internal testing reset while the
production `IllegalStateException` stays intact.

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
an invalid 200 body changes nothing; a 304 freshness write for the activated
representation racing an activation regresses neither values nor freshness
metadata (M4's commit gate and sequencing, now exercised by real transport);
`close()` racing a real coalesced fetch resolves per the spec §4 linearization
rule; coalescing collapses concurrent fetches to one request; one waiter's
cancellation leaves the shared fetch running and rethrows
`CancellationException` unwrapped.

## M6 — runtime: scheduling and lifecycle

The runtime scope (spec §5): the two time seams (wall-clock provider +
virtual-time dispatcher), the automatic fetch path with **the first reported
lifecycle phase as its one trigger** (spec 0002 §12 — no separate
construction-time fetch), the interval clock + in-session timer with the
hot-loop guards, the `ProcessLifecycleOwner`-backed notification source behind
its seam (initial state included), cache-only mode
(`automaticUpdates = false`), and `close()` releasing everything.

**Done when:** `runTest` virtual-time tests prove: the initial phase delivery
causes **exactly one** automatic eligibility check and at most one request —
including when that first attempt fails on a first run — with no duplicate
init trigger; construction inside the interval issues no request, outside it
fetches; the timer fires at `lastFetchAt + interval` and re-arms; zero
interval never loops (no timer), sub-60 s polls at the floor while lifecycle
edges keep the configured value, exactly 60 s runs as configured; a failed
automatic fetch re-arms from the attempt, including first-run offline;
wall-clock jumps do not disturb the timer; background cancels the timer; a
client constructed while already foregrounded runs the foreground path
(Robolectric where the real `ProcessLifecycleOwner` is exercised); explicit
`fetch()` ignores the interval; a cache-only client starts no
fetch/timer/lifecycle/SSE while reads and explicit fetch still work; and
`close()` is asserted to remove the lifecycle observer, shut down the
dispatcher's thread without leaking it, and suppress every callback past the
boundary — resource release, not just job cancellation.

## M7 — SSE

Parser first — a port of the Swift parser (pure function over byte chunks:
frames across boundaries, heartbeats, CRLF/LF, `retry:` discarded, the 1 MiB
frame bound accounted per spec 0002 §12.1: counted before appending, across
every field kind and comments) — then the spec 0002 §6.2 state machine on the
runtime: connect validation before any byte reaches the parser, idle watchdog
(OkHttp read timeout disabled on the stream call; the byte reader chunks on
size as well as newlines), full-jitter backoff with injected RNG, 503
`Retry-After` floor, 401 stop-until-foreground, foreground/background
connect/teardown, and §5.3 nudge handling — dedupe against `lastKnownVersion`,
the pending token during an in-flight fetch, and **join semantics**
(spec 0002 §12.1): a nudge joins whatever transport work answers it and
applies its own activation policy when that work completes.

**Done when:** the spec 0002 §10.3 suite passes on virtual time + scripted byte
streams, including connect validation (a 200 HTML error page fails fast into
backoff), the replayed connect frame after a missed publish → exactly one
fetch, a *lower* announced version → fetch, the pending-nudge orderings (one
follow-up, several coalesce to one, already-covered yields none), an
auto-activating nudge that joins a **staging-only** `fetch()` in flight
activating the fetched representation when the shared work completes, a peer
that streams more than 1 MiB without a newline being bounded below the parser,
a round that received a frame resetting its retry counter but still backing
off before reconnecting, backgrounding during connect/backoff tearing down
cleanly, and stream cancellation never logged or retried as a transport
failure.

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
recommendation, the integer safe-range bound, cache-only reader mode, nudge
auto-activation opt-out), R8 consumer rules verified against a minified
consumer fixture build, the ABI dump **reviewed and finalized** (it has been
enforced and intentionally updated since M1 — this is sign-off, not creation),
docs pass over KDoc on the public surface. Tag **0.1.0** — the **first real
Central publication** (M1 only validated and dropped) — through the M1 pipe.

**Done when:** the full CI matrix is green on the tag and the published
artifact resolves into a fresh sample app by coordinates alone.

## M10 — the flagship audit (starts first; its facts gate M1)

The research 0003 §2 audit debt, paid in the flagship's repo — in two tiers,
because two of its findings can invalidate the SDK's *shape*, not just the
migration:

- **Foundational facts, required before M1 merges:** the app's real minimum
  SDK (a flagship below API 26 cannot consume the library as specified) and
  its process topology (an unexpected secondary process changes the lifecycle
  and cache-writer assumptions baked into M1's skeleton).
- **Migration facts, parallel with M1–M9:** key inventory (names, types,
  defaults), where values cross module boundaries, whether the realtime
  listener is wired, and the seam flags are published through today. The
  outcome is a migration checklist appended to research 0003 — the SDK does
  not change; the *plan* for M11 does, if this tier surprises.

**Done when:** the foundational facts are recorded in research 0003 before M1
merges, the full findings and M11's checklist land before M11 starts, and any
assumption this plan got wrong is corrected here.

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

M1→M8 are strictly sequential (each builds on the last). M10 starts first: its
foundational tier (platform floor, process topology) gates M1's merge, and its
migration tier runs parallel to everything else. M9 needs M8; M11 needs
M9 + M10. The critical path is the M2–M7 core, and it should move faster than
Swift's did: the fixtures, the behavioral contract, the review passes, *and*
the implementation-review resolutions (spec 0002 §12–§12.1) are inherited, not
re-litigated — where a question comes up that spec 0002 already answered, the
answer is the citation, not a new debate.
