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
  iOS simulator; build-only jobs for watchOS/tvOS/visionOS simulators. Two tiny
  consumer fixtures — one compiled with `MainActor` default isolation, one
  nonisolated — each declaring a `LeverKeys` extension and a dynamic-member read,
  because building the package itself proves nothing about the consumption promise.
  A pinned-SHA checkout of the lever monorepo provides `packages/contract-fixtures`
  for the replay suite (§10.4); bumping the pin is the contract-sync act.

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
    @discardableResult public func activate() -> Bool                 // true if the serving values changed
    @discardableResult public func fetchAndActivate() async throws -> Bool

    // State.
    public var activatedVersion: Int? { get }        // nil until first activation ever; 0 after
                                                     // activating a never-published environment
    public var updates: AsyncStream<LeverUpdate> { get }
}

public struct LeverConfiguration: Sendable {
    public var baseURL: URL
    public var clientKey: String                     // pk_… — an identifier, not a secret
    public var context: LeverContext
    public var minimumFetchInterval: Duration        // default .seconds(43_200)
    public var automaticUpdates: Bool                // default true; false → cache-only reader:
                                                     // no automatic fetch, timer, lifecycle
                                                     // observer, or SSE (§5) — explicit fetch()
                                                     // remains a deliberate override
    public var autoActivateOnNudge: Bool             // default true (research 0001 §4.4)
    public var cacheDirectory: URL?                  // nil → Application Support; set to an
                                                     // App Group container URL for extensions
    public var cacheNamespace: String?               // stable cache identity; nil → derived from
                                                     // clientKey (see §7 — set it to survive
                                                     // key rotation with a warm cache)
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
    public var rawValue: String { get }
    public init(_ rawValue: String)                  // string-literal conformance routes here
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
    public let version: Int                          // the version whose activation changed the
                                                     // serving values (metadata-only commits are
                                                     // silent — §4)
    public let changedKeys: Set<String>
}

public enum LeverError: Error, Equatable {
    case invalidKey                                  // 401 — key unknown or rotated
    case server(status: Int)                         // any HTTP status other than 200/304/401
                                                     // (unexpected 2xx like 204 included)
    case network(URLError.Code)
    case invalidResponse                             // malformed response: undecodable body,
                                                     // non-HTTP response, or unsolicited 304
}

public protocol LeverLogSink: Sendable {
    func log(_ level: LeverLogLevel, _ message: String)
}
public enum LeverLogLevel: Sendable { case debug, info, warn, error }

public struct OSLogSink: LeverLogSink, Sendable {    // the default sink (§8)
    public init()
    public func log(_ level: LeverLogLevel, _ message: String)
}
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
- "Stable between activations" is a guarantee about the SDK's storage, not about
  aliasing: `json` model types should be structs (value semantics). A mutable
  reference type is merely `Sendable`-checked; the SDK cannot stop a caller from
  mutating a shared decoded instance, so document-level guidance is: value types.

### 2.3 Read semantics

`value(for:)` reads the activated snapshot (§4) under its lock and resolves in order:

1. **Key absent** from the snapshot (not published, or first run with no cache) →
   `defaultValue`. Logged at `debug` only, deduped per `(key, version)` like the
   mismatch warn — absence is the normal state mid-rollout, and a hot SwiftUI read
   must not flood even the debug channel.
2. **Type mismatch** → `defaultValue` + one `warn` per `(key, version, Swift type)`
   triple (deduped so a hot read site cannot flood the log; the Swift type is part
   of the identity because two `LeverKey`s may share a wire name with different
   `Value` types). Mismatch means: wire type ≠ the key's expected type; a `number`
   with a fractional part or outside `Int` range read by a `LeverKey<Int>`; or a
   `json` payload that fails `JSONDecoder` into `Value`. Never throws, never
   returns optional (research 0002 §3.4; 0001 §4.2).
3. Otherwise → the decoded value.

Type mapping: `Bool ↔ boolean`, `String ↔ string`, `Int`/`Double ↔ number` (an `Int`
key requires an exactly-representable integer), `Decodable ↔ json` (decoded from the
raw JSON value re-serialized as `Data`; decode once per `(key, version, Swift type)`
and memoize in the snapshot, so JSON reads in `body` stay cheap — the requested type
is part of the memo identity because a typed decoded value must never be served to a
key expecting a different `Value`).

## 3. Configuration validation

At `LeverClient.init` (all violations log through the sink; none throw). The policy
is uniform: anything the server would reject with a 400 is repaired or **omitted**
client-side, because a 400 costs every key its freshness — the floor-preserving
choice (spec 0001 §6.2). All length checks below count **UTF-16 code units**, the
server's JavaScript string-length semantics; Swift's grapheme-cluster `count` would
pass strings the server rejects.

- **`baseURL`**: canonicalized before use — scheme and host lowercased, default
  port dropped, trailing slashes stripped. The canonical form is what requests are
  built from and what the cache identity hashes (§7). Scheme must be `http` or
  `https` (`error` log otherwise); a query or fragment is stripped with a `warn` —
  the SDK owns the path and query space under the base.
- **`appVersion`**: strict semver passes silently. A purely numeric 1- or
  2-component version (`"5"`, `"5.2"`) is zero-padded to `"5.2.0"` with an `info`
  log — marketing versions are the common case and the intent is unambiguous.
  Anything else within the 64-unit wire limit is sent verbatim with an `error` log
  stating that no version clause will ever match it (spec 0001 §4). Over 64 units
  it is **omitted** with an `error` log — verbatim would 400 the resolve.
- **`platform`**: over 64 units → omitted with a `warn`. An absent platform means
  platform clauses never match (spec 0001 §4) — degraded targeting, not a 400.
- **`attributes`**: entries individually violating the wire limits (name outside
  1–64 units, value > 256 units) are dropped with a `warn` naming each dropped
  key. If more than 20 valid entries remain, the survivors are the first 20 in
  ascending Unicode-scalar order of name and the rest are dropped with a `warn`
  naming them — a deterministic rule; Swift dictionary iteration order must never
  decide which targeting inputs survive.
- **`clientKey`**: shape-checked (`pk_` prefix) with a `warn` on mismatch; sent
  regardless. The server is the authority on validity.
- **`minimumFetchInterval`**: a negative duration is clamped to `.zero` with a
  `warn` — a negative interval would make every deadline permanently overdue
  (§5.1's hot-loop guard depends on this). A positive duration under 60 s logs an
  `info` that the in-session timer runs at the 60 s polling floor while lifecycle
  edges keep the configured value (§5.1).

## 4. Snapshots and state

Internal state, held in one `Mutex`-protected box inside `LeverClient`:

Network and freshness metadata belong to a **representation**, never to the client
globally — activated and staged can differ, and a 304 confirms whichever
representation's validator was sent, so a global `etag`/`lastFetchAt` pair would
let staged metadata corrupt activated state:

- **`activated`** — the representation serving reads:
  `{version, values, etag, fetchedAt, activatedAt, memoizedJSON}`. Loaded
  synchronously from the cache file during `init` (§7), so the first read after
  `configure` already serves last-activated values; absent a cache it is empty
  and reads serve defaults. This ordering — cache before any await — is the
  three-layer floor made structural.
- **`staged`** — the last fetched-but-not-activated representation,
  `{version, values, etag, fetchedAt}`, or nil. Lost on process death by design:
  the cache persists the activated representation only, because the floor is
  defined as *last-activated* (research 0001 §4.4).
- **`lastKnownVersion`** — derived, not stored: the version of the newest
  validated representation held by the process (`staged ?? activated`). A 200
  can replace it; a 304 carries no version — it only re-confirms the
  representation whose validator was sent. This — never a nudge frame — is what
  nudge dedupe compares against, implementing spec 0001 §7's
  identity-not-ordering rule: fetch when the announced version *differs*, learn
  versions only from fetch.
- The request validator (`If-None-Match`) and the min-interval clock likewise
  read the newest representation: staged when present, otherwise activated.

`activate()` separates **representation commit** from **observable value change**,
because the service changes version and ETag on every publish even when the values
resolved for this client are identical (spec 0001 §6.4):

- With nothing staged, it returns `false` and does nothing.
- Otherwise it always **consumes** the staged payload and commits its version and
  timestamps, then persists the cache file (§7) — a metadata-only commit still
  persists, so `activatedVersion` and the cached snapshot track the server even
  across value-identical publishes. Activating `{version: 0, values: {}}` commits
  like any other: `activatedVersion` becomes `0`, never sticks at `nil`.
- It returns `true`, computes `changedKeys` from the raw diff, emits a
  `LeverUpdate`, and fires observation **only when the serving values changed**
  (raw-value equality per key over the canonical payload). A metadata-only commit
  is silent: no update, no observation, `false`.

### 4.1 Concurrency shape

- `LeverClient` is a `Sendable final class`: the `Mutex` box above, an
  `ObservationRegistrar`, immutable configuration, and a reference to the runtime
  actor. Reads are synchronous lock-protected lookups — no `await`, no actor hop;
  `await`ing a flag in `body` is the one banned shape (research 0002 §4.4).
- **Ownership boundary.** The client core (the `Mutex` box) owns snapshot state
  and everything synchronous: reads, staging, `activate()`. The runtime actor
  owns everything asynchronous: scheduling, lifecycle reaction, the SSE
  connection, fetch execution, every `Task` and timer — so cancellation has one
  home. The actor calls into the thread-safe core to stage or activate results;
  the core never calls into the actor. Public `fetch()` forwards to the actor;
  `activate()` runs synchronously in the core — it must, since a synchronous
  method cannot await an actor.
- **No callouts under the lock.** `Mutex` is non-recursive; nothing external ever
  runs while holding it — no `LeverLogSink.log`, no observation-registrar
  callbacks, no continuation yields, no filesystem I/O, no `JSONDecoder` (whose
  `Decodable` code is arbitrary). Activation computes and swaps minimal state
  under the lock, then persists, logs, fires observation, and yields updates
  outside it. A host sink that reads a flag while handling a warning must not
  deadlock.
- **Lifetime.** The client retains its runtime; the runtime's tasks must not
  retain the client (weak/unowned back-references). Client `deinit` triggers
  teardown: cancel the timer, in-flight fetch, watchdog, and SSE tasks, and
  invalidate the dedicated `URLSession` — a session retains its delegate until
  invalidated, so skipping this leaks. No sink, observation, or continuation
  callback may fire after teardown.
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
actor's job. **All of it is gated on `automaticUpdates`**: with it `false` the
client is a cache-only reader — the synchronous cache load and typed reads work
as ever, but no automatic fetch, in-session timer, lifecycle observation, or SSE
connection ever starts. Explicit `fetch()`/`fetchAndActivate()` remain available
as a deliberate override (consistent with §5.1's "the interval throttles the SDK,
not the developer"); a reader process that never calls them never writes. This is
the mode App Group extension readers use (§7).

### 5.1 Fetch policy

Two time seams, injected separately, because they answer different questions: a
**wall-clock date provider** for persisted Unix timestamps (`lastFetchAt` must
survive relaunch; `ContinuousClock.Instant` cannot be serialized) and a
**monotonic clock** for in-session timers, backoff, and the watchdog (immune to
wall-clock jumps).

- **On `init`**: after the synchronous cache load, one background task runs the
  *automatic* fetch path: fetch-and-activate now if there is no cache or
  `lastFetchAt + minimumFetchInterval` has passed (`lastFetchAt` throughout this
  section is shorthand for the newest representation's `fetchedAt` — §4);
  otherwise nothing. A
  `lastFetchAt` in the future (the wall clock moved backwards) counts as passed —
  one fetch rewrites it to now, so this cannot loop.
- **Automatic paths** (init, foreground, in-session timer) honor
  `minimumFetchInterval`. While foregrounded, a timer armed for
  `lastFetchAt + interval` keeps a long-lived session honest — this timer *is* the
  degraded polling mode when the stream is down; there is no second, faster poll
  loop (research 0001 §3.2's "min-interval polling" means exactly this clock).
  Two rules keep it from running hot:
  - The timer never fires more often than the **60 s polling floor**: an interval
    of `≥ 60 s` arms at the configured value; `0 < interval < 60 s` arms at 60 s
    (clamped for the timer only — lifecycle-edge eligibility keeps the configured
    interval; §3 logs the clamp); `.zero` arms no timer at all — automatic
    fetching happens on lifecycle edges only (init, foreground, nudge), so
    `.zero` means "always eligible", never "continuously".
  - The timer always re-arms **from the attempt**, never from an already-expired
    deadline: success arms at `lastFetchAt + interval` as usual; a failed
    automatic fetch (which does not advance `lastFetchAt`) arms at
    `attemptAt + interval`. First-run offline has no `lastFetchAt`; the failed
    init attempt anchors the same way. Automatic paths do not add retry backoff —
    the next lifecycle edge or timer tick is the retry.
- **Explicit `fetch()` / `fetchAndActivate()` always hit the network.** The
  interval throttles the SDK, not the developer: an explicit call is a debug menu,
  a retry button, or a deliberate policy override, and silently no-op'ing it is
  Firebase's most confusing behavior. The DEBUG story is therefore configuration,
  not a bypass flag: set `minimumFetchInterval = .zero` under `#if DEBUG`.
- **Nudge fetches** bypass the interval by design and reset the clock on success.
- Concurrent fetch requests coalesce: a fetch already in flight is awaited, not
  duplicated. What coalesces is **transport work** — each caller independently
  applies its own policy (activate or not) to the shared result. Cancellation of
  one waiter never cancels the shared request while other interest remains; it
  rethrows `CancellationError` to that caller — never mapped to
  `LeverError.network(.cancelled)`. Client teardown (§4.1) does cancel the
  underlying transport. Automatic callers log failures, but never log
  cancellation as a network error.

### 5.2 Foreground / background

Observed via an injected notification source whose live implementation binds the
platform notifications behind `#if canImport(…)` — `UIApplication` (iOS, tvOS,
visionOS), `WKApplication` (watchOS), `NSApplication` (macOS) — from the runtime
actor, keeping public API and the core platform-free:

- **Initial state, not just events.** The source reports the current
  foreground/background state at subscription (the live one queries the platform's
  application state on the main actor). A client created after the app is already
  active must connect the stream immediately — waiting for a foreground
  *transition* that already happened would leave SSE closed for the whole session.
  Where lifecycle APIs are unavailable (some extension contexts), the initial
  state is foreground and no events ever arrive.
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
- **A nudge during an in-flight fetch is retained, not dropped.** Coalescing into
  the in-flight request can lose an update: the server may have chosen that
  response before the announced version was published. The runtime keeps the
  latest differing announced token as *pending* (last one wins — versions are
  identity tokens, never `max`ed); when the shared fetch completes, a pending
  token that still differs from the fetched `lastKnownVersion` triggers exactly
  one follow-up fetch.

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
and `If-None-Match: {etag}` when the newest representation (staged, else
activated — §4) carries one.

- **200** → decode `{version, values}` — `version` must be a non-negative integer
  representable as `Int`; any shape violation → `invalidResponse` — and stage the
  new representation with its response `ETag` and `fetchedAt` (§4). Decode
  failure is **atomic**: an invalid body changes nothing — no staged
  representation, no metadata, no clock. A 200 with no `ETag` header is accepted;
  the staged representation carries a nil ETag and later requests send no
  `If-None-Match` for it.
- **304** → refresh the `fetchedAt` of the representation whose validator was
  sent (a 304 carries no version; its other headers are ignored):
  - staged confirmed → update staged `fetchedAt` only — staged metadata must
    never be combined with activated values;
  - activated confirmed → update activated `fetchedAt` **and persist the cache
    file** (a metadata-only write, no observation or `LeverUpdate`) — otherwise
    the refreshed clock is lost on relaunch and the next launch refetches inside
    the interval;
  - no `If-None-Match` sent → `invalidResponse`.
- **401** → `LeverError.invalidKey`; **any other status — 204 and the rest of the
  2xx range included** → `.server(status:)`; transport failures →
  `.network(code)`; a non-HTTP `URLResponse` → `invalidResponse`. Task
  cancellation surfaces as `CancellationError`, never `.network(.cancelled)`
  (§5.1).
- **Redirects are not followed** — the delegate refuses them and the 3xx maps to
  `.server(status:)`. The `Authorization` header must never travel to an origin
  the developer did not configure.
- The resolve body is decoded without an explicit size cap — a deliberate
  decision: the server is the developer's own deployment, and the config payload
  is bounded by the admin-side limits, not by the SDK.
- One dedicated `URLSession` with an **ephemeral** configuration, pinned
  explicitly rather than inherited: `urlCache = nil` and
  `requestCachePolicy = .reloadIgnoringLocalCacheData` (the SDK's ETag + disk
  cache *is* the cache; a second HTTP cache underneath produces confusing
  double-freshness), `httpCookieStorage = nil` +
  `httpShouldSetCookies = false`, `waitsForConnectivity = false` (fail fast; the
  floor handles it), request timeout 15 s.

### 6.2 SSE

`GET {baseURL}/v1/stream`, same auth, `Accept: text/event-stream`, read via
`URLSession.bytes`. No third-party client exists in Foundation; the SDK owns a
minimal parser for what the server actually emits (spec 0001 §7): `event:`/`data:`
frames, `:` comment heartbeats, `retry:` (parsed and **discarded** — backoff is
client-owned), tolerant of LF/CRLF and frames split across chunks. The parser
bounds one frame at 1 MiB — the server emits tiny frames, so an overrun means a
broken peer; the stream is treated as errored and reconnects through backoff
rather than buffering without limit.

State machine, owned by the runtime actor, active only while foregrounded:

```
disconnected ──connect──▶ connecting ──200──▶ open ──frame──▶ (nudge §5.3)
     ▲                        │                 │
     │                     failure         silence > 60 s / error / EOF
     └──── backoff(n) ◀───────┴─────────────────┘
```

- **Open means validated**: the connection is `open` only on an HTTP 200 whose
  `Content-Type` is `text/event-stream` (parameters ignored). Anything else never
  reaches the parser — a proxy's 200 HTML error page must fail fast, not sit in
  the byte loop until the watchdog fires. Non-200, wrong/missing media type,
  a redirect (refused, as in §6.1), or a non-HTTP response → a failed connect
  into backoff; **503** and **401** keep their specific handling below.
- **Idle watchdog**: any bytes (heartbeats included) reset a 60 s timer; expiry
  kills the connection. Server heartbeats every 25 s, so 60 s means two lost
  beats — decisive without flapping (research 0002 §3.6).
- **Backoff**: full jitter over an exponential ceiling — delay
  `random(0, min(60, 2ⁿ))` seconds from attempt n. A successful open that then
  receives any frame resets n. **503** (capacity shed, spec 0001 §7) honors
  `Retry-After` as the floor delay for that round — integer seconds only (the
  syntax the service emits), capped at 300 s; an unparseable value is ignored.
  **401** stops reconnecting until the next foreground.
- **On reconnect**, the server replays the current version as the first frame;
  §5.3's dedupe makes missed-while-disconnected publishes exactly one fetch and
  quiet reconnects free.

## 7. Cache files

Two files under `{cacheDirectory ?? Application Support}/Lever/`, splitting what
must survive credential rotation (identity) from what a rotation may discard
(a snapshot):

**`identity.json`** — one per cache directory, shared by every client using it:

```json
{ "schemaVersion": 1, "clientId": "6f9a…" }
```

- **`clientId`**: lowercase UUID generated on first run, written immediately at
  `init` (before any fetch exists), sent on every resolve. It is an
  *installation* identifier — stable across key rotation, environments, and
  contexts — because it is the future rollout bucketing key (research 0001 §4.4),
  and a bucketing key that reshuffles when a credential rotates would re-randomize
  every percentage rollout. Corrupt or overlong (spec 0001 §6.2 caps it at 64
  chars) → regenerate with a `warn`. First creation uses **exclusive create**
  (`O_CREAT | O_EXCL` semantics), and a loser re-reads the winner's file — atomic
  replace alone would let two racing processes keep different in-memory
  identities while one file silently wins.

**`{key-hash}.json`** — the snapshot file, one per environment, where `key-hash`
is the first 16 hex chars of SHA-256 over
`canonicalBaseURL + "\n" + (cacheNamespace ?? clientKey)` (canonicalization per
§3):

```json
{
  "schemaVersion": 1,
  "version": 42,
  "etag": "\"a1b2c3d4e5f60718\"",
  "values": { "enable_enrollment": { "type": "boolean", "value": true } },
  "fetchedAt": 1755100000,
  "activatedAt": 1755100000
}
```

- All fields are **required** except `etag` (nullable — a 200 without an ETag,
  §6.1); the file exists only once something has been activated, so there is no
  half-empty state to represent. Timestamps are integer Unix seconds; `version`
  is a non-negative `Int`. Anything else is corrupt.
- `values` is the **raw wire payload** of the last-activated snapshot, untouched —
  the cache replays a resolve response, it does not re-encode typed values, so read
  semantics (§2.3) are identical from cache and network by construction.
- Written atomically (`.atomic`) on every activation **commit** — metadata-only
  commits included (§4) — and on a 304 that confirms the activated
  representation (§6.1), so revalidated freshness survives relaunch. A write
  failure logs at `error` and does not change the
  result of the in-memory activation: reads serve the new snapshot; only the floor
  is stale. Unreadable/corrupt/wrong-`schemaVersion` → `warn`, treat as first run,
  overwrite on next activation. The file is a cache: a schema bump discards, never
  migrates.
- **Key rotation**: the default hash input is the client key, so rotating it
  orphans the old snapshot — one cold start's worth of degradation, plus disk
  garbage. Setting `cacheNamespace` (e.g. `"prod"`) pins the hash to a name the
  developer controls, so a shipped key rotation lands on the warm floor. The
  README recommends it; `clientId` is stable either way.
- **Context is not part of the identity.** Two clients with the same environment
  but different contexts share a snapshot file, last-writer-wins. That is
  deliberate: the snapshot is "last activated *for this environment*", the next
  fetch re-resolves for the reading client's context, and putting context in the
  hash would orphan the cache on every app update (`appVersion` changes) — a far
  worse trade than briefly serving a sibling's resolved values, which are still
  valid published values of the same environment.
- Plain file, no protection class beyond the default: values are public by design
  (research 0001 §6).

**App Groups.** Pointing `cacheDirectory` at an App Group container shares the
floor with processes **on the same device**: an iOS app with its iOS
widgets/extensions via an iOS container, a watchOS app with its watchOS
widget/complication extensions via a watchOS container on the Watch. It never
spans devices — an iPhone app and an independent watchOS app are separate
hardware; the watch app runs its own `LeverClient` and fetches for itself.
Atomic replace makes torn reads impossible, but not lost writes: the supported
topology is a **single authoritative writer** (the app) with other processes as
readers, and the reader role is expressible — extensions construct their client
with `automaticUpdates = false` (§5) and never write unless they deliberately
call `fetchAndActivate()`. Simultaneous writers degrade to last-writer-wins;
`NSFileCoordinator` is out of scope for v1 (§11).

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
arrive via the nudge path; same-device extension parity (widgets) comes from an App
Group `cacheDirectory`, while a watch app on its own device runs its own client
(§7). No SDK feature beyond this spec is required.

## 10. Testing

`swift-testing` throughout (`@Test`, `#expect`); no XCTest. Determinism comes from
seams, not sleeps: the runtime actor takes a monotonic `Clock` (default
`ContinuousClock`; tests inject a manual clock), a wall-clock date provider (§5.1's
second seam), an injectable jitter RNG, a notification source with an initial state
(§5.2), and a transport protocol (`LeverTransport`) whose test double serves
scripted responses and records requests.

### 10.1 The floor suite (the headline — research 0001 §7)

- First run, transport failing → every read returns its code default; no throw.
- Cache present, transport failing → reads serve cached values from the first
  statement after `init`, before any async work.
- 401 on fetch and on stream → cached values keep serving; the cache file is not
  deleted; stream stops retrying until foreground.
- Corrupt / wrong-schema cache file → defaults, `warn`, next activation rewrites.
- Type mismatch, fractional-to-`Int`, out-of-range `number`, failing `json`
  decode → default + deduped warn, across every typed initializer.
- Key rotation with a warm offline cache: `cacheNamespace` set → the floor
  survives; default (key-derived hash) → cold snapshot but `clientId` stable
  either way.
- Cache-write failure → in-memory activation stands; `error` logged; reads serve
  the new snapshot.

### 10.2 Semantics

- Staging: fetch does not change reads; `activate()` swaps atomically; identical
  staged payload → `activate() == false`, no `LeverUpdate`, no observation fire.
- Metadata-only commit: same values under a new version/ETag → `activate() ==
  false`, no update, no observation, **but** `activatedVersion`, the ETag, and the
  cache file all advance and survive a restart. First activation of
  `{version: 0, values: {}}` → `activatedVersion == 0`.
- `LeverUpdate.changedKeys` matches the raw diff exactly (added, removed, changed).
- ETag: second fetch sends `If-None-Match`; 304 refreshes the clock, values and
  version untouched. Representation ownership (§4, §6.1): a 304 confirming
  activated state persists freshness across a restart (no refetch inside the
  interval); a 304 confirming staged state updates staged metadata only — never
  combined with activated values; fetch-200-stage → fetch-304 → activate works;
  an unsolicited 304 → `invalidResponse`. The §6.1 status matrix: 204/other-2xx,
  missing ETag on 200, non-HTTP response, refused redirect, invalid `version`,
  and the invalid-200 atomicity rule (nothing changes).
- Interval: `init` within the interval issues no request (transport double
  asserts); explicit `fetch()` always issues one; a nudge issues one regardless of
  the interval and resets the clock. Zero interval held foregrounded under
  simulated time → no timer loop; a positive sub-60 s interval arms the timer at
  the 60 s floor while lifecycle edges keep the configured value; exactly 60 s
  arms as configured; negative input clamps with a warn; a failed automatic fetch
  re-arms from the attempt, never hot-loops on an expired deadline; wall-clock
  jumps do not disturb the monotonic timer.
- Cache-only (`automaticUpdates = false`): reads serve the cache synchronously;
  the transport double records zero requests and no timer/lifecycle/SSE work
  starts; multiple readers never write; an explicit `fetchAndActivate()` still
  works as the deliberate override; a writer's atomic update is visible to the
  next reader initialization.
- Coalescing: one waiter's cancellation leaves the shared fetch running and
  rethrows `CancellationError`; teardown cancels the transport; automatic paths
  never log cancellation as a failure.
- Nudge dedupe: announced `N == lastKnownVersion` → no fetch; differing `N`
  (higher **or lower** — the backup-restore case) → fetch; `lastKnownVersion`
  advances only from fetch responses. `autoActivateOnNudge = false` stages only.
- JSON memoization: the same wire key read through two `LeverKey`s with different
  `Value` types decodes each type correctly (no cross-type reuse).
- Reentrancy: a log sink and an observation callback that read a flag while
  handling a notification must not deadlock (no-callout-under-lock, §4.1).
- Version normalization: `"5.2"` → `"5.2.0"` on the wire; in-limit garbage logs an
  error and is sent verbatim; overlong reserved fields are omitted; attribute
  violations drop deterministically per §3 (21 valid attributes under different
  insertion orders select the same 20; Unicode boundary cases use UTF-16 length).

### 10.3 SSE

- Parser: frames split across arbitrary chunk boundaries, comment heartbeats,
  CRLF/LF, `retry:` ignored, unknown fields skipped.
- Connect validation: a 200 with an HTML content type fails fast into backoff
  without entering the parser; non-200, redirect, and non-HTTP responses map per
  §6.2; 503 `Retry-After` and 401 keep their specific handling.
- State machine (manual clock): 60 s silence → reconnect; backoff delays within
  the jitter envelope and reset after a successful frame; 503 honors
  `Retry-After`; background tears down, foreground reconnects; the replayed
  connect frame after a missed publish yields exactly one fetch; a client created
  while already foregrounded connects without waiting for a transition.
- Pending nudge: the F4 ordering — a nudge for version 3 arriving while the
  version-2 fetch is in flight yields exactly one follow-up fetch; a nudge already
  covered by the in-flight response yields none; several nudges during one fetch
  coalesce to one follow-up; a *lower* pending token still refetches.
- Teardown: client deallocation cancels timer, watchdog, stream, and in-flight
  fetch; the session is invalidated; no sink or continuation fires afterwards.

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
  fetch rather than just read (`automaticUpdates = false` covers the read-only
  case in v1 — §5, §7).
- **`@LeverValue` property wrapper** and **key codegen** (`lever pull --swift`) —
  research 0002 §5, after the flagship migration proves the base API.
- **Background refresh** (`BGAppRefreshTask`) if launch-time staleness ever
  matters in practice; deliberately absent from v1.

## 12. Implementation notes

Decisions this spec did not pin, settled while building M1–M10 and recorded here
so the Kotlin and TypeScript SDKs inherit the same answers.

- **`json` models must be `nonisolated` under `MainActor` default isolation.**
  A target compiled with `-default-isolation MainActor` gets a main-actor-isolated
  synthesized `Decodable` conformance, which cannot satisfy
  `LeverKey(json:default:)`'s `Decodable & Sendable` requirement. Decoding runs
  off the main actor, so `nonisolated struct` is the honest annotation rather
  than a workaround. It is in the README beside §2.2's "prefer value types"
  guidance, and both consumer fixtures compile it. This is the one piece of
  friction the isolation spike found; it needs no API change.
- **The initial lifecycle phase is the init fetch.** §5.1 ("on `init`, run the
  automatic fetch path") and §5.2 ("foreground: run the automatic fetch path")
  read as two triggers, and implementing them as two made a failing first launch
  issue two requests — they coalesce only when concurrent. Since the notification
  source reports its current phase at subscription (§5.2), the first phase event
  *is* the init trigger, for a client born backgrounded as much as foregrounded.
  One trigger, one request.
- **A stream round that received a frame still backs off before reconnecting.**
  §6.2 says a successful open that receives a frame resets `n`; read literally
  as "reconnect immediately", a server that closes right after the connect frame
  becomes a reconnect hot loop. Receiving a frame resets the counter, and the
  reconnect still takes its `random(0, 2⁰)` delay.
- **The identity file is published with `link`, not `O_CREAT | O_EXCL`.** An
  exclusive create publishes the name before the bytes, so a racing process can
  read an empty file, judge it corrupt, and overwrite the winner's `clientId`
  with its own — the exact split identity §7's exclusive create exists to
  prevent. Writing a temp file and hard-linking it into place makes "the file
  exists" mean "the file is complete", which is what the loser's re-read depends
  on.
- **The resolve query string is byte-defined.** §6.1 names the query items but
  not their order or encoding, and the contract fixtures compare request bytes.
  The rule, pinned on both sides in `packages/contract-fixtures/README.md`:
  reserved names first in the fixed order `platform`, `appVersion`, `clientId`,
  then `attr.*` sorted by name in ascending UTF-8 byte order; every value
  percent-encoded over UTF-8 against the RFC 3986 unreserved set
  (`A-Za-z0-9-._~`), so a space is `%20` and never `+`. The same byte ordering
  is what §3's deterministic twenty-attribute selection sorts by.
- **The §10.4 fixture format grew what generation required.** Each case carries a
  `setup` (conditions, parameters, whether to publish) so the service's
  integration tests can build the environment and record the real response; a
  step may carry `before: "rotate-key" | "publish"` to move the server between
  requests; `ifNoneMatch` is `{ "fromStep": n }` rather than a literal, so a
  regenerated ETag cannot desync from the validator that references it; and
  `expect` carries `changed`, `error`, and `reads` (with an SDK-side type per
  read, which is how the mismatch tape says what it means). Responses are
  recorded, never hand-written.

### 12.1 Settled by implementation review pass 1

[Pass 1](./implementation_review_p1.md) found six defects in the Swift
implementation. All six were real; the resolutions below are contract-level, so
the Kotlin and TypeScript SDKs inherit them rather than rediscovering them.

- **A nudge's activation policy is caller interest, not a token.** §5.3's
  pending-nudge rule tracks the announced *version*, which decides whether a
  follow-up request is needed. That is not enough: a nudge that lands while a
  staging-only `fetch()` is in flight is answered by that request, the announced
  version stops differing, and nothing activates — reads keep serving the old
  snapshot with `autoActivateOnNudge` on. A nudge must **join** whatever
  transport work answers it and apply its own policy when that work completes,
  exactly as §5.1's "each caller independently applies its own policy" says.
  Joining has to happen synchronously, at the moment the nudge is handled, or it
  can slip past the very request it meant to join.
- **The 1 MiB frame bound is accounted while parsing, not after.** A bound
  checked on what is *left over* after consuming a chunk never sees a terminated
  oversized line — that line is built, used, and discarded first. The parser
  counts every byte of the current frame, across all field kinds, comments
  included, and rejects **before** appending or decoding. The frame budget resets
  when a blank line dispatches. Underneath it, transports must chunk on size as
  well as on newlines: a peer that never sends a newline would otherwise grow an
  unbounded buffer below the parser, where the frame bound cannot see it.
- **Snapshot persistence carries a commit sequence.** §4.1 puts filesystem I/O
  outside the state lock, which leaves two commits free to reach the disk in
  either order — a thread preempted between committing version 2 and writing it
  can land after a version 3 write, and the next launch restores version 2 over a
  process serving version 3. Nothing detects that: it is an ordering bug, not a
  data race. Every persisted snapshot is stamped with a sequence allocated under
  the state lock, writes are serialized, and an out-of-order write is dropped.
  A 304's freshness write is sequenced the same way.
- **Singleton installation is reserved atomically.** Checking "not configured",
  releasing the lock, building a client, and then installing it lets two callers
  both pass the check and both build a live runtime. Installation moves
  `empty → reserved → installed`, with client construction outside the lock
  because it touches the filesystem and the host's log sink.
- **Arithmetic on persisted time saturates.** Cached timestamps are Unix seconds
  and must be non-negative; a structurally valid file carrying a negative one is
  corrupt, because it would otherwise reach elapsed-time arithmetic and trap —
  turning a corrupt cache into a crash, which §10.1 forbids. Elapsed-time and
  deadline arithmetic saturate rather than overflow, and `minimumFetchInterval`
  is clamped to 365 days with a `warn`, consistent with §3's repair-and-log
  policy for every other out-of-range input.
- **A persisted `clientId` must parse as a UUID — but a non-canonical spelling is
  rewritten, not regenerated.** §7 defines the identity as a lowercase UUID, so
  anything unparseable is corrupt and regenerates. An uppercase or mixed-case
  UUID is the *same installation*, though, and regenerating it would reshuffle
  the rollout bucketing key over a difference in spelling — worse, two SDKs
  sharing a cache directory that each regenerated on the other's casing would
  reshuffle it forever. It is canonicalized in place and kept.

The §10.4 fixtures' `clientId` is a canonical lowercase UUID for the same reason:
a tape must pin an identity an SDK could actually have produced.
