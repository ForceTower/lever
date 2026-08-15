# Review 0003, pass 2 — remaining implementation-readiness findings

- **Reviewed:** 2026-08-14
- **Inputs:** revised [spec 0003](./spec.md), revised [plan 0003](./plan.md),
  [review pass 1](./review_p1.md), and the normative
  [spec 0002](../0002-swift-sdk/spec.md)
- **Grade:** **A− / 9.0 out of 10**
- **Purpose:** verify the pass-one disposition and record only the issues that
  remain before implementation

## 1. Overall assessment

The revision substantively resolves all twelve pass-one findings. The changes are
not checklist-only: the spec now defines the corrected behavior and the plan assigns
named acceptance tests to the milestones that own it.

Particularly strong revisions include:

- explicit inheritance of spec 0002 §12–§12.1 rather than an ambiguous citation;
- replacement of the impossible finite-`SharedFlow` promise with per-collector
  unbounded delivery;
- a complete public `close()` contract;
- hard-link identity publication and an instrumented real-filesystem test;
- commit sequencing, singleton reservation, the unified lifecycle/init trigger,
  nudge join semantics, and lower-layer SSE bounds as named tests;
- foundational flagship facts gating M1;
- a validated-and-dropped Central deployment instead of a throwaway immutable
  release;
- ABI enforcement from the first public skeleton; and
- schema/value cache interoperability instead of unspecified byte identity.

The architecture, behavioral coverage, and milestone sequencing are now strong. Two
contract contradictions and one concurrency-detail gap remain. They are much smaller
than the pass-one findings, but the first two should be settled before M1 because
they determine externally observable guarantees.

## 2. Remaining blockers

### P2-F1 — Synchronous activation does not have an explicit durability boundary

Spec §4 says activation persists outside the state lock, and now says snapshot
writes are “serialized on the runtime.” `activate()` is synchronous, while the
runtime is coroutine-owned. The text therefore permits an implementation that
enqueues persistence and returns before the write finishes.

That weakens the floor. If the process dies after `activate()` returns but before an
asynchronous write runs, the next launch restores the previous representation even
though the application observed a completed activation. It also creates an awkward
implementation trap: synchronously dispatching to the runtime thread can deadlock
when activation already originates on that thread, such as nudge auto-activation.

**Required resolution:**

- State explicitly that `activate()` does not return until its snapshot write has
  either completed or failed and been logged.
- Serialize persistence through a dedicated persistence gate outside the state
  lock, not by synchronously hopping to the runtime dispatcher.
- Allocate the commit sequence under the state lock as already specified.
- Under the persistence gate, skip a write whose sequence is older than the latest
  completed write; otherwise perform the atomic write and record the completed
  sequence.
- Apply the same ordering mechanism to activated-representation freshness writes
  produced by a 304. Those already run asynchronously from the public caller, but
  they must not overtake or be overtaken incorrectly by activation writes.

This retains the no-callout-under-state-lock rule while making a successful
synchronous activation a real durability boundary.

**Required tests:**

- Immediately reconstructing a client after `activate()` returns observes the new
  snapshot without advancing a test dispatcher.
- A process-death simulation at the return boundary restores the committed snapshot.
- Activation invoked from the runtime dispatcher does not deadlock.
- Two concurrent activations whose persistence-gate acquisition order differs from
  their commit order leave the newest commit on disk.
- An activated-state 304 freshness write racing an activation cannot regress either
  values or freshness metadata.

**Plan amendment:** keep the core activation durability tests in M4; keep the 304
race case in M5, where 304 transport behavior exists.

### P2-F2 — The Android safe-integer rule conflicts with the shared read contract

Spec §2.2 says `Long` is bounded by JavaScript’s safe-integer range
(`|n| ≤ 2^53 − 1`), but §2.3 says read behavior is unchanged from spec 0002: an
integer key accepts an exactly representable integer in the platform type’s range.
Those are not the same rule. For example, `2^53` is exactly representable and fits in
both Swift `Int` and Kotlin `Long`, but is outside the stated safe range.

Plan M2 names boundary inputs at `2^53 − 1`, `2^53`, and `2^53 + 1` without stating
their expected outcomes. More importantly, an Android-only mismatch rule would
violate the project’s stated “one behavioral contract” goal. A hand-written JSON
lexeme at `2^53 + 1` also does not model what the JavaScript service can faithfully
emit: the value may already have been rounded before serialization.

**Required resolution:** choose one cross-SDK rule and record it in the shared
contract:

1. **Recommended:** retain spec 0002’s decoder rule. SDKs accept any integral wire
   value that is exactly representable in the requested platform type. The README
   separately warns authors that the JavaScript service cannot preserve arbitrary
   integers outside its safe range. Boundary tests assert the actual wire behavior
   rather than introducing an Android-only mismatch.
2. Alternatively, make the safe range normative for integer reads in **every** SDK.
   Amend spec 0002, update Swift, and preferably validate the corresponding values on
   the service/admin side so the server cannot publish inputs native SDKs must reject.

The documentation warning may be Android-specific; the read-resolution rule may not.

**Required tests:** state the expected result for every safe-boundary case. If the
recommended resolution is selected, distinguish:

- exact wire lexeme `2^53 − 1`;
- exact wire lexeme `2^53`;
- a response actually generated by the JavaScript service after attempting to
  publish `2^53 + 1`; and
- Kotlin `Long` range and fractional-value failures.

### P2-F3 — Unlimited-channel delivery needs precise close-race semantics

Spec §4 says activation captures registered unlimited channels under the lock and
sends outside it, and that unlimited capacity makes the send “infallible.” Capacity
removes backpressure, but a channel captured by activation can be closed concurrently
by `close()` before the outside-lock send occurs. A send is therefore not literally
infallible.

The same race affects the stronger lifetime promise that no sink or channel callback
fires after `close()` returns. A simple “check closed, release lock, call out” sequence
cannot enforce that boundary because close may return between the check and callout.

**Required resolution:**

- Name non-suspending `trySend` as the activation primitive. While a registered
  channel remains open, unlimited capacity guarantees success without blocking.
  Failure caused solely by concurrent close is intentionally ignored.
- Define one operation/callout gate spanning the part of activation that must finish
  before close may return: persistence, logging, and update delivery. It must remain
  separate from the state lock so host code is never called under that lock.
- `close()` marks the client closed so no new operation enters the gate, waits for
  already-admitted operations to leave, then closes collector channels and releases
  runtime/transport resources. Once it returns, no SDK-initiated sink or update
  callback can begin.
- Avoid promising that a racing activation both loses every callback and persists
  its state. Define the linearization rule: an activation admitted before close
  completes its durability/callout phase before close returns; one not admitted
  returns `false` and changes nothing.

An equivalent mechanism is acceptable, but the spec must name the observable
ordering rather than leave “race-safe” open to interpretation.

**Required tests:** use barriers rather than probabilistic stress:

- pause activation after its state-lock phase but before persistence/delivery, call
  `close()` concurrently, and prove close waits for the admitted activation;
- pause close after it marks the client closed and prove a later activation returns
  `false` without persistence, logging, or delivery;
- close a collector channel between capture and `trySend` and prove activation does
  not block or throw; and
- prove no sink invocation or channel delivery begins after `close()` returns.

## 3. Smaller plan correction

M4 currently assigns tests involving a fetch race and a 304 freshness write even
though it describes `LeverClient` “minus networking.” Direct injection can exercise
the core mechanics, but the milestone text should separate that from transport-level
acceptance:

- M4 owns the persistence gate, activation ordering, update fan-out, singleton, and
  close/core-operation tests.
- M5 owns the activated-state 304 persistence race and close racing a real coalesced
  fetch.
- M6 owns lifecycle, dispatcher, and runtime-resource shutdown.

This is a sequencing clarification, not an architectural change.

## 4. Grade

- **Architecture:** A
- **Behavioral coverage:** A
- **Milestone sequencing:** A, with the small M4/M5 ownership correction above
- **Public API precision:** A−
- **Concurrency and lifetime precision:** B+ until P2-F1 and P2-F3 are resolved
- **Overall:** **A− / 9.0 out of 10**

Resolving P2-F1–P2-F3 would move the documents to **A / implementation-ready**,
conditional only on M10’s already-specified foundational audit.

## 5. Disposition checklist (resolved 2026-08-14)

All three blockers and the sequencing correction were accepted and folded into
[spec 0003](./spec.md) and [plan 0003](./plan.md):

- [x] P2-F1 — spec §4 defines the **commit gate** (a second lock, never held
  with the state lock, spanning persist/log/deliver): sequence allocated under
  the state lock, stale writes skipped under the gate, `activate()` returns
  only after its write completed or failed-and-logged, and persistence is
  explicitly never a runtime-dispatcher hop (the nudge auto-activation
  deadlock). Durability tests in plan M4; the 304 race in M5.
- [x] P2-F2 — resolution 1 adopted: the shared decoder rule stands unchanged
  (any integral wire value exactly representable in the requested type — no
  Android-only mismatch); the 2⁵³ − 1 bound is authoring guidance in the
  README. Spec §2.2; plan M2 states the boundary outcomes (all three lexemes
  decode exactly into `Long`).
- [x] P2-F3 — spec §4 names `trySend` (sole failure: a concurrently closed
  channel, deliberately ignored) and the close linearization: mark closed →
  no new gate admission → wait for admitted operations' persist/log/deliver →
  close channels → release resources; an activation admitted before the mark
  completes before `close()` returns, one after it returns `false` with no
  effects. Barrier-based tests in plan M4.
- [x] M4/M5 ownership corrected — M4 owns the gate, ordering, fan-out,
  singleton, and close/core tests with injected representations; M5 owns the
  activated-304 persistence race and close racing a real coalesced fetch; M6
  keeps lifecycle/dispatcher/resource shutdown.

