# Spec 0003 — The Android SDK

- **Status:** pre-implementation (settled 2026-08-14)
- **Research:** [0003 — lever-android](../../research/0003-android-sdk/research.md)
- **Scope:** the Android client SDK — package layout, public API, concurrency
  mapping, platform integration, transport and storage deltas, tests. The wire
  contract is fixed by [spec 0001](../0001-service/spec.md) §5–§7. The **client
  behavioral contract** — read resolution, validation policy, snapshot/state
  semantics, scheduling, SSE, cache format — is fixed by
  [spec 0002](../0002-swift-sdk/spec.md) (as amended by its two review passes)
  and is **cited, not restated**, here. Where this spec says "per spec 0002 §N",
  that section is normative for this SDK with Swift types read as their Kotlin
  counterparts; only deltas are spelled out. This is the drift defense named in
  research 0003 §7: one prose contract, cited twice, tethered by shared fixtures.

## 1. Package layout

The SDK lives in its own public repo, `lever-android` (research 0003 §3.1),
published to **Maven Central** as `dev.forcetower:lever-android`. This spec stays
in the lever monorepo with the rest of the design history.

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
  `minSdk 26` / `compileSdk` current (research 0003 §3.2). `explicitApi()` mode
  and the kotlinx binary-compatibility validator from the first tag — the
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

    public fun close()                               // teardown: cancels all work (§4)
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

public class LeverUpdate(
    public val version: Int,                         // the version whose activation changed the
                                                     // serving values (metadata-only commits are
                                                     // silent — spec 0002 §4)
    public val changedKeys: Set<String>,
)

public sealed class LeverException : Exception() {
    public object InvalidKey : LeverException()      // 401 — key unknown or rotated
    public class Server(public val status: Int) : LeverException()
                                                     // any HTTP status other than 200/304/401
    public class Network(override val cause: IOException) : LeverException()
    public object InvalidResponse : LeverException() // malformed response: undecodable body,
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
no lazy placeholder client). `configure` retains only the
`applicationContext` — never an Activity. Multiple explicit `LeverClient`
instances are always allowed; `shared` is sugar, not a registry.

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
  serializer can't be reified — generics, custom modules).
- `int` (32-bit) and `long` both map wire `number`; a value outside the key's
  range is a type mismatch per spec 0002 §2.3 (default + deduped warn), same as
  a fractional part.
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
and the sub-60 s notice — with two Kotlin notes:

- All limits count UTF-16 code units; Kotlin `String.length` *is* UTF-16 code
  units, so the server's JavaScript semantics need no translation
  (research 0003 §4.3).
- `baseUrl` arrives as `String`; a string that does not parse as an `http(s)`
  URL at all is an `IllegalArgumentException` from the `LeverConfiguration`
  constructor — the analogue of Swift's compile-time `URL` type, and the one
  validation that throws. Everything parseable follows §3's
  canonicalize-and-log rules.

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
- **`updates`** — backed by a `MutableSharedFlow(replay = 0)` with a buffer
  large enough that emission from synchronous `activate()` never blocks or
  drops (updates are rare and tiny — the analogue of spec 0002 §4.1's
  unbounded streams). Every collector sees activations from subscription
  onward; there is no per-read observation framework on Android — reactive UIs
  collect `updates` (Compose: `collectAsState`-style bridging, research 0003
  §3.5).
- **Lifetime** — `LeverClient.close()` is the explicit teardown (Kotlin has no
  deterministic `deinit`): it cancels the runtime scope — timer, in-flight
  fetch, watchdog, SSE — and releases the transport. Runtime jobs must not
  retain the client beyond `close()`; no sink or `Flow` emission fires after
  it. The `Lever.shared` singleton is process-lived and never closed. Per
  spec 0002 §5.1, cancelling one waiter of a coalesced fetch rethrows
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
  (spec 0002 §5.2). The live source hops to the main thread to subscribe, as
  lifecycle APIs require.
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
of the Swift one (same frame semantics, same 1 MiB bound), connect validation
(200 + `text/event-stream` before any byte reaches the parser), idle watchdog,
full-jitter backoff with injected RNG, `Retry-After` handling, 401
stop-until-foreground. Android delta: the stream call disables OkHttp's read
timeout (`readTimeout(0)`) — liveness belongs to the client-owned 60 s
watchdog, not a second timeout underneath it — and the connection is torn down
by cancelling the call from the runtime.

## 7. Cache files

The two-file scheme, schemas, key-hash identity, rotation/namespace semantics,
context-exclusion rationale, write triggers, and failure policy per
spec 0002 §7, **byte-format identical** — there is one cache format, not one
per SDK. Android deltas:

- **Location:** `{cacheDirectory ?? context.noBackupFilesDir}/lever/`.
  `noBackupFilesDir` keeps Auto Backup from cloning `clientId` (an
  *installation* identifier) onto new devices and from restoring stale
  snapshots (research 0003 §3.7). Setting `cacheDirectory` overrides — the
  caller then owns the backup story.
- Exclusive first creation of `identity.json` uses
  `File.createNewFile()`-style `O_EXCL` semantics with the loser re-reading
  the winner, per spec 0002 §7.
- Android has no App Group; the single-writer topology still applies to any
  app that points multiple clients (or multiple processes — §11) at one
  directory.

## 8. Logging

Per spec 0002 §8: everything flows through the configured sink; same message
style (lowercase, `key=value` tails). The default `LogcatSink` writes to
`android.util.Log` with tag `Lever`, mapping levels to `d`/`i`/`w`/`e`.
`LeverLogSink` is a `fun interface` so a host lambda is one line; it must stay
this small.

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
