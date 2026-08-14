# 0002 — lever-swift: the Swift SDK

- **Status:** pre-implementation (scope settled 2026-08-13)
- **Date started:** 2026-08-13
- **Scope:** the Swift client SDK — an SPM package any Apple-platform app adds,
  configures with a URL + client key, and reads config through. Server contract is
  fixed by spec 0001; this document decides everything client-side.

> Research documents capture where we came from, what we're thinking, and what purpose
> we're after — _before_ a spec pins down the how. A spec should be able to cite this
> document for every "why".

## 1. Purpose — what we're after

The service is implemented (spec 0001, `implemented`). The next milestone is the first
SDK, and it is Swift — a deliberate reordering of 0001 §8, which sketched TypeScript
first. The reasons: the flagship iOS app is the consumer with the live Firebase Remote
Config bill and the settled migration path (replace the guts of one wrapper, 0001 §2),
so a Swift SDK converts directly into the acceptance test; and with the wire contract
already frozen and exercised by the service's own tests, SDK order is free — nothing
downstream depends on TypeScript landing first.

After v1, an app developer can:

- `Lever.configure(baseURL:clientKey:context:)` at launch and read typed values
  synchronously anywhere, with SwiftUI views updating live when new config activates.
- Kill the network entirely and still get last-activated values, or code defaults on a
  first run — the three-layer floor, proven by tests.
- Watch a gate flipped in the dashboard land in a foregrounded app within seconds via
  the SSE nudge.

## 2. Where we came from — the flagship integration (audited 2026-08-13)

The flagship iOS app's Remote Config integration is two files and intentionally thin —
the shape lever inherits and must improve on:

- **11 keys** (9 boolean gates + 2 strings), fetched-and-activated at launch with a
  DEBUG zero-interval bypass, plus the **realtime listener** re-activating and
  republishing mid-session. Live flips are load-bearing, not decorative.
- Firebase is linked only in the app target; the app's own framework code never
  imports it. Values cross the boundary by being **published into UserDefaults**,
  where reactive readers pick them up. The SDK must be comfortable sitting behind
  exactly this kind of one-file seam.
- **Code defaults are declared nowhere** — no defaults plist, no registration; each
  read site repeats its own fallback literal. A typed-key API with the default
  attached to the key's single declaration closes this gap outright.
- Firebase's disk cache **never reaches the widget and watch extensions**; they see
  flags only via the UserDefaults bridge. A cache file that can live in an App Group
  container fixes what Firebase couldn't.
- The app is Swift 6 / strict concurrency (`complete`), iOS 18 + watchOS 11 floor,
  with app-target code under `MainActor` default isolation and its library package
  under nonisolated default isolation. The SDK gets consumed from **both** isolation
  worlds and must compile warning-free in each.

## 3. The forks and how they were called

### 3.1 Home: **its own public repo, `lever-swift`**

SPM resolves versioned dependencies from a `Package.swift` at the repository root, so
a dedicated repo with its own semver tags is the zero-friction consumption story —
`https://github.com/…/lever-swift`, add package, done. Vendoring it inside this
monorepo would force consumers to clone the whole service repo and would tie SDK
releases to service tags. The monorepo keeps `packages/contract-fixtures` as the
cross-SDK honesty check; the SDK repo consumes those fixtures in CI.

### 3.2 Platform floor: **Swift 6, current-OS baseline, every Apple platform**

`swift-tools-version: 6.0`, `swiftLanguageModes: [.v6]`, strict concurrency clean.
Platforms: iOS 18, macOS 15, watchOS 11, tvOS 18, visionOS 2. The first consumer
already sits on this floor, and it buys the modern primitives outright — Observation
everywhere, `Mutex` from Synchronization, `URLSession.bytes` — instead of
availability-gated compromises. watchOS is a first-class target (the flagship ships a
watch app), which also enforces the discipline of zero UIKit dependencies in the core.

### 3.3 API shape: **instance-based core, shared convenience on top**

`LeverClient` is the real object — constructible with explicit configuration,
injectable, multiple instances allowed (tests, staging-vs-prod side by side).
`Lever.configure(…)` installs the default instance and `Lever.shared` reads it —
the Firebase-shaped path for the common case. The convenience is sugar over the
instance API, never a second implementation.

### 3.4 Value access: **typed key definitions**

Keys are declared once, as typed constants carrying their code default:

```swift
extension LeverKeys {
    static let enableEnrollment = LeverKey("enable_enrollment", default: false)
    static let captchaBaseURL = LeverKey("captcha_base_url", default: "")
}

let on = lever[.enableEnrollment]   // Bool — synchronous, non-optional
```

This is 0001 §2's "one wrapper class per app" promoted into the SDK's type system: the
key declaration file _is_ the wrapper. The default lives with the key, so it cannot
drift between call sites (the exact disease the flagship audit found). Reads are
non-optional and infallible — a missing key or a server-side type mismatch yields the
default and a loud log line, never a throw (0001 §4.2). Stringly getters
(`bool("key", default:)`) were rejected for v1: they reintroduce call-site defaults,
and the typed-key layer can always grow a dynamic escape hatch later without breaking
anything.

`json` parameters decode into `Decodable` types at the key level
(`LeverKey("paywall", default: PaywallConfig())`), with decode failure falling back to
the default like any other mismatch.

### 3.5 Reactivity: **Observation, built in**

The activated snapshot is exposed through an `@Observable` surface, so a SwiftUI view
that reads `lever[.enableEnrollment]` in `body` re-renders when `activate()` swaps the
snapshot — no publishers to wire, no notification plumbing. For non-UI consumers
(services, the flagship's UserDefaults bridge) the client exposes an
`AsyncStream`-based updates sequence that emits on every activation. Reads stay
synchronous off a lock-protected snapshot; Observation is the notification channel,
not the storage.

### 3.6 Transport: **SSE in v1**

The realtime listener is in active use today (§2), so the replacement ships with it —
the thin version 0001 §3.2 already pinned: version nudges only, auto
fetch-and-activate on nudge with an opt-out, stream held only while the app is
foregrounded, jittered backoff on reconnect (ignoring the server's `retry:` hint, per
spec 0001 §7), >~60 s of silence treated as a dead stream, and 503-at-capacity or any
persistent failure degrading to min-interval polling — never to broken config. Nudge
dedupe is **identity, not ordering**: fetch when the announced version differs from
the last activated one, and learn the current version only from fetch responses
(spec 0001 §7's self-healing rule). There is no SSE client in Foundation; the SDK owns
a small `URLSession.bytes`-based parser for the event-stream format the server
actually emits (`event: version` frames + comment heartbeats).

### 3.7 Integration posture: **framework-agnostic core, seams for the host app**

The flagship is a TCA app whose services are dependency-client structs — but the SDK
depends on none of that. Zero third-party dependencies; the package must wrap cleanly
into whatever DI the host uses (a `@DependencyClient` in the flagship's case) and work
bare in a plain SwiftUI app. Two seams make it a good guest:

- **Logging is injectable** — a small `LeverLogSink` protocol with an `os.Logger`
  default, so host apps route SDK logs through their own pipeline. Mirrors the
  vendor-boundary pattern the flagship already uses for analytics.
- **Cache location is configurable** — default Application Support, optionally an App
  Group container so widget and watch extensions read the same activated values the
  app does (§2's Firebase gap).

## 4. Strategy — the shape

### 4.1 The contract

```swift
// App startup
Lever.configure(
    baseURL: URL(string: "https://config.example.dev")!,
    clientKey: leverClientKey,          // pk_…, an identifier, not a secret
    context: LeverContext(
        platform: .current,             // "ios" / "watchos" / … by default
        appVersion: Bundle.main.leverAppVersion,
        attributes: ["cohort": "beta"]
    )
)

// Reads — synchronous, stable until the next activation
if Lever.shared[.enableEnrollment] { … }

// Explicit control when wanted
try await lever.fetch()                 // stages; reads unchanged
lever.activate()                        // swaps the snapshot, notifies observers
try await lever.fetchAndActivate()

for await update in lever.updates { … } // re-emits on every activation
```

- `configure` validates `appVersion` as strict semver and warns loudly on anything
  else — a non-semver version silently matches no version clause (spec 0001 §4).
- Configuration carries the nudge policy (`autoActivateOnNudge`, default on — the
  0001 §4.4 invariant), the min fetch interval (default 12 h, DEBUG-friendly
  override), and the cache container.

### 4.2 Lifecycle, owned by the SDK

- **On configure:** load the cached last-activated snapshot synchronously (reads are
  correct from the first line after `configure`), then fetch-and-activate in the
  background — immediately on first run, respecting the min interval afterwards.
- **On foreground:** reconnect the stream; fetch if the min interval has elapsed.
  On background: drop the stream. Watched via cross-platform notifications, no
  UIKit dependency.
- **On nudge:** fetch immediately (nudges bypass the min interval by design) and
  auto-activate unless opted out.
- **On failure:** any fetch or stream error leaves the current snapshot in place.
  A 401 — including key rotation, which has no grace window (spec 0001 §11) — serves
  cached values and never wipes the cache. The floor is: live values → disk-cached
  last-activated values → code defaults.

### 4.3 Persistence

One atomic JSON file per client: the last-activated payload (`version`, `values`),
its `ETag` for `If-None-Match` revalidation across launches, the last fetch timestamp
for the min-interval clock, and the generated `clientId`. Values are public by design
(0001 §6), so a plain file is correct — no Keychain, no encryption theater. The
`clientId` is a UUID generated on first run, persisted, and always sent — inert in v1,
but it makes v1.x percentage rollouts work fleet-wide with no SDK update (0001 §4.4).

### 4.4 Concurrency shape

Strict-concurrency clean from both `MainActor`-default and nonisolated-default
consumers (§2). The working shape: the activated snapshot behind a `Mutex` for
synchronous sendable reads, an internal actor owning the fetch/stream/interval
machinery, and the `@Observable` surface as the change-notification layer. The spec
pins this down; the constraint that matters here is **synchronous non-async reads** —
`await` to read a feature flag in `body` is a non-starter.

### 4.5 Tests

`swift-testing`, no XCTest. The three-layer floor is the headline suite — first run
offline, cache served offline, 401 non-wiping, mismatch-to-default — per 0001 §7's
"tests, not intent". Transport tests run against a stub `URLProtocol` speaking the
recorded wire shapes; the HTTP contract cases `packages/contract-fixtures` promises
(ETag/304, empty-context defaults) get authored as part of this work so all three
SDKs replay the same tapes. The end-to-end acceptance test remains 0001 §8's:
migrate the flagship wrapper.

## 5. The cut

**v1 (`lever-swift` 0.x → 1.0):** the package as scoped above — typed keys, three-layer
floor, fetch-and-activate, SSE nudges with polling degradation, Observation +
`updates`, App-Group-capable cache, injectable logging, contract-fixture CI.

**Later:** a `@LeverValue` SwiftUI property wrapper if the raw subscript proves
noisy in practice; a dynamic string-getter escape hatch if a real consumer needs
runtime-determined keys; codegen of key declarations from the environment's published
schema (`lever pull --swift`, the 0001 §5 CLI).

## 6. Non-goals

- **No local rule evaluation.** The SDK never grows a rule engine (0001 §3.1); the
  contract-fixtures evaluation set stays a server concern.
- **No non-Apple platforms.** Linux/server-side Swift is not a target; server-side
  consumers get the TypeScript SDK.
- **No bundled framework integrations.** No TCA dependency client, no Combine shims —
  the core stays dependency-free and hosts wrap it.
- **No secrets in config values** — repeated loudly in the SDK's README, per 0001 §6.

## 7. Risks

- **SSE on iOS lifecycle.** Sockets across background/foreground, carrier NAT, and
  Cloudflare idle cuts are exactly where streaming clients rot. Mitigated by the
  design itself — the stream is an accelerant, polling is the truth — but the
  degradation paths need tests, not just the happy path.
- **Public API under strict concurrency is hard to walk back.** Sendability and
  isolation choices are ABI-adjacent; a wrong actor boundary in 1.0 is a breaking fix.
  The spec must nail §4.4 before code, and 0.x releases exist to shake it out against
  the flagship before a 1.0 tag.
- **Two repos, one contract.** The SDK repo can drift from the service. The contract
  fixtures running in the SDK's CI are the tether; authoring the promised HTTP cases
  is part of v1, not a follow-up.
- **First SDK sets the template.** Kotlin and TypeScript will copy this shape
  (lifecycle ownership, key model, nudge policy). Getting the contract semantics right
  here is triply leveraged — and so are mistakes.

## 8. Next step

Spec 0002: the Swift SDK — public API surface, concurrency model, cache file format,
SSE state machine, and the contract-fixture HTTP cases. Then the `lever-swift` repo
scaffold, implementation, and the flagship wrapper migration as acceptance.
