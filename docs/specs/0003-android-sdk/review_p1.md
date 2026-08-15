# Review 0003, pass 1 — Android SDK implementation-readiness findings

- **Reviewed:** 2026-08-14
- **Inputs:** [spec 0003](./spec.md), [plan 0003](./plan.md), the normative
  [spec 0002](../0002-swift-sdk/spec.md), and its implementation notes
- **Purpose:** identify contract and milestone gaps that should be resolved before
  `lever-android` enters M1

## 1. Overall assessment

The direction is strong. The model → storage → client core → transport → runtime →
SSE sequence gives each layer a narrow dependency cone, the cache-first three-layer
floor is structural, and the plan uses the existing service-generated HTTP fixtures
at the right point. Representation-owned metadata, metadata-only commits, nudge
identity semantics, deterministic seams, and the flagship migration as acceptance
are all unusually well specified.

The design is close to implementation-ready, but it should not enter M1 unchanged.
The largest issues are:

- several lessons already settled during Swift implementation are cited but are not
  correctly carried into the Android spec or milestone acceptance tests;
- the `MutableSharedFlow` design cannot provide its stated no-block/no-drop
  guarantee;
- behavior after `close()` is not a complete public contract; and
- the flagship audit can invalidate foundational Android choices but currently does
  not gate them.

The findings below preserve the architecture. They tighten places where the current
text would otherwise leave an implementation choice capable of breaking a promised
invariant.

## 2. Blockers

### P1-F1 — The Android plan does not fully inherit the Swift implementation findings

Spec 0003 makes spec 0002 normative and says the Swift review findings are inherited,
but plan M2–M7 do not name or test several contract-level corrections recorded in
spec 0002 §12–§12.1. One is contradicted directly: spec 0003 §7 and plan M3 require a
`File.createNewFile()`-style exclusive create for `identity.json`, while spec 0002
§12 explains why publishing an empty filename before its contents can split the
in-memory identity of racing clients.

**Required resolution:**

- Publish a completed identity by writing a temporary file and atomically hard-
  linking it into place, or use an Android primitive with the same property: once
  the destination name exists, its complete bytes are readable. A loser discards
  its temporary file and reads the winner.
- Allocate a snapshot commit sequence under the state lock, serialize writes, and
  discard stale writes so concurrent activation/304 persistence cannot regress the
  on-disk snapshot.
- Reserve singleton installation atomically (`empty → reserved → installed`), with
  construction outside the lock and a defined rollback if construction fails.
- Treat the notification source's initial phase as the one initialization trigger.
  Do not separately schedule an init fetch and a first lifecycle-phase fetch.
- Make an auto-activating nudge join whatever in-flight transport work answers it
  and apply its own activation policy when that work completes, even if the original
  caller requested staging only.
- Enforce the 1 MiB SSE frame budget before appending/decoding, across every field
  and comment, and ensure the OkHttp reader also yields size-bounded chunks when a
  peer never sends a newline.
- Saturate persisted-time arithmetic, reject negative cached timestamps, clamp the
  interval to 365 days, and define handling for `Duration.INFINITE`.
- Validate `clientId` as a UUID; rewrite non-canonical casing without changing the
  identity, and regenerate only unparseable values.

**Plan amendments:** add explicit acceptance tests for each item in its owning
milestone rather than relying only on the transitive citation to spec 0002.

### P1-F2 — A finite `MutableSharedFlow` cannot guarantee synchronous, lossless emission

Spec §4 promises a `MutableSharedFlow(replay = 0)` with a buffer large enough that
emission from synchronous `activate()` never blocks or drops. No finite SharedFlow
buffer can establish that invariant:

- `emit` may suspend when a subscriber is slow;
- `tryEmit` eventually returns `false` with the default overflow policy; and
- a drop overflow policy violates the no-drop promise by definition.

Updates being rare makes overflow unlikely, not impossible. That is weaker than the
unbounded-per-subscriber contract inherited from Swift.

**Required resolution:** keep `Flow<LeverUpdate>` as the public type, but use an
explicitly unbounded fan-out implementation, such as one unlimited channel per
registered collector. Registration/unregistration must be race-safe; activation
captures the subscribers under the state lock and performs non-blocking sends only
after releasing it.

**Required tests:**

- a deliberately stalled collector receives a burst larger than any former nominal
  buffer without loss;
- multiple collectors independently receive every post-subscription update;
- synchronous `activate()` never blocks on a collector; and
- closing the client terminates or otherwise resolves collectors according to the
  shutdown contract in P1-F3.

### P1-F3 — `close()` does not define a complete public lifecycle

The spec defines which runtime work is cancelled, but not what happens when public
methods are called after closure or what happens to active `updates` collectors.
This is observable API behavior. It is also unclear whether the dedicated dispatcher
owns a thread that must be closed in addition to cancelling its scope.

There is a second inconsistency: `close()` is public on every `LeverClient`, including
`Lever.shared`, while §4 says the shared singleton is process-lived and never closed.
The API cannot currently enforce that statement.

**Required resolution:** define at least:

- whether `close()` is idempotent;
- whether reads continue serving the last activated snapshot;
- the post-close behavior of `fetch()`, `fetchAndActivate()`, and `activate()`;
- whether current and future `updates` collectors complete;
- whether closing `Lever.shared` is supported and, if so, whether it can ever be
  reconfigured; and
- closure of the dispatcher/executor and OkHttp resources, not only cancellation of
  their jobs.

**Required tests:** cover repeated/concurrent close, close racing with fetch and
activation, every public operation after close, collector termination, and the
absence of sink/update callbacks after the close boundary.

### P1-F4 — The flagship audit is sequenced too late to protect foundational choices

M10 audits the flagship's actual min SDK and process topology, but it gates only M11.
Either finding can invalidate choices made in M1: a flagship below API 26 cannot
consume the library as specified, and an unexpected secondary process changes the
lifecycle and cache-writer assumptions.

**Required resolution:** make the audit M0, or leave it parallel but require its
platform-floor and process-topology findings before M1 merges. Key inventory and
migration-seam details may continue later, but facts capable of invalidating the SDK
shape must be known before the shape becomes implementation.

### P1-F5 — “Byte-format identical” cache files lack a canonical byte encoding

Spec §7 and plan M3 require a byte-identical cache format shared with Swift, but the
cache contract defines a JSON schema rather than canonical serialization rules.
Swift and kotlinx serialization are not guaranteed to emit the same member order,
escaping, whitespace, or number spelling.

**Required resolution:** choose one of two precise promises:

1. If exact bytes are required, define a canonical JSON encoding for both cache
   files and test emitted bytes against it.
2. If interoperability is the real requirement, say **schema- and value-identical**,
   then require Android to decode Swift-produced fixtures and Swift to decode
   Android-produced fixtures. Compare decoded structure rather than incidental
   serializer output.

The second promise is sufficient for “one cache format, not one per SDK” unless a
real cross-platform use case requires byte equality.

## 3. Public API and validation corrections

### P1-F6 — Singleton exception objects are unsafe `Throwable` instances

`LeverException.InvalidKey` and `InvalidResponse` are declared as Kotlin `object`s.
A `Throwable` carries mutable stack-trace and suppressed-exception state; rethrowing
one process-global instance produces stale diagnostics and shared mutable exception
state across concurrent requests.

**Recommended resolution:** make them classes instantiated per failure, for example
`class InvalidKey : LeverException()` and `class InvalidResponse : LeverException()`.

### P1-F7 — Configuration must take an immutable snapshot of caller-owned values

`LeverContext.attributes` is typed as a read-only `Map`, but it may be backed by a
caller-owned mutable map. Mutation after validation could change request context
without revalidation and break the fixed-context/ETag assumptions.

**Recommended resolution:** defensively copy attributes during configuration/client
construction and operate only on the validated internal snapshot. Apply the same
principle to any other caller-owned mutable input. Require explicit `LeverClient`
instances, not only `Lever.configure`, to retain `context.applicationContext` rather
than an Activity.

### P1-F8 — The base-URL throwing boundary is ambiguous

The API says `baseUrl` is HTTP(S) and that a string which does not parse as an HTTP(S)
URL throws. The inherited validation text separately treats a non-HTTP(S) scheme as a
logged validation issue. Behavior is also unstated for a missing host, userinfo,
relative URLs, fragments, and base paths.

**Recommended resolution:** make every URL that cannot serve as an absolute HTTP(S)
origin a constructor error. Explicitly decide whether userinfo is rejected or
stripped, retain the already-promised query/fragment warning-and-strip behavior, and
pin base-path joining with byte-exact tests.

### P1-F9 — `Long` needs a service-level precision contract

The new `long` factory is tested at Kotlin `Long` range boundaries, but wire numbers
originate in a JavaScript service. Values outside JavaScript's exactly representable
integer range can be rounded before Android receives them even when they fit in a
`Long`.

**Recommended resolution:** state whether integer keys accept only safe/exact service
integers or merely any integral JSON lexeme in the Kotlin type's range. Add boundary
tests around `2^53 - 1`, `2^53`, and `2^53 + 1`, in addition to `Int`/`Long` limits.
If the product needs every `Long`, the wire representation must change; the Android
decoder alone cannot provide that guarantee.

### P1-F10 — Small public-surface ergonomics should be settled before the M1 skeleton

These are not architectural, but the platform spike is specifically intended to
freeze the surface early:

- Prefer `data class LeverUpdate` unless reference identity is deliberate; normal
  equality, hashing, destructuring, and diagnostics are useful for an event value.
- Correct the explicit-serializer wording: a `KSerializer<T>` supports generics and
  custom serializers, but does not by itself install an arbitrary
  `SerializersModule` into the SDK's `Json` instance.
- Document the thread/coroutine context from which `LeverLogSink` may be called; host
  sinks must know whether they need to be thread-safe.

## 4. M1 tooling and publishing corrections

### P1-F11 — Define the Central dry run precisely and do not publish throwaway releases

M1 says a `0.0.x` dry-run artifact resolves from “Central staging.” Central's Portal
supports resolving a **validated but unpublished** deployment through an
authenticated manual-testing Maven repository, after which the deployment can be
dropped. That is distinct from normal `mavenCentral()` resolution. A published
release is immutable and should not be used as throwaway scaffolding.

**Recommended resolution:** specify this M1 flow:

1. build, sign, and upload a user-managed deployment;
2. wait for `VALIDATED`;
3. resolve it by coordinates in the consumer fixture through Central's authenticated
   manual-testing repository;
4. drop the deployment; and
5. reserve real publication through ordinary Central coordinates for M9.

The official references are Central's
[Publisher API manual-testing flow](https://central.sonatype.org/publish/publish-portal-api/)
and its [Gradle publishing guidance](https://central.sonatype.org/publish/publish-portal-gradle/).
The latter currently lists community plugins rather than an official Gradle Portal
plugin, so M1 should choose and pin the exact publishing path rather than leave it
implicit.

### P1-F12 — The ABI baseline timing contradicts the complete M1 surface skeleton

M1 asks for the entire public surface with ABI validation and an empty baseline, then
M9 commits the baseline. If the skeleton really exposes the planned API, an empty
baseline cannot meaningfully gate it for eight milestones.

**Recommended resolution:** generate and commit the skeleton's ABI dump in M1, run
the ABI check in CI immediately, and update it intentionally as the 0.x API evolves.
M9 should review/finalize the baseline rather than create it for the first time.

Kotlin now includes
[ABI validation in the Kotlin Gradle plugin](https://kotlinlang.org/docs/gradle-binary-compatibility-validation.html),
so M1 should evaluate that built-in facility before adding the separate kotlinx
binary-compatibility validator. Whichever mechanism is selected, pin exact Kotlin,
AGP, dependency, and publishing-plugin versions; “2.x” and “current stable” are
design constraints, not reproducible build inputs.

## 5. Required acceptance-test additions by milestone

### M1

- Consumer fixture compiles the real declared API and ABI check passes against a
  committed dump.
- Central deployment validates, resolves through the authenticated manual-testing
  repository, and is dropped without publishing an immutable release.
- Lifecycle subscription installs and reads the initial state atomically on the main
  thread.
- The runtime dispatcher/executor can be closed without leaking its thread.

### M2

- Interval tests include values over 365 days, `Duration.INFINITE`, and arithmetic
  boundary inputs.
- Base-URL tests cover non-HTTP schemes, missing hosts, relative input, userinfo,
  fragments, and path joining.
- `Long` tests cover the JavaScript safe-integer boundary.
- Caller mutation of the original attributes map cannot change validated context.

### M3

- Identity publication never exposes an empty/partial winner and racing initializers
  converge on one complete UUID.
- Uppercase UUIDs are canonicalized without changing identity; invalid UUIDs are
  regenerated.
- Cache timestamp fields reject negative values and tolerate extreme values without
  overflow.
- Cross-SDK fixtures prove the chosen canonical-byte or schema-interoperability
  promise.
- At least one instrumented test exercises the chosen link/atomic-replace primitives
  in `noBackupFilesDir`, not only on the host JVM filesystem.

### M4

- Concurrent activation/304 persistence cannot write an older commit after a newer
  one.
- Concurrent singleton configuration produces one installed client and no orphaned
  runtime; failed construction releases the reservation according to the chosen
  rule.
- A stalled update collector cannot cause blocking or loss.
- The full post-`close()` public contract is tested.

### M6

- Initial lifecycle delivery causes exactly one automatic eligibility check/request,
  including first-run failure; there is no separate duplicate init trigger.
- Dispatcher/executor closure, lifecycle observer removal, and callback suppression
  are all asserted.

### M7

- An auto-activating nudge that joins a staging-only fetch activates the fetched
  representation when the shared transport completes.
- A stream with more than 1 MiB and no newline is bounded below the parser.
- A round that received a frame still backs off before reconnecting, with its retry
  counter reset.

## 6. Disposition checklist (resolved 2026-08-14)

All twelve findings were accepted and folded into [spec 0003](./spec.md) and
[plan 0003](./plan.md). The root cause of P1-F1 was a citation window: spec 0003
was written against spec 0002 as of its design-review passes and predated
§12–§12.1; the citation now names them as inherited contract, and each item has
a named acceptance test in its owning milestone.

- [x] P1-F1 — fully inherit and test the Swift implementation findings —
  spec §scope, §2.1, §3, §4, §5, §6.2, §7; named tests in plan M2–M7 (the
  exclusive-create contradiction is replaced by §12's hard-link publication)
- [x] P1-F2 — replace the finite-SharedFlow guarantee — spec §4: unlimited
  channel per collector, the direct port of spec 0002 §4.1's per-consumer
  streams; stalled-collector tests in plan M4
- [x] P1-F3 — define the complete post-`close()` contract — spec §4 (idempotent,
  reads survive, control ops fail loud, collectors complete, resources
  released, closing the installed `Lever.shared` throws); tests in plan M4/M6
- [x] P1-F4 — make foundational flagship-audit findings gate M1 — plan M10 split
  into a foundational tier (platform floor, process topology) that gates M1's
  merge and a parallel migration tier
- [x] P1-F5 — schema- and value-identical cache interoperability chosen over
  canonical bytes — spec §7 (decode Swift fixtures unmodified +
  emit-then-decode round-trip; bytes explicitly not compared); plan M3
- [x] P1-F6 — singleton exception objects replaced with per-failure classes —
  spec §2
- [x] P1-F7 — attributes snapshotted at construction; every client retains only
  `applicationContext` — spec §2.1, §3; mutation test in plan M2
- [x] P1-F8 — throwing boundary settled as "not an absolute http(s) origin",
  userinfo rejected, query/fragment stripped, path joining byte-exact —
  spec §3; matrix in plan M2
- [x] P1-F9 — integer exactness bounded by the JavaScript safe range (2⁵³ − 1),
  documented in the API and README — spec §2.2; boundary tests in plan M2
- [x] P1-F10 — `data class LeverUpdate`, corrected serializer wording (no
  `SerializersModule` installation), sink threading contract — spec §2, §2.2,
  §8
- [x] P1-F11 — M1 uses the Portal's validate → resolve-via-manual-testing-repo →
  drop flow; the first immutable publication is M9's 0.1.0 — plan M1, M9
- [x] P1-F12 — ABI dump committed and enforced from M1 (KGP built-in vs kotlinx
  validator evaluated and pinned), exact toolchain versions pinned in the
  version catalog — spec §1, plan M1, M9

The plan's architecture is ready to implement once M10's foundational tier
reports in.
