# Spec 0002 — The Swift SDK

- **Status:** pre-implementation (settled 2026-08-13)
- **Research:** [0002 — lever-swift](../../research/0002-swift-sdk/research.md)
- **Scope:** the Swift client SDK — package layout, public API, concurrency model,
  lifecycle and scheduling, transport, cache format, observation, tests. The wire
  contract is fixed by [spec 0001](../0001-service/spec.md) §5–§7 and is cited, not
  redefined, here.

## 1. Package layout

The SDK lives in its own public repo, `lever-swift` (research 0002 §3.1). This spec
stays in the lever monorepo with the rest of the design history.

```
lever-swift/
  Package.swift
  Sources/Lever/
    Lever.swift               // Lever namespace: configure + shared
    LeverClient.swift         // the client: reads, fetch/activate, updates
    LeverConfiguration.swift  // configuration + context + platform
    LeverKey.swift            // LeverKey, LeverKeys, value decoding
    LeverError.swift
    Logging/                  // LeverLogSink, LeverLogLevel, OSLogSink
    Runtime/                  // internal actor: scheduling, lifecycle, SSE
    Transport/                // resolve client, SSE parser, endpoints
    Storage/                  // cache file codec + store
  Tests/LeverTests/
```

- `swift-tools-version: 6.0`, `swiftLanguageModes: [.v6]`. Platforms:
  `.iOS(.v18), .macOS(.v15), .watchOS(.v11), .tvOS(.v18), .visionOS(.v2)`.
- One product: `.library(name: "Lever", targets: ["Lever"])`. Module name `Lever`,
  `import Lever`. **Zero dependencies** — the package must compile warning-free under
  strict concurrency from both `MainActor`-default and nonisolated-default consumers
  (research 0002 §2); it builds with plain nonisolated default isolation itself.
- No UIKit/AppKit/WatchKit types in any public signature; platform frameworks are
  imported only behind `#if canImport(…)` for lifecycle notifications (§5.2).
- Releases are semver tags on `main`; 0.x until the flagship migration validates the
  API, then 1.0 freezes it.
- CI (GitHub Actions, macOS runner): `swift test` on macOS + `xcodebuild test` on an
  iOS simulator; build-only jobs for watchOS/tvOS/visionOS simulators. A pinned-SHA
  checkout of the lever monorepo provides `packages/contract-fixtures` for the replay
  suite (§10.4); bumping the pin is the contract-sync act.

## 2. Public API surface

The entire public surface, as the contract to freeze:

```swift
public enum Lever {
    public static func configure(_ configuration: LeverConfiguration)
    public static func configure(baseURL: URL, clientKey: String, context: LeverContext)
    public static var shared: LeverClient { get }
}

@dynamicMemberLookup
public final class LeverClient: Observable, Sendable {
    public init(configuration: LeverConfiguration)

    // Reads — synchronous, non-optional, stable between activations.
    public subscript<Value>(dynamicMember keyPath: KeyPath<LeverKeys, LeverKey<Value>>) -> Value { get }
    public func value<Value>(for key: LeverKey<Value>) -> Value

    // Control.
    public func fetch() async throws                                  // stages
    @discardableResult public func activate() -> Bool                 // true if the snapshot changed
    @discardableResult public func fetchAndActivate() async throws -> Bool

    // State.
    public var activatedVersion: Int? { get }        // nil until first activation ever
    public var updates: AsyncStream<LeverUpdate> { get }
}

public struct LeverConfiguration: Sendable {
    public var baseURL: URL
    public var clientKey: String                     // pk_… — an identifier, not a secret
    public var context: LeverContext
    public var minimumFetchInterval: Duration        // default .seconds(43_200)
    public var autoActivateOnNudge: Bool             // default true (research 0001 §4.4)
    public var cacheDirectory: URL?                  // nil → Application Support; set to an
                                                     // App Group container URL for extensions
    public var logSink: any LeverLogSink             // default OSLogSink()
    public init(baseURL: URL, clientKey: String, context: LeverContext)
}

public struct LeverContext: Sendable {
    public var platform: LeverPlatform               // default .current
    public var appVersion: String?
    public var attributes: [String: String]          // strings only (spec 0001 §11)
    public init(platform: LeverPlatform = .current,
                appVersion: String? = nil,
                attributes: [String: String] = [:])
}

public struct LeverPlatform: Sendable, Equatable, ExpressibleByStringLiteral {
    public static var current: LeverPlatform { get } // "ios" / "macos" / "watchos" / "tvos" / "visionos"
}

public struct LeverKeys: Sendable { public init() }  // empty; apps extend it (§2.2)

public struct LeverKey<Value: Sendable>: Sendable {
    public let name: String
    public let defaultValue: Value
}
public extension LeverKey where Value == Bool   { init(_ name: String, default: Bool) }
public extension LeverKey where Value == String { init(_ name: String, default: String) }
public extension LeverKey where Value == Int    { init(_ name: String, default: Int) }
public extension LeverKey where Value == Double { init(_ name: String, default: Double) }
public extension LeverKey where Value: Decodable & Sendable {
    init(json name: String, default: Value)          // a `json` parameter
}

public struct LeverUpdate: Sendable, Equatable {
    public let version: Int
    public let changedKeys: Set<String>
}

public enum LeverError: Error, Equatable {
    case invalidKey                                  // 401 — key unknown or rotated
    case server(status: Int)                         // any other non-2xx/304
    case network(URLError.Code)
    case invalidResponse                             // body failed to decode
}

public protocol LeverLogSink: Sendable {
    func log(_ level: LeverLogLevel, _ message: String)
}
public enum LeverLogLevel: Sendable { case debug, info, warn, error }
```

### 2.1 The shared instance

`Lever.configure` builds the default `LeverClient` and installs it; `Lever.shared`
returns it. Reading `shared` before `configure`, or calling `configure` twice, is a
programmer error → `preconditionFailure` with a message naming the fix. There is no
lazy placeholder client: a half-configured singleton silently serving defaults is the
failure mode Firebase users know and hate. Multiple explicit `LeverClient` instances
are always allowed (tests, staging-vs-prod); `shared` is sugar, not a registry.

### 2.2 Keys and reads

Apps declare keys once, as computed properties in an extension on `LeverKeys` —
the `EnvironmentValues` pattern:

```swift
extension LeverKeys {
    var enableEnrollment: LeverKey<Bool> { LeverKey("enable_enrollment", default: false) }
    var maxRetries: LeverKey<Int> { LeverKey("max_retries", default: 3) }
    var paywall: LeverKey<PaywallConfig> { LeverKey(json: "paywall", default: .standard) }
}

if lever.enableEnrollment { … }
```

- `@dynamicMemberLookup` forwards `lever.enableEnrollment` to
  `value(for: LeverKeys().enableEnrollment)`. Real members always win over dynamic
  members, so a key whose property name collides with API (`fetch`, `updates`, …)
  is read through `value(for:)` — which is also the non-magic API for anyone who
  dislikes the lookup.
- `LeverKey` carries an internal `@Sendable (RawValue) -> Value?` decoder installed
  by the typed initializers; the generic parameter is otherwise unconstrained. The
  `json` initializer gets a distinct label so `Bool`/`String` (which are also
  `Decodable`) never race it in overload resolution — this is the compile-checked
  version of the research sketch, whose leading-dot subscript does not reliably
  infer through a generic parameter.

### 2.3 Read semantics

`value(for:)` reads the activated snapshot (§4) under its lock and resolves in order:

1. **Key absent** from the snapshot (not published, or first run with no cache) →
   `defaultValue`. Logged at `debug` only — absence is the normal state mid-rollout.
2. **Type mismatch** → `defaultValue` + one `warn` per `(key, version)` pair
   (deduped so a hot read site cannot flood the log). Mismatch means: wire type ≠
   the key's expected type; a `number` with a fractional part or outside `Int`
   range read by a `LeverKey<Int>`; or a `json` payload that fails `JSONDecoder`
   into `Value`. Never throws, never returns optional (research 0002 §3.4; 0001 §4.2).
3. Otherwise → the decoded value.

Type mapping: `Bool ↔ boolean`, `String ↔ string`, `Int`/`Double ↔ number` (an `Int`
key requires an exactly-representable integer), `Decodable ↔ json` (decoded from the
raw JSON value re-serialized as `Data`; decode once per `(key, version)` and memoize
in the snapshot, so JSON reads in `body` stay cheap).

## 3. Configuration validation

At `LeverClient.init` (all violations log through the sink; none throw):

- **`appVersion`**: strict semver passes silently. A purely numeric 1- or
  2-component version (`"5"`, `"5.2"`) is zero-padded to `"5.2.0"` with an `info`
  log — marketing versions are the common case and the intent is unambiguous.
  Anything else is sent verbatim with an `error` log stating that no version clause
  will ever match it (spec 0001 §4).
- **`attributes`**: entries violating the wire limits (> 20 entries, name outside
  1–64 chars, value > 256 chars — spec 0001 §6.2) are dropped with a `warn` naming
  each dropped key. Sending them would 400 the entire resolve and cost all keys
  their freshness, so client-side dropping is the floor-preserving choice.
- **`clientKey`**: shape-checked (`pk_` prefix) with a `warn` on mismatch; sent
  regardless. The server is the authority on validity.

## 4. Snapshots and state

Internal state, held in one `Mutex`-protected box inside `LeverClient`:

- **`activated`** — the snapshot serving reads: `{version, values, memoizedJSON}`.
  Loaded synchronously from the cache file during `init` (§7), so the first read
  after `configure` already serves last-activated values; absent a cache it is
  empty and reads serve defaults. This ordering — cache before any await — is the
  three-layer floor made structural.
- **`staged`** — the last fetched-but-not-activated payload, or nil. Lost on
  process death by design: the cache persists activated values only, because the
  floor is defined as *last-activated* (research 0001 §4.4).
- **`lastKnownVersion`** — the version from the most recent successful fetch
  response (200 or 304), staged or activated. This — never a nudge frame — is what
  nudge dedupe compares against, implementing spec 0001 §7's identity-not-ordering
  rule: fetch when the announced version *differs*, learn versions only from fetch.
- **`etag`**, **`lastFetchAt`** — revalidation and the min-interval clock.

`activate()` swaps `staged` into `activated` if present and different (raw-value
equality per key over the canonical payload), persists the cache file, computes
`changedKeys` from the raw diff, emits a `LeverUpdate`, and fires observation. It
returns `false` (and emits nothing) when there is nothing staged or the staged
payload is identical.

### 4.1 Concurrency shape

- `LeverClient` is a `Sendable final class`: the `Mutex` box above, an
  `ObservationRegistrar`, immutable configuration, and a reference to the runtime
  actor. Reads are synchronous lock-protected lookups — no `await`, no actor hop;
  `await`ing a flag in `body` is the one banned shape (research 0002 §4.4).
- All machinery — scheduling, lifecycle reaction, the SSE connection, fetch
  execution — lives in one internal actor (`Runtime/`). Public `fetch`/`activate`
  forward to it; it owns every `Task` and timer so cancellation has one home.
- Observation is implemented manually against the registrar: every read registers
  access on a single internal `snapshot` member; the activation swap wraps in
  `withMutation` on the same member. Granularity is deliberately coarse — any
  activation invalidates every observing view — which at the audited scale
  (~11 keys, config changes are rare events) costs one extra body evaluation per
  flip and buys a trivially correct implementation. Per-key granularity is an
  internal refinement that needs no API change (§11).
- `updates` returns a **fresh stream per access** (`AsyncStream.makeStream`,
  continuations registered in the state box, `onTermination` deregisters), so any
  number of consumers can listen independently; a stream obtained before an
  activation receives it, and buffering policy is `.unbounded` (updates are rare
  and tiny).

## 5. Lifecycle and scheduling

The SDK owns its lifecycle (research 0002 §4.2); everything below is the runtime
actor's job.

### 5.1 Fetch policy

- **On `init`**: after the synchronous cache load, one background task runs the
  *automatic* fetch path: fetch-and-activate now if there is no cache or
  `lastFetchAt + minimumFetchInterval` has passed; otherwise nothing.
- **Automatic paths** (init, foreground, in-session timer) honor
  `minimumFetchInterval`. While foregrounded, a timer armed for
  `lastFetchAt + interval` keeps a long-lived session honest — this timer *is* the
  degraded polling mode when the stream is down; there is no second, faster poll
  loop (research 0001 §3.2's "min-interval polling" means exactly this clock).
- **Explicit `fetch()` / `fetchAndActivate()` always hit the network.** The
  interval throttles the SDK, not the developer: an explicit call is a debug menu,
  a retry button, or a deliberate policy override, and silently no-op'ing it is
  Firebase's most confusing behavior. The DEBUG story is therefore configuration,
  not a bypass flag: set `minimumFetchInterval = .zero` under `#if DEBUG`.
- **Nudge fetches** bypass the interval by design and reset the clock on success.
- Concurrent fetch requests coalesce: a fetch already in flight is awaited, not
  duplicated.

### 5.2 Foreground / background

Observed via notifications behind `#if canImport(…)` — `UIApplication` (iOS, tvOS,
visionOS), `WKApplication` (watchOS), `NSApplication` (macOS) — from the runtime
actor, keeping public API and the core platform-free:

- **Foreground**: connect the stream (§6); run the automatic fetch path.
- **Background**: tear down the stream and the in-session timer. No background
  fetch scheduling (`BGAppRefreshTask` etc.) in v1 — the launch/foreground path
  already bounds staleness at one interval, matching what Firebase provided.

### 5.3 Nudge handling

On an SSE `version` event announcing `N`:

- `N == lastKnownVersion` → ignore (dedupe; the connect-frame replay and reconnect
  races land here).
- Otherwise → fetch immediately. With `autoActivateOnNudge` (default) the result is
  activated; opted out, it is staged and the app activates on its own schedule.
  Either way `lastKnownVersion` advances only via the fetch response.

### 5.4 Failure floor

Any failure on any automatic path — network, 5xx, 401, decode — logs and changes
nothing: the current snapshot keeps serving. A 401 specifically (rotation has no
grace window, spec 0001 §11) **never clears the cache or stops reads**; it stops the
stream and lets the next foreground retry, on the assumption the app will ship a new
key. Explicit calls surface the same failures as thrown `LeverError`s.

## 6. Transport

### 6.1 Resolve

`GET {baseURL}/v1/resolve` with `Authorization: Bearer {clientKey}`, context as
query items (`platform`, `appVersion`, `clientId`, `attr.{name}` — spec 0001 §6.2),
and `If-None-Match: {etag}` when one is cached.

- **200** → decode `{version, values}` (any shape violation → `invalidResponse`),
  store the response `ETag`, stage, update `lastKnownVersion` + `lastFetchAt`.
- **304** → refresh `lastFetchAt` only; the cached snapshot is current.
- **401** → `LeverError.invalidKey`; **other non-2xx** → `.server(status:)`;
  transport failures → `.network(code)`.
- One dedicated `URLSession` with an **ephemeral** configuration: no URLCache (the
  SDK's ETag + disk cache *is* the cache; a second HTTP cache underneath produces
  confusing double-freshness), no cookies, `waitsForConnectivity = false` (fail
  fast; the floor handles it), request timeout 15 s.

### 6.2 SSE

`GET {baseURL}/v1/stream`, same auth, `Accept: text/event-stream`, read via
`URLSession.bytes`. No third-party client exists in Foundation; the SDK owns a
minimal parser for what the server actually emits (spec 0001 §7): `event:`/`data:`
frames, `:` comment heartbeats, `retry:` (parsed and **discarded** — backoff is
client-owned), tolerant of LF/CRLF and frames split across chunks.

State machine, owned by the runtime actor, active only while foregrounded:

```
disconnected ──connect──▶ connecting ──200──▶ open ──frame──▶ (nudge §5.3)
     ▲                        │                 │
     │                     failure         silence > 60 s / error / EOF
     └──── backoff(n) ◀───────┴─────────────────┘
```

- **Idle watchdog**: any bytes (heartbeats included) reset a 60 s timer; expiry
  kills the connection. Server heartbeats every 25 s, so 60 s means two lost
  beats — decisive without flapping (research 0002 §3.6).
- **Backoff**: full jitter over an exponential ceiling — delay
  `random(0, min(60, 2ⁿ))` seconds from attempt n. A successful open that then
  receives any frame resets n. **503** (capacity shed, spec 0001 §7) honors
  `Retry-After` as the floor delay for that round. **401** stops reconnecting
  until the next foreground.
- **On reconnect**, the server replays the current version as the first frame;
  §5.3's dedupe makes missed-while-disconnected publishes exactly one fetch and
  quiet reconnects free.

## 7. Cache file

One JSON file per client at
`{cacheDirectory ?? Application Support}/Lever/{key-hash}.json`, where `key-hash` is
the first 16 hex chars of SHA-256 over `baseURL + "\n" + clientKey` — distinct
instances get distinct files; the same environment gets a stable one.

```json
{
  "schemaVersion": 1,
  "clientId": "6f9a…",
  "version": 42,
  "etag": "\"a1b2c3d4e5f60718\"",
  "values": { "enable_enrollment": { "type": "boolean", "value": true } },
  "fetchedAt": 1755100000,
  "activatedAt": 1755100000
}
```

- `values` is the **raw wire payload** of the last-activated snapshot, untouched —
  the cache replays a resolve response, it does not re-encode typed values, so read
  semantics (§2.3) are identical from cache and network by construction.
- Written atomically (`.atomic`) on every activation that changed the snapshot and
  on first-run `clientId` generation. Unreadable/corrupt/wrong-`schemaVersion` →
  `warn`, treat as first run, overwrite on next activation. The file is a cache: a
  schema bump discards, never migrates.
- **`clientId`**: lowercase UUID generated on first run, persisted here, sent on
  every resolve. Inert in v1; it is the future rollout bucketing key
  (research 0001 §4.4).
- Plain file, no protection class beyond the default: values are public by design
  (research 0001 §6). Pointing `cacheDirectory` at an App Group container shares
  the floor with widget/watch extensions; concurrent writers are last-writer-wins
  and torn reads are impossible (atomic replace) — file coordination is out of
  scope for v1 (§11).

## 8. Logging

All SDK logging flows through the configured `LeverLogSink`. The default `OSLogSink`
wraps one `os.Logger(subsystem: Bundle.main.bundleIdentifier ?? "lever",
category: "lever")`. Message style follows the house convention: lowercase,
`key=value` tails, no trailing punctuation — `warn("fetch failed status=503")`,
`info("activated version=42 changed=2")`. The sink protocol exists so host apps can
route SDK logs into their own pipeline (research 0002 §3.7); it must stay this small.

## 9. What the flagship migration looks like (informative)

The acceptance test (research 0001 §8) in outline: the app-target Remote Config
file becomes `Lever.configure(…)` plus a `Task` bridging `updates` into the existing
UserDefaults republish; the package-side flags file becomes the `LeverKeys`
extension, with each key's default finally declared exactly once. Realtime flips
arrive via the nudge path; widget/watch parity comes from an App Group
`cacheDirectory`. No SDK feature beyond this spec is required.

## 10. Testing

`swift-testing` throughout (`@Test`, `#expect`); no XCTest. Determinism comes from
seams, not sleeps: the runtime actor takes any `Clock` (default `ContinuousClock`;
tests inject a manual clock), an injectable jitter RNG, and a transport protocol
(`LeverTransport`) whose test double serves scripted responses and records requests.

### 10.1 The floor suite (the headline — research 0001 §7)

- First run, transport failing → every read returns its code default; no throw.
- Cache present, transport failing → reads serve cached values from the first
  statement after `init`, before any async work.
- 401 on fetch and on stream → cached values keep serving; the cache file is not
  deleted; stream stops retrying until foreground.
- Corrupt / wrong-schema cache file → defaults, `warn`, next activation rewrites.
- Type mismatch, fractional-to-`Int`, out-of-range `number`, failing `json`
  decode → default + deduped warn, across every typed initializer.

### 10.2 Semantics

- Staging: fetch does not change reads; `activate()` swaps atomically; identical
  staged payload → `activate() == false`, no `LeverUpdate`, no observation fire.
- `LeverUpdate.changedKeys` matches the raw diff exactly (added, removed, changed).
- ETag: second fetch sends `If-None-Match`; 304 refreshes the clock, values and
  version untouched.
- Interval: `init` within the interval issues no request (transport double
  asserts); explicit `fetch()` always issues one; a nudge issues one regardless of
  the interval and resets the clock.
- Nudge dedupe: announced `N == lastKnownVersion` → no fetch; differing `N`
  (higher **or lower** — the backup-restore case) → fetch; `lastKnownVersion`
  advances only from fetch responses. `autoActivateOnNudge = false` stages only.
- Version normalization: `"5.2"` → `"5.2.0"` on the wire; garbage logs an error
  and is sent verbatim; attribute-limit violations are dropped per §3.

### 10.3 SSE

- Parser: frames split across arbitrary chunk boundaries, comment heartbeats,
  CRLF/LF, `retry:` ignored, unknown fields skipped.
- State machine (manual clock): 60 s silence → reconnect; backoff delays within
  the jitter envelope and reset after a successful frame; 503 honors
  `Retry-After`; background tears down, foreground reconnects; the replayed
  connect frame after a missed publish yields exactly one fetch.

### 10.4 Contract fixtures

The HTTP cases `packages/contract-fixtures` promises but does not yet contain are
authored **in the lever monorepo** as part of this work, under `fixtures/http/`,
data-only like the evaluation set:

```json
{
  "name": "resolve-repeat-304",
  "steps": [
    { "request": { "context": {} },
      "response": { "status": 200, "etag": "\"abc\"", "body": { "version": 3, "values": { "…": "…" } } },
      "expect": { "activatedVersion": 3 } },
    { "request": { "context": {}, "ifNoneMatch": "\"abc\"" },
      "response": { "status": 304 },
      "expect": { "activatedVersion": 3 } }
  ]
}
```

Minimum set: fresh 200 → activate; repeat 304; never-published `{version: 0}`;
401 with warm cache; type-mismatch payload; empty-context defaults. The service's
integration tests generate/verify these against the real server; every SDK replays
them through its transport double — same tapes, three languages
(research 0001 §7).

## 11. Open questions

- **Mutable context.** v1 fixes `LeverContext` at `init`; login-scoped attributes
  (`updateAttributes(_:)` forcing a refetch) are a real future need but interact
  with the interval clock and ETag — deferred until a consumer demands it.
- **Per-key observation granularity**, if coarse invalidation ever shows up in a
  profile. Internal change only.
- **Cross-process cache coordination** (`NSFileCoordinator`) if extensions ever
  fetch rather than just read.
- **`@LeverValue` property wrapper** and **key codegen** (`lever pull --swift`) —
  research 0002 §5, after the flagship migration proves the base API.
- **Background refresh** (`BGAppRefreshTask`) if launch-time staleness ever
  matters in practice; deliberately absent from v1.
