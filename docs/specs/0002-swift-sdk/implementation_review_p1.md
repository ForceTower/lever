# Implementation review 0002, pass 1 — Swift SDK findings

- **Reviewed:** 2026-08-14
- **Implementation:** sibling repository `../lever-swift`, commit `15f2314`
- **Inputs:** [spec 0002](./spec.md), [plan 0002](./plan.md), and the completed
  Swift package and test suite
- **Purpose:** record implementation defects and missing coverage discovered after
  the first complete implementation. Findings are ordered by severity.

## 1. Overall assessment

The implementation is broadly strong and follows the finalized design closely. The
public model, validation, staged/activated representation split, request mapping,
cache identity/snapshot separation, synchronous typed reads, fetch coalescing,
lifecycle runtime, SSE reconnect behavior, contract fixtures, documentation, and CI
are all substantially implemented as specified.

The existing validation matrix is green, but the implementation is not yet complete.
Three significant correctness and robustness defects remain, followed by three
smaller contract gaps. The most important missing tests concern the interaction
between a nudge and a non-nudge fetch, adversarial live SSE input, and concurrent
activation persistence.

## 2. Significant findings

### I-P1-F1 — A retained nudge can lose its auto-activation policy

`LeverRuntime.handleNudge` records only `pendingNudge` when transport work is already
in flight. After that work finishes, `drainPendingNudge` discards the pending token if
it now equals `client.lastKnownVersion`. Only `startNudgeFetch` applies
`autoActivateOnNudge`.

This loses the nudge caller's independent activation policy in the following sequence:

1. An explicit `client.fetch()` is in flight. It is a staging-only caller.
2. SSE announces version 3, so the runtime records version 3 as pending.
3. The existing request returns and stages version 3.
4. The pending token now equals `lastKnownVersion`, so it is cleared without a
   follow-up request and without activation.

Reads continue serving the old activated representation even though
`autoActivateOnNudge` is `true`. This contradicts spec §5.1, which says coalescing
shares transport work while each caller independently applies its policy, and §5.3,
which says the nudge result is activated by default.

**Code:**

- `Sources/Lever/Runtime/LeverRuntime.swift:255` — `handleNudge(version:)`
- `Sources/Lever/Runtime/LeverRuntime.swift:268` — `drainPendingNudge()`
- `Sources/Lever/Runtime/LeverRuntime.swift:275` — `startNudgeFetch()`

**Required resolution:** retain activation interest separately from the announced
version. When a nudge joins existing transport work, it must await that shared work
and apply the nudge policy even when no follow-up fetch is required. The announced
token should still decide whether a follow-up request is necessary.

**Required test:** pause an explicit `fetch()`, emit a nudge matching the response
version, resume it, and assert one request, automatic activation, and updated reads.
The existing `pendingNudgeAlreadyCovered` test does not cover this because its
original in-flight request was itself started by a nudge and therefore already has an
activation waiter.

### I-P1-F2 — The 1 MiB SSE bound does not bound live memory use

The live URLSession transport buffers bytes until LF before yielding a chunk to the
parser. A broken or malicious peer can send an arbitrarily long unterminated line;
the transport's local buffer grows without limit and the parser never gets a chance
to enforce `maxFrameBytes`.

The parser also checks only the remaining incomplete byte buffer and accumulated
`data:` text after processing an entire chunk. A terminated oversized `event:`,
comment, `retry:`, or unknown-field line can be converted to `String`, assigned or
discarded, and removed before the size check. Multiple lines in one large chunk can
similarly cause substantial allocation before the final guard runs.

This violates spec §6.2's explicit requirement that a broken peer error and reconnect
rather than buffer without limit.

**Code:**

- `Sources/Lever/Transport/URLSessionTransport.swift:56` — line-boundary chunking
- `Sources/Lever/Transport/ServerSentEvents.swift:31` — parser consumption and its
  post-processing bound

**Required resolution:** yield bounded transport chunks independent of newlines and
track total bytes for the current SSE frame while parsing. Reject the frame before
constructing or retaining an oversized field. All field kinds, comments, and
unterminated lines must count toward the same frame bound.

**Required tests:** oversized terminated `event:`, comment, and unknown-field lines;
several individually small fields whose combined frame exceeds 1 MiB; arbitrary
chunk boundaries; and a live-transport-style unterminated line delivered in many
bounded chunks.

### I-P1-F3 — Concurrent commits can regress the persisted cache

`activate()` correctly swaps state under the client mutex and performs filesystem I/O
outside it. However, cache writes have no independent ordering. The following legal
interleaving can occur because `LeverClient` is `Sendable` and `activate()` is
synchronous:

1. Caller A commits staged version 2 and releases the state mutex.
2. Version 3 is fetched and caller B commits it.
3. B saves version 3 to disk.
4. A's delayed `cache.save` writes version 2 over it.

Memory serves version 3, but the next process launch restores version 2. A delayed
`confirmFreshness` persistence can likewise overwrite a newer activation snapshot.
Thread Sanitizer cannot detect this because it is a logical ordering bug, not an
unsynchronized memory access.

**Code:**

- `Sources/Lever/LeverClient.swift:205` — activation commit followed by an unordered
  cache write at line 245
- `Sources/Lever/LeverClient.swift:303` — 304 freshness commit followed by an
  unordered cache write at line 324

**Required resolution:** serialize snapshot persistence in commit order, or attach a
monotonic commit generation and discard obsolete writes. Filesystem operations and
error logging must remain outside the state mutex to preserve the no-callout rule.

**Required tests:** deterministically pause the version-2 write, commit and persist
version 3, release version 2, then assert that the file still contains version 3.
Repeat the ordering test with an activated-representation 304 persistence racing a
new activation.

## 3. Additional findings

### I-P1-F4 — Singleton configuration is not atomically reserved

`Lever.configure` checks whether `installed` is nil, releases the mutex, constructs a
client, and later locks again to assign it. Two concurrent callers can both pass the
precondition, construct two active runtimes, and install one after the other. The
documented configure-once trap is therefore not guaranteed.

**Code:** `Sources/Lever/Lever.swift:13`

**Required resolution:** atomically transition singleton state from `empty` to
`configuring` before client construction, then to `installed`. Do not hold the mutex
during `LeverClient` initialization because initialization performs filesystem I/O
and can log through a host-provided sink.

**Required test:** race multiple configuration attempts behind a barrier and assert
that exactly one can reserve installation while every other attempt follows the
documented misuse path. This may require testing the reservation primitive directly
rather than intentionally trapping the test process.

### I-P1-F5 — Scheduler arithmetic can trap on accepted inputs

`CacheStore.loadSnapshot` validates the cached version but accepts arbitrary integer
timestamps. A structurally valid file containing `fetchedAt: Int.min` reaches
`LeverRuntime.isDue`, where `now - fetchedAt` overflows and traps instead of treating
the cache as unusable. `armTimer` also computes `anchor + interval - now` with
unchecked `Int` arithmetic; an extremely large, currently accepted
`minimumFetchInterval` can overflow it.

This violates the corrupt-cache failure floor: cache contents must never turn into a
process crash.

**Code:**

- `Sources/Lever/Storage/CacheStore.swift:90` — snapshot validation
- `Sources/Lever/Runtime/LeverRuntime.swift:210` — eligibility arithmetic
- `Sources/Lever/Runtime/LeverRuntime.swift:224` — deadline arithmetic

**Required resolution:** validate persisted timestamps and use checked or saturating
arithmetic for elapsed time and timer deadlines. Define how intervals too large to
schedule are clamped or rejected.

**Required tests:** cached `Int.min`/`Int.max` timestamps, timestamps on both sides of
`now`, and an extreme positive `Duration`.

### I-P1-F6 — A cached client ID is not validated as a lowercase UUID

`readIdentity` accepts any nonempty string no longer than 64 UTF-16 code units. A
valid JSON identity such as `{"schemaVersion":1,"clientId":"x"}` is therefore
treated as usable even though spec §7 defines the persisted identity as a lowercase
UUID and says corrupt identities regenerate.

**Code:** `Sources/Lever/Storage/CacheStore.swift:61`

**Required resolution:** require successful UUID parsing and canonical lowercase UUID
serialization before accepting a stored identity. Preserve the existing exclusive
creation race behavior when regeneration is necessary.

**Required test:** syntactically valid identity files containing a short non-UUID and
an uppercase UUID both regenerate with a warning.

## 4. Verification performed

The following checks passed against `../lever-swift` without modifying its worktree:

- `swift test`: 140 tests across 21 suites;
- `swift test --sanitize=thread`;
- `swift build -c release`;
- both consumer fixtures under `Fixtures/ConsumerFixtures`, covering main-actor
  default and nonisolated consumers;
- an iOS Simulator build using iPhone 16 / iOS 18.5; and
- a watchOS Simulator build using Apple Watch Series 10 / watchOS 11.5.

Concrete tvOS and visionOS simulator runtimes were not installed locally, so those
two platform builds remain CI-only validation. The Swift implementation repository
was clean before and after the review.

## 5. Recommended completion order

1. Fix nudge activation ownership and add the missing coalescing-policy test.
2. Make SSE transport chunking and parser accounting genuinely bounded.
3. Serialize or generation-guard cache persistence.
4. Make singleton installation atomic.
5. Harden timestamp and duration arithmetic.
6. Tighten persisted identity validation.
7. Re-run the full test, Thread Sanitizer, fixture, release, and platform matrix.
