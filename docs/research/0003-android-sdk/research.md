# 0003 — lever-android: the Android SDK

- **Status:** pre-implementation (scope settled 2026-08-14)
- **Date started:** 2026-08-14
- **Scope:** the Android client SDK — a library any Android app adds, configures
  with a URL + client key, and reads config through. The server contract is fixed
  by spec 0001; the client behavioral contract was settled by spec 0002 and its
  two review passes. This document decides what is *Android-specific*.

> Research documents capture where we came from, what we're thinking, and what
> purpose we're after — _before_ a spec pins down the how. A spec should be able
> to cite this document for every "why".

## 1. Purpose — what we're after

The Swift SDK is implemented (plan 0002, M1–M10 landed) and set the template
research 0002 §7 predicted it would: lifecycle ownership, the typed-key model,
staged activation, representation-owned metadata, the nudge policy, and the
three-layer floor are settled *SDK semantics* now, not Swift decisions. The
Android SDK's job is to port that contract into idiomatic Kotlin — deliberately
copying behavior, not re-deriving it — and to prove the cross-SDK story: the
same contract fixtures replaying in a second language against the same service.

The consumer is the flagship's **Android app** — the same product whose iOS app
drove the Swift SDK, with its own live Firebase Remote Config integration to
replace. As with iOS, that migration is the acceptance test, and the app stays
anonymous in public docs.

After v1, an Android developer can:

- `Lever.configure(context, …)` in `Application.onCreate` and read typed values
  synchronously anywhere, with a `Flow` of updates for reactive consumers.
- Kill the network entirely and still get last-activated values, or code
  defaults on a first run — the three-layer floor, proven by tests.
- Watch a gate flipped in the dashboard land in a foregrounded app within
  seconds via the SSE nudge.

## 2. Where we came from

Two inheritances, one audit debt:

- **The settled contract.** Spec 0002 §2.3–§7 (as amended by both review passes)
  is the behavioral reference: read resolution, validation-and-omission policy,
  representation commit vs. observable change, pending-nudge handling, hot-loop
  guards, the two-file cache with rotation-stable identity, SSE state machine.
  Every one of those was hard-won; none of them are reopened here.
- **The flagship shape.** The iOS audit (research 0002 §2) found the pattern
  lever must slot into: a thin one-file seam publishing flags outward, defaults
  scattered at call sites, realtime flips load-bearing. The Android app is the
  same product on Firebase Remote Config and is expected to mirror that shape.
- **Audit debt:** the Android app has not been audited the way the iOS app was.
  Before the plan's acceptance milestone is written, the same audit must happen:
  key inventory, where values cross module boundaries, whether the realtime
  listener is wired, min-SDK reality. The spec does not need it; the migration
  milestone does.

## 3. The forks and how they were called

Settled in a scoping interview, 2026-08-14.

### 3.1 Home: **its own public repo, `lever-android`, on Maven Central**

Same reasoning as `lever-swift` (research 0002 §3.1): a dedicated repo with its
own semver tags, consuming the monorepo's `packages/contract-fixtures` in CI via
a pinned SHA. Distribution is **Maven Central** under the domain-verified
`dev.forcetower` namespace — plain coordinates
(`dev.forcetower.lever:lever-android`; a verified namespace covers its
subgroups), no consumer-side repository setup, which
JitPack and GitHub Packages both fail at for a public SDK. The name says
*android*, not *kotlin*, because the library is Android-only (§3.2) and platform
is what consumers search for.

### 3.2 Platform floor: **Android-only, minSdk 26, Kotlin 2.x**

Not Kotlin Multiplatform. The Swift SDK already covers every Apple platform,
server-side consumers get the TypeScript SDK (research 0001 §8), and KMP's
expect/actual seams and build complexity would buy reach nobody has asked for.
An AAR library module it is.

`minSdk 26` (Android 8.0): `java.time` and modern file APIs without desugaring,
~97% device coverage — the common floor for libraries that want clean code.
Kotlin 2.x, JVM toolchain 17, `explicitApi()` mode so the public surface is a
deliberate act, and the binary-compatibility validator wired from the first tag
so 1.0 can actually freeze something.

### 3.3 Dependencies: **coroutines + kotlinx.serialization + OkHttp (+ lifecycle-process)**

Swift's zero-dependency stance (research 0002 §3.7) does not translate: on
Apple platforms Foundation ships an HTTP client, a JSON codec, and structured
concurrency; the Android SDK ships none of that at comparable quality. The
Android equivalent of "Foundation only" is four boring, ubiquitous libraries:

- **kotlinx-coroutines** — effectively part of the language; the `suspend`
  surface and the runtime's confinement model are built on it.
- **kotlinx-serialization** — the wire codec and cache codec. Also what gives
  `json` keys their `KSerializer` seam.
- **OkHttp** — the de-facto standard HTTP client virtually every Android app
  already ships; battle-tested connection management and a streaming response
  body good enough for SSE. The alternative — hand-rolling transport on
  `HttpURLConnection` to save a dependency — was rejected: it trades a
  dependency consumers already have for owning timeout/cancellation/socket-reuse
  edge cases the floor depends on. The SDK uses OkHttp's raw streaming response
  and keeps **its own SSE parser** (a port of the fixture-tested Swift one)
  rather than `okhttp-sse` — backoff, watchdog, and dedupe stay client-owned
  per spec 0001 §7, and the parser semantics stay identical across SDKs.
- **androidx.lifecycle-process** — `ProcessLifecycleOwner` is the canonical
  process-level foreground signal and answers the initial-state requirement
  (spec 0002 §5.2, review pass 2) out of the box. Counting activities by hand
  via `registerActivityLifecycleCallbacks` re-solves problems androidx already
  solved.

Nothing else. No Compose, no WorkManager, no DataStore.

### 3.4 Value access: **typed key objects, mirrored from Swift**

Keys are declared once as typed constants carrying their code default — the
research 0002 §3.4 rationale (the default cannot drift between call sites)
applies verbatim:

```kotlin
object Flags {
    val enableEnrollment = LeverKey.boolean("enable_enrollment", default = false)
    val maxRetries = LeverKey.int("max_retries", default = 3)
    val paywall = LeverKey.json("paywall", default = PaywallConfig.Standard)
}

if (lever[Flags.enableEnrollment]) { … }
```

Property-delegate sugar (`val x: Boolean by lever.boolean(…)`) was considered
and deferred: it hides the client reference, complicating multi-instance use
(tests, staging-vs-prod), and can be layered on later without breaking the key
model. Reads are synchronous, non-optional, infallible — same contract as
spec 0002 §2.3.

### 3.5 Reactivity: **coroutines only; no Compose artifact in v1**

The core exposes updates as a hot `Flow` — the Android analogue of the Swift
`updates` stream. Compose apps bridge with one idiomatic line
(`collectAsState`); a `lever-compose` artifact with per-key `State<T>` is a
post-1.0 addition *if* the flagship migration shows real friction. Shipping two
artifacts before the base API is validated doubles the freeze surface for
sugar. This is research 0002 §3.7's framework-agnostic posture, ported.

### 3.6 Transport and lifecycle: **same machine, Android signals**

SSE ships in v1 for the same reason it did on iOS (research 0002 §3.6): the
flagship's realtime flips are load-bearing. The state machine, backoff, idle
watchdog, connect validation, and pending-nudge semantics are spec 0002's,
unchanged. Foreground/background comes from `ProcessLifecycleOwner` behind the
same injected notification-source seam, initial state included.

### 3.7 Storage: **the spec 0002 two-file cache, in `noBackupFilesDir`**

The cache format (identity file + snapshot file, rotation-stable namespace,
raw wire payload) ports byte-for-byte — there is no reason for two schemas.
The Android-specific call is the *location*: default
`context.noBackupFilesDir/lever/`. Android Auto Backup silently clones app data
onto new devices and reinstalls; a backed-up `clientId` would violate its
definition as an *installation* identifier (spec 0002 §7) and pre-bias future
percentage rollouts, and a restored stale snapshot is exactly the
backup-restore case the version-identity rule heals with one fetch. Excluding
the cache from backup makes both problems structural non-events. A cache is
the one thing that is always safe to lose.

## 4. Strategy — the shape

### 4.1 The contract

```kotlin
// Application.onCreate
Lever.configure(this, LeverConfiguration(
    baseUrl = "https://config.example.dev",
    clientKey = BuildConfig.LEVER_KEY,      // pk_…, an identifier, not a secret
    context = LeverContext(
        appVersion = BuildConfig.VERSION_NAME,
        attributes = mapOf("cohort" to "beta"),
    ),
))

// Reads — synchronous, stable until the next activation
if (Lever.shared[Flags.enableEnrollment]) { … }

// Explicit control when wanted
lever.fetch()                    // suspend; stages, reads unchanged
lever.activate()                 // synchronous; true if serving values changed
lever.fetchAndActivate()

lever.updates.collect { … }      // emits on every value-changing activation
```

### 4.2 Concurrency shape

The spec 0002 §4.1 ownership boundary, translated: a lock-protected client core
owns snapshot state and everything synchronous (reads, staging, `activate()`);
a runtime confined to a single-threaded dispatcher — the coroutine analogue of
the Swift actor — owns scheduling, lifecycle reaction, fetch execution, SSE,
and every job, so cancellation has one home. The no-callout-under-lock rule and
teardown semantics port unchanged. `suspend fetch()` rethrows
`CancellationException` untouched — structured concurrency's rule and
spec 0002's F11 resolution agree here.

One Android-specific wrinkle: `configure` performs the synchronous cache read
on the calling thread, and Android convention (StrictMode) frowns on main-thread
disk I/O. The call: do it anyway, documented. It is one small file read once in
`Application.onCreate` — where every process-start library does exactly this —
and the alternative (lazy-load on first read) moves the same I/O to a *less*
predictable thread, or worse, gives up the floor's "correct from the first
statement" guarantee. The read is measured in the low milliseconds; the README
says so and shows the `Application.onCreate` placement.

### 4.3 Tests

JVM-first: the model, storage, core, transport, runtime, and SSE suites run as
plain JVM unit tests — `kotlinx-coroutines-test` gives virtual time (the manual
clock the Swift suite had to inject by hand), and storage tests run against
temp directories with no Android APIs. Robolectric only where a real `Context`
or `ProcessLifecycleOwner` is unavoidable; an instrumented smoke test on an
emulator in CI proves the AAR actually loads. The contract fixtures
(`packages/contract-fixtures/fixtures/http/`, authored during Swift M9) replay
through the transport double — same tapes, second language, per research 0001
§7. Kotlin makes one Swift headache free: `String.length` already counts UTF-16
code units, so the server's length semantics need no translation layer.

## 5. The cut

**v1 (`lever-android` 0.x → 1.0):** the library as scoped above — typed keys,
three-layer floor, fetch-and-activate, SSE nudges with polling degradation,
`Flow` updates, cache-only reader mode (`automaticUpdates = false`), injectable
logging, contract-fixture CI, Maven Central publishing. 1.0 is tagged only
after the flagship's Android migration ships.

**Later:** property-delegate sugar; a `lever-compose` artifact; codegen of key
declarations (`lever pull --kotlin`, the 0001 §5 CLI); WorkManager background
refresh if launch staleness ever matters in practice.

## 6. Non-goals

- **No local rule evaluation** — same invariant as every SDK (0001 §3.1).
- **No Kotlin Multiplatform** — Apple platforms have lever-swift; servers get
  TypeScript.
- **No bundled framework integrations** — no Compose dependency in the core, no
  Hilt module, no RxJava shims; hosts wrap the core.
- **No secrets in config values** — repeated loudly in the README, per 0001 §6.

## 7. Risks

- **Behavioral drift from the Swift SDK.** Two hand-written implementations of
  one contract will diverge wherever the contract is only prose. Mitigations:
  spec 0003 *cites* spec 0002 rather than paraphrasing it, and the shared HTTP
  fixtures are the executable tether — anything they don't cover is where drift
  will live, so growing them is cheaper than growing either spec.
- **Public API under `explicitApi` + semver is hard to walk back.** Same shape
  as the Swift risk; same mitigation — 0.x shakes the API out against the
  flagship before 1.0, and the binary-compatibility validator makes breaks loud.
- **Process death and OEM lifecycle chaos.** Android kills processes freely and
  OEMs bend lifecycle rules. The design already assumes death at any moment
  (staged state is lost by design; the floor is the disk file), but the
  foreground-signal tests need to cover cold start, warm start, and
  already-foregrounded construction explicitly.
- **The unaudited flagship.** The migration milestone is written against an
  assumption of iOS-parity. If the Android integration turns out to be shaped
  differently, the *plan* changes — the SDK should not.

## 8. Next step

Spec 0003: the Android SDK — package layout and tooling, the Kotlin public API
surface, the concurrency mapping, transport and storage deltas, and the test
plan. Then the audit of the flagship Android app, the plan, the `lever-android`
scaffold, and the migration as acceptance.
