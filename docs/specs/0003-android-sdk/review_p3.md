# Review 0003, pass 3 — Android SDK implementation findings

- **Reviewed:** 2026-08-14
- **Implementation:** `../lever-android` at `b69dc91`
- **Inputs:** final [spec 0003](./spec.md), final [plan 0003](./plan.md), and
  the implemented Android SDK
- **Grade:** **B+ / 8.3 out of 10**
- **Purpose:** record implementation defects and missing acceptance coverage that
  should be resolved before releasing `0.1.0`

## 1. Overall assessment

The implementation follows the planned architecture closely and is unusually
complete for a first pass. The cache-first floor, representation-owned metadata,
strict commit turnstile, per-collector update channels, transport seam, virtual-time
runtime tests, contract-fixture replay, ABI validation, sample R8 build, and release
documentation are all present.

The full Gradle build passes, including 140 JVM tests with no failures or skips,
Android lint with warnings-as-errors, ABI validation, release AAR assembly, and the
minified sample build. The managed-device instrumented suite was not run as part of
this review.

The implementation should not release unchanged. Three P1 defects violate explicit
public guarantees: JSON memoization can cross-contaminate generic types, rejected SSE
connections leak their response bodies, and `close()` does not establish the promised
callback/resource boundary. Two smaller behavioral gaps remain in SSE backoff and
concurrent JSON decoding.

## 2. Release blockers

### P3-F1 — JSON memoization can serve a value decoded as the wrong generic type

`LeverKey.json` builds its memo identity from only
`serializer.descriptor.serialName`:

```kotlin
typeId = "json:" + serializer.descriptor.serialName
```

`LeverClient` then memoizes by `(wire name, typeId)`. A serializer's top-level
`serialName` is not a complete requested-type identity. In particular,
`List<String>` and `List<Int>` both use `kotlin.collections.ArrayList`; maps and
other generic serializers have the same problem, and two custom serializers may
also deliberately share a descriptor name.

The first read can therefore cache a `List<String>` and the second read reuse it as
`List<Int>`. JVM generic erasure allows the collection to escape `value()`; reading
an element later can throw `ClassCastException`. This violates both type isolation
and the promise that reads never throw.

**Locations:**

- `lever-android/lever/src/main/kotlin/dev/forcetower/lever/LeverKey.kt:101-110`
- `lever-android/lever/src/main/kotlin/dev/forcetower/lever/LeverClient.kt:130-180`

**Required resolution:** give every JSON key/decoder a collision-free memo token.
The safest implementation is identity tied to the `LeverKey` instance (or a private
decoder token created with it), because callers conventionally retain keys as
constants and the same key instance should memoize while unrelated keys must never
share a decoded object. If a structural type identifier is retained for logging, it
must include the complete descriptor graph rather than only `serialName`.

**Required tests:**

- Read one JSON wire name through `List<String>` and `List<Int>` keys whose
  top-level descriptor names are equal; each must decode independently.
- Repeat with two differently parameterized map keys.
- Add two explicit custom serializers sharing a descriptor name and prove they do
  not share memo entries.
- Re-read every key and prove each receives only its own memoized value.

### P3-F2 — Rejected SSE responses leak the live OkHttp response body

`OkHttpTransport.openStream` resumes with an open `Response` and exposes its body
only through a lazy `chunks` flow. The body and call are cleaned up by the flow's
`use`/`awaitClose` path only if that flow is collected.

`LeverRuntime.connectOnce` validates status and content type first, then returns
immediately for 401, 503, other statuses, and invalid/missing media types. None of
those branches collects `chunks`, so none closes the response body or cancels the
call. A repeated 503/backoff cycle can accumulate open response bodies, connections,
and calls. Closing the client's executor or evicting idle pooled connections is not
a substitute for closing an active response body.

**Locations:**

- `lever-android/lever/src/main/kotlin/dev/forcetower/lever/transport/OkHttpTransport.kt:70-103`
- `lever-android/lever/src/main/kotlin/dev/forcetower/lever/transport/OkHttpTransport.kt:112-141`
- `lever-android/lever/src/main/kotlin/dev/forcetower/lever/runtime/LeverRuntime.kt:385-415`
- `lever-android/lever/src/main/kotlin/dev/forcetower/lever/transport/LeverTransport.kt:41-49`

**Required resolution:** make stream ownership explicit. `HttpStream` should expose
an idempotent close/cancel operation, or itself implement a closeable abstraction.
`connectOnce` must close it in `finally` on every branch, including failures before
the parser starts. The accepted streaming path must also close it on EOF, parser
failure, watchdog expiry, backgrounding, and client teardown.

**Required tests:** use a transport/response double with a close counter and assert
exactly-once closure for:

- 401;
- 503 with `Retry-After`;
- another non-200 status;
- 200 with wrong or missing `Content-Type`;
- normal EOF;
- frame-too-large rejection;
- watchdog timeout;
- backgrounding; and
- client close.

At least one integration test should use a real local OkHttp server and prove that
several rejected reconnect rounds do not leave response bodies or calls open.

### P3-F3 — `close()` does not provide its specified callback and resource boundary

The implementation linearizes one successful closer against the commit gate, but
not every public `close()` call and not every sink source.

First, once one caller sets `state.closed`, a concurrent second caller returns
immediately. The first caller may still be waiting for an admitted commit. That
commit can begin persistence, logging, or delivery after the second `close()` has
returned, contradicting the contract that no sink invocation begins and no update
is newly enqueued after `close()` returns.

Second, reads deliberately remain valid after closure, but `logOnce` does not inspect
the closed state. A first post-close read of an absent or mismatched key can therefore
start a new sink callback after the boundary.

Third, cancellation is not synchronous resource release. The live lifecycle source
posts observer removal to the main thread, while `LeverRuntime.close()` returns
without waiting for that post. Runtime jobs and direct runtime sink calls are also
outside the commit gate; cancelling a coroutine scope does not interrupt synchronous
code that has already begun executing.

**Locations:**

- `lever-android/lever/src/main/kotlin/dev/forcetower/lever/LeverClient.kt:327-355`
- `lever-android/lever/src/main/kotlin/dev/forcetower/lever/LeverClient.kt:370-388`
- `lever-android/lever/src/main/kotlin/dev/forcetower/lever/LeverClient.kt:460-462`
- `lever-android/lever/src/main/kotlin/dev/forcetower/lever/runtime/LeverRuntime.kt:97-102`
- `lever-android/lever/src/main/kotlin/dev/forcetower/lever/runtime/LifecycleSource.kt:49-67`

**Required resolution:** model at least `open`, `closing`, and `closed` lifecycle
states. One caller performs teardown; concurrent/repeated callers that arrive during
`closing` join the same completion barrier rather than returning early. Suppress new
read-diagnostic logs once closing begins. All SDK sink callouts and resource teardown
that can race closure must either participate in the operation/callout gate or be
joined explicitly before the close barrier completes. Observer removal must be
complete, not merely queued, when `close()` returns.

**Required tests:**

- Pause an admitted commit before its gate phase, start the first closer, then call
  `close()` from a second thread. Prove neither closer returns until the commit's
  persist/log/deliver phase completes.
- Close a client before its first absent-key and mismatch reads, perform those reads,
  and prove the sink count does not change.
- Pause a runtime sink call immediately before invocation and prove `close()` waits
  or prevents it from beginning.
- On the live lifecycle source, prove observer count is restored before `close()`
  itself returns, without separately idling the main looper afterwards.
- Prove concurrent close still tears the transport and runtime thread down exactly
  once.

## 3. Remaining behavioral findings

### P3-F4 — SSE backoff resets after any bytes, not after a completed frame

`LeverRuntime.pump` sets `sawActivity = true` as soon as it receives a byte chunk and
returns that value to the retry state machine. Spec 0003 §6.2 requires the retry
counter to reset only after a round receives a **frame**. The idle watchdog correctly
resets on any bytes, including heartbeat bytes, but retry backoff has a different
boundary.

A broken peer can send one byte or an incomplete line and disconnect repeatedly;
the implementation then resets to the first retry delay forever instead of allowing
exponential backoff to grow.

**Locations:**

- `lever-android/lever/src/main/kotlin/dev/forcetower/lever/runtime/LeverRuntime.kt:353-381`
- `lever-android/lever/src/main/kotlin/dev/forcetower/lever/runtime/LeverRuntime.kt:418-472`

**Required resolution:** keep byte activity for the watchdog, but have the parser
report completed frame boundaries separately. A completed comment heartbeat frame
may count even though it produces no version event; an incomplete line may not.

**Required tests:** distinguish a complete version frame, a complete heartbeat
frame, arbitrary partial bytes followed by EOF, and an incomplete frame split across
disconnect. Only completed frames reset the retry counter.

### P3-F5 — Concurrent JSON reads do not satisfy decode-once memoization

`LeverClient.value` checks the memo under the state lock, releases it, decodes, then
reacquires the lock to store the result. Two threads reading the same JSON key and
representation can both miss and both run the serializer. The generation check
prevents installation into a newer representation, but it does not provide
decode-once behavior within one representation.

This is normally a performance defect, but custom serializers are arbitrary
consumer code and may make duplicate work observable.

**Location:**

- `lever-android/lever/src/main/kotlin/dev/forcetower/lever/LeverClient.kt:152-183`

**Required resolution:** coordinate in-flight decoding per memo token without
running the consumer serializer under the state lock. A small future/promise entry
or a separate decode gate can let one reader decode while others wait for its
result. An activation must invalidate or prevent publication of an older
generation's result, as the current generation check already does.

**Required tests:** use a blocking/counting serializer, launch many simultaneous
reads of the same key and representation, and prove the decoder runs exactly once
and every reader receives the same result. Repeat with activation racing the blocked
decode and prove the old result is not installed into the new generation.

## 4. Release-state correction

The implementation commit is described as M1–M9, but the repository does not yet
meet plan M9's release acceptance condition:

- `VERSION_NAME` is still `0.1.0-SNAPSHOT`;
- `lever/api/0.1.0.api` has not been frozen;
- there is no local `0.1.0` tag; and
- this review did not verify a published artifact resolving from Central.

This is not an implementation defect if release was intentionally held for review.
After P3-F1–P3-F5 are resolved, rerun the entire CI matrix, freeze the final ABI,
remove the snapshot suffix, tag, publish, and verify coordinates in a fresh consumer
as plan M9 requires.

## 5. Verification performed

The following command completed successfully against `b69dc91`:

```text
./gradlew build --stacktrace
```

Observed result:

- 140 JVM tests;
- 0 failures, 0 errors, 0 skipped;
- Android lint passed with warnings-as-errors;
- ABI check passed against `lever/api/current.api`;
- debug and release AARs assembled; and
- the sample's minified release/R8 build passed.

The Gradle-managed API-30 instrumented suite was not run locally during this review;
it remains part of the CI acceptance matrix.

## 6. Score

- **Architecture and API shape:** 9.3 / 10
- **Storage and three-layer floor:** 9.1 / 10
- **Build, ABI, documentation, and tooling:** 9.4 / 10
- **Typed-read correctness:** 7.8 / 10 until P3-F1 and P3-F5 are resolved
- **Concurrency and lifetime:** 7.6 / 10 until P3-F3 is resolved
- **Transport and SSE:** 7.7 / 10 until P3-F2 and P3-F4 are resolved
- **Test quality:** 9.0 / 10, with the missing adversarial cases above
- **Overall implementation:** **B+ / 8.3 out of 10**

The documents remain **A / approximately 9.6**. Resolving P3-F1–P3-F5 and completing
M9 should move the implementation into the **A / release-ready** range without an
architectural rewrite.
