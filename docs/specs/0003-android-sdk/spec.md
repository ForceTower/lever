# Spec 0003 — The Android SDK

- **Status:** pre-implementation (settled 2026-08-14)
- **Research:** [0003 — lever-android](../../research/0003-android-sdk/research.md)
- **Scope:** the Android client SDK — package layout, public API, concurrency
  mapping, platform integration, transport and storage deltas, tests. The wire
  contract is fixed by [spec 0001](../0001-service/spec.md) §5–§7. The **client
  behavioral contract** — read resolution, validation policy, snapshot/state
  semantics, scheduling, SSE, cache format — is fixed by
  [spec 0002](../0002-swift-sdk/spec.md) as amended by its two review passes
  **and including its implementation notes (§12) and implementation-review
  resolutions (§12.1)**, which are inherited contract, not Swift trivia — the
  identity-publication primitive, snapshot commit sequencing, singleton
  reservation, the unified init/lifecycle trigger, nudge join-and-apply-policy,
  frame-budget accounting, saturating time arithmetic, and `clientId`
  canonicalization all bind this SDK. It is **cited, not restated**, here. Where this spec says "per spec 0002 §N",
  that section is normative for this SDK with Swift types read as their Kotlin
  counterparts; only deltas are spelled out. This is the drift defense named in
  research 0003 §7: one prose contract, cited twice, tethered by shared fixtures.

## 1. Package layout

The SDK lives in its own public repo, `lever-android` (research 0003 §3.1),
published to **Maven Central** as `dev.forcetower.lever:lever-android` — the
group names the product (and matches the Kotlin package), the artifact names the
platform, and sibling artifacts (`lever-compose`, if it ever lands — §11) get an
obvious home. This spec stays in the lever monorepo with the rest of the design
history.

```
lever-android/
  settings.gradle.kts / build.gradle.kts   // version catalog, publishing, BCV
  lever/                                   // the single library module → AAR
    build.gradle.kts
    src/main/kotlin/dev/forcetower/lever/
      Lever.kt                 // Lever object: configure + shared
      LeverClient.kt           // the client: reads, fetch/activate, updates
      LeverConfiguration.kt    // configuration + context + platform
      LeverKey.kt              // LeverKey factories, value decoding
      LeverException.kt
      logging/                 // LeverLogSink, LeverLogLevel, LogcatSink
      runtime/                 // internal: scheduling, lifecycle, SSE
      transport/               // resolve client, SSE parser, endpoints
      storage/                 // cache file codec + store
    src/test/kotlin/           // JVM suites (the bulk — §10)
    src/androidTest/kotlin/    // instrumented smoke
```

- **Toolchain:** Kotlin 2.x, JVM toolchain 17, AGP current stable,
  `minSdk 26` / `compileSdk` current (research 0003 §3.2) — with **exact
  versions pinned in the version catalog at M1**; "2.x" and "current" are
  design constraints, not reproducible build inputs. `explicitApi()` mode plus
  ABI validation from M1: evaluate the Kotlin Gradle plugin's built-in ABI
  validation against the standalone kotlinx binary-compatibility validator,
  pin one, and commit the ABI dump with the first surface skeleton — an
  enforced dump from day one, not an empty baseline that gates nothing. The
  public surface is a deliberate act, and 1.0 must have something enforceable
  to freeze.
- **Dependencies** (research 0003 §3.3, closed list): kotlinx-coroutines,
  kotlinx-serialization-json, OkHttp, androidx.lifecycle-process. Nothing else;
  no Compose, no WorkManager, no DataStore. The AAR ships consumer R8 rules for
  its own internals; `json`-key model classes are the consumer's
  `@Serializable` types and follow the consumer's own serialization rules.
- **Releases:** semver tags on `main`, published to Central from CI; 0.x until
  the flagship Android migration validates the API, then 1.0 freezes it
  (research 0003 §5).
- **CI** (GitHub Actions, ubuntu runner): JVM unit suites + lint on every push;
  an instrumented smoke test on a Gradle-managed emulator proves the AAR loads
  and the `ProcessLifecycleOwner` binding works on a real stack. A pinned-SHA
  checkout of the lever monorepo provides `packages/contract-fixtures` for the
  replay suite (spec 0002 §10.4); bumping the pin is the contract-sync act.

## 2. Public API surface

The entire public surface, as the contract to freeze (package
`dev.forcetower.lever`):

```kotlin
public object Lever {
    public fun configure(context: Context, configuration: LeverConfiguration)
    public fun configure(context: Context, baseUrl: String, clientKey: String,
                         leverContext: LeverContext = LeverContext())
    public val shared: LeverClient
}

public class LeverClient(context: Context, configuration: LeverConfiguration) {
    // Reads — synchronous, non-optional, stable between activations.
    public operator fun <V> get(key: LeverKey<V>): V
    public fun <V> value(key: LeverKey<V>): V

    // Control.
    public suspend fun fetch()                       // stages
    public fun activate(): Boolean                   // true if the serving values changed
    public suspend fun fetchAndActivate(): Boolean

    // State.
    public val activatedVersion: Int?                // null until first activation ever; 0 after
                                                     // activating a never-published environment
    public val updates: Flow<LeverUpdate>            // emits on value-changing activations

    public fun close()                               // teardown — the full contract is §4;
                                                     // idempotent; a programmer error on the
                                                     // installed Lever.shared instance
}

public class LeverConfiguration(
    public val baseUrl: String,                      // http(s); parse failure is a programmer
                                                     // error → IllegalArgumentException
    public val clientKey: String,                    // pk_… — an identifier, not a secret
    public val context: LeverContext = LeverContext(),
    public val minimumFetchInterval: Duration = 12.hours,
    public val automaticUpdates: Boolean = true,     // false → cache-only reader (spec 0002 §5)
    public val autoActivateOnNudge: Boolean = true,
    public val cacheDirectory: File? = null,         // null → context.noBackupFilesDir (§7)
    public val cacheNamespace: String? = null,       // stable cache identity (spec 0002 §7)
    public val logSink: LeverLogSink = LogcatSink(),
)

public class LeverContext(
    public val platform: LeverPlatform = LeverPlatform.CURRENT,   // "android"
    public val appVersion: String? = null,
    public val attributes: Map<String, String> = emptyMap(),      // strings only (spec 0001 §11)
)

@JvmInline
public value class LeverPlatform(public val rawValue: String) {
    public companion object { public val CURRENT: LeverPlatform } // "android"
}

public class LeverKey<V> internal constructor(
    public val name: String,
    public val defaultValue: V,
    /* internal decoder (RawValue) -> V? */
) {
    public companion object {
        public fun boolean(name: String, default: Boolean): LeverKey<Boolean>
        public fun string(name: String, default: String): LeverKey<String>
        public fun int(name: String, default: Int): LeverKey<Int>
        public fun long(name: String, default: Long): LeverKey<Long>
        public fun double(name: String, default: Double): LeverKey<Double>
        public fun <T> json(name: String, default: T,
                            serializer: KSerializer<T>): LeverKey<T>
        public inline fun <reified T> json(name: String, default: T): LeverKey<T>
    }
}

public data class LeverUpdate(
    public val version: Int,                         // the version whose activation changed the
                                                     // serving values (metadata-only commits are
                                                     // silent — spec 0002 §4)
    public val changedKeys: Set<String>,
)

public sealed class LeverException : Exception() {   // every case is a class instantiated per
                                                     // failure — a Throwable carries mutable
                                                     // stack-trace/suppressed state, so
                                                     // singletons are unsafe
    public class InvalidKey : LeverException()       // 401 — key unknown or rotated
    public class Server(public val status: Int) : LeverException()
                                                     // any HTTP status other than 200/304/401
    public class Network(override val cause: IOException) : LeverException()
    public class InvalidResponse : LeverException()  // malformed response: undecodable body,
                                                     // non-HTTP transport event, unsolicited 304
}

public fun interface LeverLogSink {
    public fun log(level: LeverLogLevel, message: String)
}
public enum class LeverLogLevel { DEBUG, INFO, WARN, ERROR }
public class LogcatSink : LeverLogSink              // the default sink (§8)
```

### 2.1 The shared instance

Per spec 0002 §2.1, with the platform-native failure: reading `shared` before
`configure`, or calling `configure` twice, throws `IllegalStateException` with a
message naming the fix (the Kotlin analogue of `preconditionFailure`; there is
no lazy placeholder client). Installation follows spec 0002 §12.1: it moves
`empty → reserved → installed` atomically, client construction happens outside
the lock (it touches the filesystem and the host's sink), and a construction
failure releases the reservation and rethrows — two racing `configure` calls
can never both build a live runtime. Every client — `configure` and explicit
`LeverClient(context, …)` alike — retains only `context.applicationContext`,
never an Activity. Multiple explicit instances are always allowed; `shared` is
sugar, not a registry.

### 2.2 Keys and reads

Apps declare keys once, as typed constants in an object (research 0003 §3.4):

```kotlin
object Flags {
    val enableEnrollment = LeverKey.boolean("enable_enrollment", default = false)
    val paywall = LeverKey.json("paywall", default = PaywallConfig.Standard)
}

if (lever[Flags.enableEnrollment]) { … }
```

- `LeverKey` carries an internal decoder installed by the factories; the reified
  `json` overload resolves `serializer<T>()` at the declaration site and
  delegates to the explicit-`KSerializer` factory (which exists for types whose
  serializer can't be reified — generic types, hand-written serializers). The
  SDK's internal `Json` instance is fixed: a passed `KSerializer` carries its
  own decoding logic, but there is no way to install a `SerializersModule` into
  the SDK — contextual/polymorphic setups must be self-contained in the
  serializer.
- `int` (32-bit) and `long` both map wire `number`; a value outside the key's
  range is a type mismatch per spec 0002 §2.3 (default + deduped warn), same as
  a fractional part. **The read rule is the shared one, unchanged**: any
  integral wire value exactly representable in the requested type decodes —
  there is no Android-only safe-range mismatch, because one behavioral
  contract across SDKs outranks a stricter local rule. The JavaScript
  safe-integer bound (|n| ≤ 2⁵³ − 1) is **authoring guidance, not decoder
  behavior**: the service cannot preserve larger integers, so such a value may
  arrive already rounded and the SDK cannot detect it. `long` widens the
  Kotlin-side range beyond `Int` — and the decoder will faithfully accept an
  exact lexeme beyond 2⁵³ — but authors cannot rely on the service preserving
  such values; the README warns about the bound.
- There is no `@dynamicMemberLookup` analogue and no delegate sugar in v1
  (research 0003 §3.4); `lever[key]` / `value(key)` is the whole read surface.
- `json` model types should be immutable (`val`s, data classes) — the
  "stable between activations" guarantee is about SDK storage, not aliasing
  (spec 0002 §2.2).

### 2.3 Read semantics

Per spec 0002 §2.3, unchanged: absent → default (deduped `DEBUG` log); mismatch
→ default + one `WARN` per `(key, version, Kotlin type)`; decode-once
memoization keyed by `(key, representation, requested type)`. Reads never throw
and are never nullable. The type mapping row for Kotlin:
`Boolean ↔ boolean`, `String ↔ string`, `Int`/`Long`/`Double ↔ number` (integer
keys require an exactly-representable integer in the key's range),
`@Serializable T ↔ json`.

## 3. Configuration validation

Per spec 0002 §3 in full — omission-over-400 policy, semver zero-padding,
deterministic attribute dropping, base-URL canonicalization, interval clamping
(including §12.1's 365-day cap and saturating arithmetic) and the sub-60 s
notice — with these Kotlin notes:

- All limits count UTF-16 code units; Kotlin `String.length` *is* UTF-16 code
  units, so the server's JavaScript semantics need no translation
  (research 0003 §4.3).
- **The throwing boundary is "not an absolute http(s) origin".** `baseUrl`
  arrives as `String`; anything that cannot serve as one — unparseable input, a
  non-`http(s)` scheme, a missing host, a relative URL, or **userinfo**
  (credentials embedded beside an `Authorization` header are rejected, not
  stripped) — is an `IllegalArgumentException` from the `LeverConfiguration`
  constructor, the analogue of Swift's compile-time `URL` type and the one
  validation that throws. A parseable origin then follows spec 0002 §3's
  repair-and-log rules: query/fragment stripped with a `warn`, trailing
  slashes stripped, host lowercased; a base path is preserved and joining is
  pinned by byte-exact request tests.
- `Duration.INFINITE` and anything above 365 days clamp to the 365-day cap
  with a `warn` (spec 0002 §12.1); negative durations clamp to `.ZERO` per
  spec 0002 §3.
- Caller-owned mutable inputs are **snapshotted at construction**:
  `attributes` (and any future collection input) is defensively copied before
  validation, and the SDK operates only on the validated internal copy —
  mutating the original map after construction can never change request
  context or bypass validation.

## 4. Snapshots, state, and the concurrency mapping

State semantics per spec 0002 §4 in full: representation-owned metadata
(`activated` / `staged` each carrying `etag`/`fetchedAt`), derived
`lastKnownVersion`, representation-commit vs. observable-value-change
`activate()`, version-0 commits, metadata-only persistence.

The spec 0002 §4.1 ownership boundary maps onto Kotlin as follows
(research 0003 §4.2):

- **Client core** — a lock-protected state box owning snapshots and everything
  synchronous: reads, staging, `activate()`. The **no-callout-under-lock rule
  ports verbatim**: no sink call, no `Flow` emission, no file I/O, no
  serialization work while holding the lock; activation computes and swaps
  under the lock, then persists, logs, and emits outside it.
- **Runtime** — an internal class owning a `CoroutineScope` on a dedicated
  single-threaded dispatcher: the coroutine analogue of the Swift actor.
  Scheduling, lifecycle reaction, fetch execution, SSE, and every `Job` live in
  this scope, so cancellation has one home. The runtime calls into the
  thread-safe core; the core never calls into the runtime. `fetch()` suspends
  into the runtime; `activate()` runs synchronously in the core.
- **Persistence and callouts run under a commit gate, and synchronous
  activation is a durability boundary.** The gate is a turnstile, never held
  together with the state lock, spanning the post-swap phase of a commit:
  persist, log, deliver updates. Tickets are the commit sequence
  (spec 0002 §12.1), allocated under the state lock, and the gate **admits
  strictly in ticket order regardless of arrival order** — commit 2 reaching
  the gate first waits for commit 1 — so disk order, log order, and update
  delivery order all equal activation order, and no commit is ever silently
  discarded or emitted late. A failed persist logs and still advances the
  ticket (a wedged queue must not follow a full disk). One consequence, stated
  for emphasis: an older commit can never land on disk after a newer one.
  `activate()` **does not return until its ticket's snapshot write has
  completed or failed-and-logged**: the caller that observed a completed
  activation must find it after process death, or the floor quietly regresses
  a version. Persistence is never a hop to the runtime dispatcher — a
  synchronous dispatch would deadlock the moment activation originates *on*
  that dispatcher, which is exactly what nudge auto-activation does. A 304's
  freshness write takes a ticket through the same gate.
- **`updates`** — the direct port of spec 0002 §4.1's per-consumer streams,
  not a `SharedFlow`: each collector registers its own **unlimited `Channel`**
  in the state box (deregistered on cancellation). Activation captures the
  registered channels under the lock and delivers outside it (the no-callout
  rule) via non-suspending **`trySend`**: while a channel is open, unlimited
  capacity guarantees success without blocking, so synchronous `activate()`
  never blocks and a stalled collector loses nothing — bounded by memory
  exactly like Swift's `.unbounded` streams, never by a tunable buffer. The
  one way `trySend` can fail is a channel concurrently closed by `close()`,
  and that failure is deliberately ignored — the collector is gone.
  Every collector sees activations from subscription onward; there is no
  per-read observation framework on Android — reactive UIs collect `updates`
  (Compose: `collectAsState`-style bridging, research 0003 §3.5).
- **Lifetime** — `LeverClient.close()` is the explicit teardown (Kotlin has no
  deterministic `deinit`), and its contract is public behavior:
  - **Linearized against the commit gate**: `close()` first marks the client
    closed, so no new operation is admitted to the gate; then waits for
    already-admitted operations to finish their persist/log/deliver phase;
    then closes collector channels and releases runtime and transport
    resources. The observable rule: an activation admitted before the mark
    completes its durability and callouts before `close()` returns; one
    arriving after the mark returns `false` and changes nothing — no write, no
    log, no delivery. "Race-safe" means exactly this ordering, not best
    effort. Repeated or concurrent `close()` is a no-op after the first.
  - **Reads survive**: `get`/`value` keep serving the last activated snapshot
    (or defaults) forever — a closed client degrades to a static one, never a
    broken one.
  - **Control ops fail loud**: `fetch()`/`fetchAndActivate()` after close
    throw `IllegalStateException` (programmer error, like the §2.1 misuse
    rules); `activate()` returns `false` and changes nothing.
  - **Collectors complete, draining what they were owed**: every registered
    `updates` channel is closed, so a current collector receives any updates
    already enqueued for it and then completes; a collector arriving after
    close gets an immediately completed flow. Close never waits for arbitrary
    collectors to drain — that would let a stalled collector block `close()`
    indefinitely.
  - **Resources, not just jobs**: the runtime scope is cancelled (timer,
    in-flight fetch, watchdog, SSE), the dedicated dispatcher's thread is shut
    down, and the OkHttp client's executor and connection pool are released —
    cancellation alone leaks the thread and sockets. The close boundary is
    precisely: **no sink invocation begins and no new update is enqueued
    after `close()` returns**. Updates enqueued before the boundary may still
    drain to a live collector afterwards — that is delivery of accepted work,
    not a new callback.
  - **`Lever.shared` cannot be closed**: `close()` on the installed shared
    instance throws `IllegalStateException` naming the fix — the singleton is
    process-lived, and the API enforces it rather than asserting it. Explicit
    instances close freely.

  Per spec 0002 §5.1, cancelling one waiter of a coalesced fetch rethrows
  `CancellationException` to that waiter — never wrapped in `LeverException` —
  and never cancels the shared request while other interest remains.

## 5. Lifecycle and scheduling

Per spec 0002 §5 in full: the automatic fetch path, the two time seams
(wall-clock provider for persisted timestamps, monotonic source for timers),
the 60 s polling-floor rules, re-arm-from-attempt, explicit-fetch-always-hits-
network, nudge handling with the pending token, the failure floor, and the
`automaticUpdates = false` cache-only mode.

Android deltas:

- **Foreground/background** comes from `ProcessLifecycleOwner`
  (androidx.lifecycle-process) behind the same injected notification-source
  seam, which reports the **initial state at subscription** — a client
  constructed while the app is already foregrounded connects SSE immediately
  (spec 0002 §5.2). Per spec 0002 §12, **the first reported phase is the init
  trigger**: there is no separate construction-time fetch that could race the
  first lifecycle event into a duplicate request — one trigger, one request,
  for a client born backgrounded as much as foregrounded. The live source
  subscribes on the main thread (lifecycle APIs require it) and installs the
  observer and reads the current state atomically there.
- Wall clock is `System.currentTimeMillis()` behind the seam; the monotonic
  side is the runtime dispatcher's delay scheduling (virtualized wholesale by
  `kotlinx-coroutines-test` in tests — research 0003 §4.3).
- No background fetch scheduling (`WorkManager` etc.) in v1, same rationale as
  spec 0002 §5.2; deliberate non-goal, revisited only on evidence (§11).
- The synchronous cache read in the constructor happens on the calling thread
  by design; the documented placement is `Application.onCreate`
  (research 0003 §4.2 makes the StrictMode argument — one small file, low
  milliseconds, predictable beats lazy).

## 6. Transport

### 6.1 Resolve

Request construction, response mapping, atomicity, redirect refusal, and the
304 representation-ownership rules per spec 0002 §6.1, surfaced as
`LeverException` (§2). The client is one **internal, dedicated** `OkHttpClient`:
`followRedirects(false)` (+ SSL redirects off), no cache, no cookie jar, no
interceptors, connect/read/write timeouts 15 s, `retryOnConnectionFailure`
default. OkHttp types appear nowhere in the public surface; sharing a host
app's client is an open question (§11). `IOException`s map to
`Network(cause)`; Kotlin coroutine cancellation surfaces as
`CancellationException`, never `Network`.

### 6.2 SSE

The parser and state machine per spec 0002 §6.2 in full — the parser is a port
of the Swift one (same frame semantics, same 1 MiB bound, with §12.1's
accounting: every byte of the current frame counts, across all field kinds and
comments, and an overrun rejects **before** appending or decoding), connect
validation (200 + `text/event-stream` before any byte reaches the parser), idle
watchdog, full-jitter backoff with injected RNG, `Retry-After` handling, 401
stop-until-foreground, and spec 0002 §12's rule that a round which received a
frame resets the retry counter but **still takes its backoff delay** before
reconnecting. Android deltas: the stream call disables OkHttp's read timeout
(`readTimeout(0)`) — liveness belongs to the client-owned 60 s watchdog, not a
second timeout underneath it; the byte reader chunks on **size as well as
newlines**, so a peer that never sends a newline stays bounded below the parser
(spec 0002 §12.1); and the connection is torn down by cancelling the call from
the runtime.

## 7. Cache files

The two-file scheme, schemas, key-hash identity, rotation/namespace semantics,
context-exclusion rationale, write triggers, failure policy, and `clientId`
canonicalization (spec 0002 §12.1: unparseable regenerates, non-canonical
casing is rewritten in place — same installation, same bucketing key) per
spec 0002 §7. The format promise is **schema- and value-identical** — one
cache format, not one per SDK — proven by decoding, not by bytes: Android
decodes lever-swift's committed format fixtures unmodified, and an
emit-then-decode round-trip asserts the same schema and values. Byte equality
of serializer output is explicitly *not* promised — Swift and kotlinx
serialization own their member order and number spelling, and no cache file
ever crosses SDKs on a real device. Android deltas:

- **Location:** `{cacheDirectory ?? context.noBackupFilesDir}/lever/`.
  `noBackupFilesDir` keeps Auto Backup from cloning `clientId` (an
  *installation* identifier) onto new devices and from restoring stale
  snapshots (research 0003 §3.7). Setting `cacheDirectory` overrides — the
  caller then owns the backup story.
- **Identity is published with a hard link, not exclusive create**
  (spec 0002 §12): write the complete identity to a temporary file, then
  `android.system.Os.link` it into place, so "the file exists" means "the file
  is complete" — an `O_EXCL` create publishes the name before the bytes, and a
  racing process can read the empty file, judge it corrupt, and overwrite the
  winner's `clientId`. The loser's link fails, it discards its temp file and
  re-reads the winner. Exercised by an instrumented test on the real
  `noBackupFilesDir` filesystem, not only the host JVM's.
- Android has no App Group; the single-writer topology still applies to any
  app that points multiple clients (or multiple processes — §11) at one
  directory.

## 8. Logging

Per spec 0002 §8: everything flows through the configured sink; same message
style (lowercase, `key=value` tails). The default `LogcatSink` writes to
`android.util.Log` with tag `Lever`, mapping levels to `d`/`i`/`w`/`e`.
`LeverLogSink` is a `fun interface` so a host lambda is one line; it must stay
this small. The sink may be invoked from **any thread or coroutine context** —
implementations must be thread-safe. It is never invoked while the SDK holds
its state lock (spec 0002 §4.1's no-callout rule), so a sink may safely perform
**synchronous reads** (`get`/`value`) while handling a message. It *is* invoked
under the commit gate (§4), so calling control or lifecycle operations —
`activate()`, `fetchAndActivate()`, `close()` — from inside a sink callback is
a programmer error that can deadlock on the gate that is invoking the sink; the
KDoc and README say so.

## 9. What the flagship migration looks like (informative)

The Android counterpart of spec 0002 §9, pending the app audit
(research 0003 §2): `Lever.configure` in `Application.onCreate`, the Firebase
Remote Config wrapper's guts replaced by a `Flags` object (defaults declared
exactly once) and a coroutine bridging `updates` into whatever seam the app
publishes flags through today, with `cacheNamespace` set to a stable name so
key rotation lands on a warm floor. Realtime flips arrive via the nudge path.
No SDK feature beyond this spec is required; friction found here feeds 0.x, and
1.0 is tagged only after this ships.

## 10. Testing

The suites of spec 0002 §10.1–§10.3 are normative as behavior: the floor suite
(first-run offline, warm-cache offline, 401 non-wiping, corrupt cache, mismatch
floor, rotation, write failure), the semantics suite (staging, metadata-only
commits, 304 ownership, interval/hot-loop matrix, coalescing and cancellation,
cache-only mode, memoization across types, reentrant-sink no-deadlock,
validation matrix), and the SSE suite (parser, connect validation, state
machine, pending nudge, teardown). Android mechanics (research 0003 §4.3):

- **JVM-first**: everything above runs as plain JVM unit tests. Determinism
  comes from the same seams — injected transport double, notification source
  with initial state, RNG, wall clock — plus `kotlinx-coroutines-test`
  standing in for the manual monotonic clock (`runTest` virtual time drives
  the timer, watchdog, and backoff assertions).
- **Robolectric** only where a real `Context` or `ProcessLifecycleOwner` is
  unavoidable; one **instrumented smoke test** proves the AAR on a real stack.
- **Contract fixtures**: the replay harness feeds
  `packages/contract-fixtures/fixtures/http/` through the transport double —
  the same tapes the service verifies and lever-swift replays
  (spec 0002 §10.4). Fixture provenance splits as in plan 0002 M5: fixtures
  pin what the service can emit; SDK-local scripted tests cover what it
  cannot (non-HTTP events, redirect behavior, cancellation).

## 11. Open questions

- **Shared `OkHttpClient`/`Call.Factory` injection** — apps like sharing one
  connection pool; accepting one drags OkHttp into the public surface and its
  configuration (redirects, caches) into our invariants. Deferred until a
  consumer demands it.
- **Multi-process apps** — `ProcessLifecycleOwner` and the cache single-writer
  model are per-process; a client constructed in a second process is a second
  writer. v1 documents "configure in the main process; other processes are
  cache-only readers"; coordination beyond that waits for a real case.
- **Property-delegate sugar** and a **`lever-compose` artifact** — after the
  flagship migration proves the base API (research 0003 §3.4–§3.5).
- **Key codegen** (`lever pull --kotlin`) — with the 0001 §5 CLI.
- **WorkManager background refresh** — only if launch-time staleness shows up
  in practice; deliberately absent from v1.
- **Mutable context** (`updateAttributes` forcing a refetch) — same deferral
  as spec 0002 §11, one decision for all SDKs.
