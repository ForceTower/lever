# Review 0002 — Swift SDK implementation-readiness findings

- **Reviewed:** 2026-08-14
- **Inputs:** [spec 0002](./spec.md), [plan 0002](./plan.md),
  [spec 0001](../0001-service/spec.md), and
  [research 0002](../../research/0002-swift-sdk/research.md)
- **Purpose:** an implementation-readiness audit for the next agent. This is not a
  replacement spec. Findings below should either be resolved in `spec.md` and
  `plan.md` or explicitly rejected with rationale before implementation begins.

## 1. Overall assessment

The architecture is strong. Typed synchronous reads, staged activation, a persistent
last-activated floor, server-side evaluation, SSE as an accelerator rather than the
source of truth, and deterministic test seams are all appropriate choices. The plan's
bottom-up sequencing is also sensible.

The documents are not yet fully implementation-ready, however. Several ambiguities
can cause correctness failures rather than mere API friction: cache identity conflicts
with context and key rotation, timer rules can create hot request loops, metadata can
remain stale after a value-identical publish, and a publish nudge can be lost while a
resolve is already in flight. These should be settled before M1–M4 lock their answers
into storage and public API decisions.

## 2. Release-blocking findings

### F1 — Cache identity is neither stable across key rotation nor isolated by context

The cache filename is the SHA-256 prefix of `baseURL + "\n" + clientKey` (spec §7).
That produces two opposite bugs.

1. Rotating a client key changes the filename. The corrected app no longer sees the
   previous warm cache, and it generates a new `clientId`. If its first launch after
   updating is offline, it falls to code defaults despite having a valid
   last-activated snapshot under the old filename. Future percentage-rollout
   assignment would also change on every key rotation.
2. Two explicit clients with the same URL and key but different `platform`,
   `appVersion`, or attributes use the same file even though the service may resolve
   different values for each context. An App Group makes that collision
   cross-process.

The statement that the same environment gets a stable file is therefore false across
credential rotation, while the statement that distinct instances get distinct files
is false for distinct contexts sharing a key.

**Recommended resolution:** add a stable cache namespace/environment identifier to
configuration, independent of the rotatable credential. Store installation identity
separately from resolved snapshots. Either include a normalized context fingerprint
in each snapshot's identity or explicitly define a single-authoritative-writer model
where other processes are cache-only readers. Specify base-URL canonicalization
before hashing.

**Required tests:** key rotation with a warm offline cache; stable `clientId` across
rotation; same URL/key with two contexts; two clients sharing an App Group.

### F2 — Zero intervals and failed automatic fetches can create hot loops

Spec §5.1 arms the foreground timer for `lastFetchAt + minimumFetchInterval` and
recommends `.zero` for DEBUG. After a successful zero-interval fetch, the next due
time is immediately in the past, so a rearming timer can fetch continuously.

Failures have the same shape. A failed automatic fetch does not change `lastFetchAt`.
If the due time was already in the past, blindly rearming at the same deadline can
immediately retry forever. The first-run offline case has no `lastFetchAt` at all.

`Duration` can also be negative. Without validation, a negative interval makes every
deadline overdue.

**Recommended resolution:** define `.zero` as "automatic lifecycle triggers are
always eligible" but disable the continuously rearming interval timer, or impose a
nonzero polling floor. Reject or clamp negative durations. After automatic failure,
schedule the next attempt from the attempt time using a defined interval/backoff,
never from an already-expired successful-fetch deadline.

The design also needs two time seams: a wall-clock/date provider for persisted Unix
timestamps and a monotonic suspending clock for timers. `ContinuousClock.Instant`
cannot be serialized and compared across launches.

**Required tests:** zero interval held foreground for simulated time; negative
interval validation; first-run offline; repeated 5xx/network failures; recovery after
a failure; wall-clock jump versus monotonic timer behavior.

### F3 — Value-identical publishes leave activation metadata ambiguous or stale

Spec §4 defines activation equality using the raw value map and says identical staged
payloads make `activate()` return `false` with no effects. The service, however,
changes version and ETag on every publish even if the values resolved for this client
are identical (spec 0001 §6.4).

As written, a value-identical publish may never persist the new version, ETag, or
fetch timestamp. `activatedVersion` can remain old across repeated successful
fetches. The version-0 empty response is the sharpest edge: activating
`{version: 0, values: {}}` over the initial empty state could leave
`activatedVersion == nil` forever.

**Recommended resolution:** separate representation activation from observable value
change.

- Activation always consumes the staged representation and commits its version,
  matching ETag, and cache metadata.
- `activate()` returns `true` only when the values serving reads changed.
- Observation and `LeverUpdate` fire only when values changed.
- `activatedVersion` becomes `0` after successfully activating version 0.
- A metadata-only commit still persists the cache.

Update the public comment from "snapshot changed" to "serving values changed" if
that is the chosen return contract.

**Required tests:** same values/new version; same values/new ETag; first activation of
version 0; restart after metadata-only activation; no observation/update for a
metadata-only commit.

### F4 — A nudge can be lost while a fetch is already in flight

Consider this ordering:

1. Version 2 nudge starts resolve A.
2. The server determines A's version-2 response.
3. Version 3 is published and its nudge arrives.
4. The version-3 handler coalesces into A.
5. A completes with version 2.

The version-3 frame has been consumed, but no second fetch is issued. The client stays
on version 2 until polling or reconnection.

**Recommended resolution:** retain a pending announced token (or at least a pending
nudge flag plus token) while resolve is in flight. After the shared fetch completes,
compare the pending token with the fetched `lastKnownVersion`; issue one follow-up
fetch if they still differ. Because versions are identity tokens rather than an
ordering, do not choose pending tokens with `max`.

The documents should also state that transport work, not higher-level activation
policy, is the unit being coalesced. Concurrent callers may independently choose to
activate after awaiting the same fetch result.

**Required tests:** the ordering above; a nudge that arrives before the server chooses
the response and is already covered by it; several nudges during one fetch; a lower
opaque token during a fetch.

### F5 — The stated actor boundary cannot implement synchronous `activate()`

The public API makes `activate()` synchronous, but spec §4.1 says public
`fetch`/`activate` forward to the runtime actor. A synchronous method cannot call an
actor-isolated method and wait for its result without changing the API to `async`.

**Recommended resolution:** make the ownership boundary explicit:

- The `LeverClient` core and its mutex own activated/staged snapshot state,
  synchronous reads, and synchronous activation.
- The runtime actor owns scheduling, lifecycle, fetch serialization, SSE, tasks, and
  timers.
- The actor calls thread-safe client-core operations to stage or activate results.

The lifetime model is also unspecified. A client retains its runtime, and runtime
tasks can retain the runtime/client indefinitely. Define how `deinit` cancels the
timer, fetch, watchdog, and SSE tasks and invalidates the dedicated `URLSession`.
Apple documents that a session retains its delegate until invalidated, so this is a
real leak boundary rather than test-only cleanup.

**Required tests:** client deallocation cancels all tasks; stream task terminates;
session invalidates; no callbacks occur after teardown; synchronous activation works
from multiple executors.

### F6 — App Group and extension behavior is overstated

Atomic replacement prevents a reader from seeing half of one encoded file, but it
does not prevent lost writes, two processes generating different `clientId`s, or a
context-specific snapshot overwriting another. Apple's shared-data guidance also
states that file coordination is essential for App Group/shared-space files.

App Groups provide same-device shared storage. They do not make an iPhone's container
available on its paired Apple Watch; companion-device transfer needs a mechanism such
as Watch Connectivity. The "widget/watch parity" claim must distinguish:

- an app and extension/widget on the same device, which may use an App Group; and
- iPhone and Apple Watch processes on different devices, which cannot share a local
  file directly.

There is also no cache-only mode. Constructing `LeverClient` automatically starts
networking and lifecycle machinery, which may be inappropriate for widgets,
complications, previews, or read-only extensions.

**Recommended resolution:** either implement coordinated multi-process writes or
define a single writer plus cache-only readers. Add an automatic-networking/cache-only
configuration mode if extensions are a supported use case. Correct the watch claim
and explicitly scope App Group sharing to processes with access to the same local
container.

**Required tests:** simultaneous first initialization, simultaneous activation,
single-writer/read-only-reader behavior, and an acceptance test for every extension
type actually claimed.

### F7 — Configuration validation does not cover the complete server limits

Spec 0001 §6.2 limits `platform`, `appVersion`, and `clientId` to 64 characters. Spec
0002 validates semver and attributes but does not bound a custom `LeverPlatform` or
an invalid overlong `appVersion`. Sending either causes a 400 for the whole resolve,
contradicting the stated floor-preserving validation policy.

The `> 20 attributes` rule is nondeterministic as written: it says to drop invalid
entries, but excess count is a property of the collection, not an individual entry.
Swift dictionary iteration must not decide which targeting inputs survive.

String length must match the server's JavaScript/Zod semantics. Swift `String.count`
counts extended grapheme clusters, while JavaScript string length counts UTF-16 code
units; non-ASCII boundary cases can otherwise pass the SDK and fail the server.

**Recommended resolution:** mirror every wire limit using UTF-16 length. Define a
deterministic excess-attribute rule, preferably rejecting/dropping entries after a
sorted order or dropping all attributes with a clear error policy. Define whether an
overlong or malformed reserved field is omitted or sent; it must not produce a 400 if
the goal is freshness preservation.

Also define base URL validation and normalization: accepted schemes, handling of a
base path and trailing slash, and rejection or preservation of query/fragment
components.

**Required tests:** Unicode boundaries, 21 valid attributes in different insertion
orders, overlong platform/appVersion, base path/trailing slash, invalid schemes, and
query percent encoding.

### F8 — The cache schema cannot represent its promised first-run write

The example cache file requires version, ETag, values, `fetchedAt`, and `activatedAt`.
Spec §7 also requires writing the file immediately when first generating `clientId`,
before any fetch or activation necessarily exists. The schema does not say which
representation fields may be absent or null.

Other undefined storage cases include:

- whether a missing ETag on a 200 is accepted without revalidation or makes the
  response invalid;
- what a 304 means if no representation is associated with the sent ETag;
- whether a cache write failure changes the result of synchronous `activate()`;
- timestamp units and precision beyond the example;
- allowed version range and whether negative/fractional versions are rejected;
- whether a metadata-only activation writes the file.

**Recommended resolution:** publish a precise Codable schema with required/optional
fields and invariants. A clean alternative is a stable identity file plus a separate
optional activated-snapshot file.

## 3. Important implementation constraints missing from the spec

### F9 — Establish a strict no-callout-under-lock rule

`Synchronization.Mutex` is non-recursive. The spec should prohibit invoking any
external or potentially reentrant work while holding it, including:

- `LeverLogSink.log`;
- Observation registrar callbacks;
- `AsyncStream.Continuation.yield` or termination handling;
- filesystem I/O;
- arbitrary `Decodable` work or `JSONDecoder` callbacks.

A host log sink can read a flag while handling a warning; logging under the mutex
would deadlock. Activation should compute/swap minimal state under the lock, then
persist, log, notify Observation, and yield updates outside it. If persistence fails,
the in-memory activation result and error logging policy must be explicit.

### F10 — JSON memoization needs the requested Swift type in its identity

The spec says JSON is decoded once per `(key, version)`. An app can declare two
`LeverKey`s with the same wire name but different `Decodable` result types. A typed
memoized value cannot safely be reused across both.

Key the decoded cache by at least `(wire key, activated representation identity,
Swift type identity)`, or memoize only serialized JSON `Data` per key/version and
decode separately per requested type. The mismatch-warning dedupe policy should also
state whether expected Swift type participates in its identity.

### F11 — Cancellation semantics for coalesced fetches are unspecified

Define the behavior when one waiter on a shared fetch is cancelled:

- cancellation of one waiter should not normally cancel work required by other
  callers;
- cancellation of the client/runtime must cancel the underlying transport;
- automatic callers log failures but should not log normal task cancellation as a
  network error;
- explicit calls should preserve meaningful cancellation rather than always mapping
  it to `LeverError.network(.cancelled)`.

Add cancellation tests to M5 and teardown tests to M6/M7.

### F12 — Initial lifecycle state is undefined

If the client is created after the app is already active, it may never receive a
foreground transition notification and therefore may never open SSE. The injected
notification source needs an initial foreground/background state, not only future
events. Define multi-scene/process semantics and the behavior when lifecycle APIs are
unavailable, such as some extension contexts.

### F13 — `lastKnownVersion` terminology conflicts across documents

Spec 0002 correctly needs fetched-but-not-activated staged state to suppress repeated
nudges. Spec 0001 §7 and parts of the research describe comparison with the last
*activated* version. With `autoActivateOnNudge == false`, those are different.

Choose and use one term across both specs. A useful invariant is: compare nudges with
the version of the newest successfully resolved representation held by the process,
whether staged or activated; learn it only from a validated 200 representation (a
304 merely confirms the representation already associated with the ETag).

### F14 — Several transport edge cases need explicit mapping

Specify and test:

- 2xx statuses other than 200, especially 204;
- absent/malformed ETag on 200 and changed ETag on 304;
- non-HTTP `URLResponse`;
- response version zero, negative, fractional, or outside Swift `Int`;
- cancellation versus `URLError.cancelled`;
- redirects and whether authorization may follow to another origin;
- a maximum resolve-body size and SSE line/frame size, or an explicit decision to
  leave them unbounded;
- `Retry-After` syntax (the current service emits integer seconds), invalid values,
  and any maximum delay policy.

The ephemeral session should explicitly set `urlCache = nil`, cookie storage/policy,
and cache policy. Ephemeral configuration avoids disk persistence but does not by
itself document every in-memory behavior the spec claims to disable.

### F15 — The public surface has small inconsistencies

- `OSLogSink` is named as the default and as a planned type but is absent from the
  declared "entire public surface." Decide whether it is public or internal.
- `LeverPlatform: ExpressibleByStringLiteral` necessarily exposes a string-literal
  initializer, but no raw value or explicit initializer appears in the surface.
- Clarify whether `LeverUpdate.version` is only the version that produced changed
  serving values; metadata-only activation is intentionally silent under F3.
- "Stable between activations" cannot be enforced for a user-supplied mutable
  reference type that is merely `Sendable`; document that decoded config models
  should have value semantics if this guarantee is meant literally.

## 4. Test-plan omissions

The existing suite is a good base, but the following cases should be added to the
milestones where the relevant behavior first appears rather than deferred to M8.

### M1 / CI

- Add tiny consumer fixtures compiled with `MainActor` default isolation and with
  nonisolated default isolation. Building the SDK package itself does not prove the
  consumption promise.
- Compile an app-style `LeverKeys` extension and dynamic-member read in both fixtures.

### M2

- UTF-16 wire-limit boundaries and deterministic excess-attribute selection.
- Reserved-field limits and base-URL validation.
- Define an exact log-message catalog if tests will assert exact strings; the current
  spec gives only style examples.
- Consider deduplicating absent-key debug logs per key/representation just like
  mismatch warnings; otherwise hot SwiftUI reads can flood debug logs.

### M3

- First-run identity-only persistence.
- Stable identity across key rotation.
- Context isolation and base-URL normalization.
- Concurrent first initialization/writers.
- Metadata-only cache update and cache-write failure.

### M4

- First activation of version 0.
- Same values/new version and ETag.
- JSON memoization for the same wire key decoded as two Swift types.
- Reentrant log sink and observation callback, proving no mutex deadlock.
- Singleton concurrency and test isolation. Public-API tests that configure the
  process more than once need either subprocess exit tests or an internal testing
  reset; the production precondition should remain intact.

### M5

- Nudge-independent coalescing cancellation behavior.
- Full status/response/ETag matrix from F14.
- Atomicity: invalid 200 bodies must update none of staged state, ETag, version, or
  clocks.

### M6

- Zero/negative interval and repeated-failure scheduling.
- Separate wall and monotonic clock behavior.
- Initial foreground state and construction while already active.
- Runtime/client deallocation and task cancellation.

### M7

- Nudge arriving during an in-flight resolve, including the exact lost-update
  ordering in F4.
- Backgrounding during connect, watchdog sleep, backoff, and nudge-triggered fetch.
- Cancellation must not be logged/retried as a transport failure.
- Parser limits or explicit unbounded-input tests.

### M8 / M11

- Warm-cache behavior after client-key rotation.
- App Group behavior with the actual supported writer/reader topology.
- Treat iPhone-to-Watch transfer as a separate acceptance path if watch parity is a
  product requirement; a shared container cannot prove it.

## 5. Plan sequencing recommendations

1. Resolve F1–F8 in the spec before M1. F1 and F8 affect public configuration and
   the cache format, so they are expensive to retrofit after M3.
2. Move M9 before or alongside M5. The transport should be built against the
   authoritative HTTP fixtures instead of recorded local shapes that are reconciled
   only in M10.
3. Split the runtime milestone internally into fetch-operation/coalescing semantics
   and scheduling/lifecycle semantics. Coalescing, cancellation, and pending-nudge
   behavior form one state machine even if SSE parsing lands later.
4. Add a short spike before M1 or as M1 acceptance that compiles the proposed public
   surface, manual Observation implementation, `Synchronization.Mutex`, lifecycle
   imports, and `URLSession.bytes` across all five platform targets. This is especially
   valuable because strict-concurrency and isolation choices are the hardest API
   decisions to reverse.

## 6. Disposition checklist (resolved 2026-08-14)

Every finding was accepted and folded into [spec 0002](./spec.md) and
[plan 0002](./plan.md); the F13 wording conflict was also fixed in spec 0001 §7.
Two items were deliberately scoped rather than fully adopted:

- **Cache-only mode (F6):** initially deferred to spec §11 open questions.
  *Superseded by pass 2 (P2-F3):* the single-writer topology was not expressible
  without it, so v1 adopted `automaticUpdates = false` (spec §5, §7).
- **Exact log-message catalog (§4/M2):** rejected — tests assert level and dedupe
  identity, not exact strings, so no catalog is needed.

- [x] Stable environment/cache namespace and context identity — spec §7
  (`cacheNamespace`, canonical base URL, context deliberately excluded)
- [x] Installation/client identity across rotation and contexts — spec §7
  (`identity.json`, per-directory `clientId`)
- [x] App Group writer/reader model and watch-device scope — spec §7, §9
- [x] Cache-only or automatic-networking opt-out — deferred, then adopted in
  pass 2 as `automaticUpdates` (spec §5)
- [x] Zero, negative, and failed-fetch interval semantics — spec §3, §5.1
  (60 s timer floor, re-arm from attempt)
- [x] Wall-clock versus monotonic-clock seams — spec §5.1, §10
- [x] Metadata-only activation and version-0 semantics — spec §4
- [x] Pending nudge during in-flight fetch — spec §5.3
- [x] Synchronous client core versus runtime actor ownership — spec §4.1
- [x] Runtime/session lifetime and cancellation — spec §4.1
- [x] Full wire-limit mirroring and deterministic attribute dropping — spec §3
  (UTF-16 lengths, sorted-name selection, omission of overlong reserved fields)
- [x] Complete cache schema and ETag invariants — spec §6.1, §7
- [x] No-callout-under-lock discipline — spec §4.1
- [x] Type-aware JSON memoization — spec §2.3
- [x] Consumer compilation under both default-isolation modes — spec §1, plan M1
- [x] Transport edge-case and cancellation matrix — spec §5.1, §6.1

The plan's sequencing recommendations (§5) were adopted: the spec resolutions
above land before M1, M9 moves ahead of M5, the fetch-operation half of the nudge
state machine lands in M5, and M1 gained the platform/isolation spike.
