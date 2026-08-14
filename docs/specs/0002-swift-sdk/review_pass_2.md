# Review 0002, pass 2 — remaining implementation-readiness findings

- **Reviewed:** 2026-08-14
- **Inputs:** the revised [spec 0002](./spec.md), [plan 0002](./plan.md),
  [review pass 1](./review.md), and the corresponding terminology update in
  [spec 0001](../0001-service/spec.md)
- **Purpose:** record the issues remaining after the first review was incorporated.
  This pass should be read as a delta, not a repeat of pass 1.

## 1. Overall assessment

The revision is a major improvement. Most first-pass findings now have concrete
semantics, milestone ownership, and acceptance tests. Particularly strong additions
include:

- the M1 platform/isolation spike and consumer compilation fixtures;
- representation-commit versus observable-value-change semantics;
- pending-nudge handling during an in-flight fetch;
- explicit cancellation and runtime teardown behavior;
- complete wire-limit validation using UTF-16 lengths;
- type-aware JSON memoization and the no-callout-under-lock rule;
- initial lifecycle-state reporting;
- moving authoritative HTTP fixtures ahead of transport implementation; and
- aligning spec 0001's nudge terminology with `lastKnownVersion`.

The design is now close to implementation-ready. Three state/storage behaviors should
still be settled before implementation, followed by several smaller corrections.

## 2. Remaining blockers

### P2-F1 — Intervals from 1–59 seconds disable degraded polling

Spec §5.1 says the rearming timer only exists when
`minimumFetchInterval >= 60 seconds`. Every smaller value, including positive values,
fetches only on lifecycle edges. This prevents a hot loop for `.zero`, but it also
means that a client configured with a 30-second interval never performs degraded
polling during a long foreground session when SSE is down.

That contradicts the adjacent invariant that the in-session timer is the degraded
polling mode. Calling 60 seconds a "floor" also suggests clamping, not disabling.

**Recommended resolution:**

- `.zero` means lifecycle-triggered automatic fetching only, with no timer;
- `0 < interval < 60 seconds` arms the timer at 60 seconds, preferably with a
  configuration warning that the value was clamped; and
- `interval >= 60 seconds` uses the configured interval.

The failed-fetch rule remains correct: rearm from the attempt rather than an expired
successful-fetch deadline.

**Plan amendment:** update M2 validation and M6's manual-clock matrix to cover zero,
positive-below-floor, exactly 60 seconds, and negative input.

### P2-F2 — ETag and freshness metadata need ownership by a representation

The state model still lists one global `etag` and `lastFetchAt`, while activated and
staged representations can differ. This becomes ambiguous as soon as a 200 is fetched
without activation:

1. Activated representation v1 has ETag E1.
2. A public `fetch()` receives v2/E2 and stages it without activation.
3. A second fetch sends E2 and receives 304.

That 304 confirms staged v2, not activated v1. E2 and its refreshed timestamp must not
be persisted beside v1's values.

The simpler activated case is also incomplete. A 304 refreshes `lastFetchAt`, but the
cache file is written only on activation commits. When no staged representation
exists, `activate()` does nothing, so the refreshed timestamp is lost on relaunch.
The next launch can fetch again despite being inside the minimum interval.

Finally, the state description says `lastKnownVersion` comes from a successful 200 or
304 response. A 304 carries no version; it only confirms a representation already
associated with the request's validator.

**Recommended resolution:** make network/cache metadata part of each representation:

```text
activated = { version, values, etag, fetchedAt, activatedAt, memoizedJSON }
staged    = { version, values, etag, fetchedAt }?
```

The request validator comes from staged when present, otherwise activated. A 304
updates the metadata of the representation whose ETag was sent:

- activated confirmed → update and persist activated `fetchedAt` without observation
  or a `LeverUpdate`;
- staged confirmed → update staged `fetchedAt` only; and
- no representation/validator associated with the request → `invalidResponse`.

Define `lastKnownVersion` as the version of the newest validated representation held
by the process. A 200 can replace it; a 304 confirms it but does not supply a new one.

**Required tests:** 304 against activated state persists freshness across restart;
304 against staged state does not combine staged metadata with activated values;
fetch-200-stage → fetch-304 → activate; and 304 without an associated validator.

### P2-F3 — The App Group single-writer topology is not expressible through the API

Spec §7 declares the supported topology to be one authoritative writer with extension
processes acting as readers. It then states that an extension constructing
`LeverClient` automatically fetches and can activate/write. Constructing a client is
also the only public path that loads the Lever cache and exposes typed reads.

Consequently, the SDK cannot actually create the read-only clients required by its
supported topology. The design currently relies on consumers behaving as readers
without giving them a reader mode.

**Recommended resolution:** do not defer cache-only behavior if same-device extension
parity is part of v1. Add a small configuration control such as:

```swift
public enum LeverAutomaticUpdates: Sendable {
    case enabled
    case disabled
}
```

or an equivalent `automaticUpdatesEnabled` property. Disabled mode synchronously loads
and serves the cache but starts no automatic fetch, timer, lifecycle observer, or SSE
connection. Explicit `fetch()` behavior must be decided: either remain available as a
deliberate override or fail with a documented configuration error.

If no such mode is added, narrow the promise: describe App Group access as
last-writer-wins best effort rather than a supported single-writer/reader topology,
and remove extension cache parity from the v1 acceptance claim.

**Required tests if adopted:** cache-only initialization serves the cache
synchronously; no transport/lifecycle work begins; multiple cache-only readers never
write; an app writer's later atomic update is visible on the next reader
initialization.

## 3. Smaller corrections

### P2-F4 — Concurrent identity creation needs an explicit primitive and scope

M3 requires concurrent first initialization to converge on one `clientId`. Atomic
replacement alone cannot guarantee this: two processes can both observe no file,
generate different UUIDs, and retain different in-memory identities even though one
file eventually wins.

Require exclusive first creation (`O_CREAT | O_EXCL` or an equivalent primitive),
followed by reading the winner when creation loses. Alternatively, explicitly scope
the convergence guarantee and test to clients in one process and acknowledge that
cross-process first initialization is last-writer-wins. The former better matches the
App Group story and does not require general-purpose file coordination.

### P2-F5 — M11 must set `cacheNamespace`

The revised spec correctly makes warm-cache survival across key rotation conditional
on a stable `cacheNamespace`. M11 currently configures only `cacheDirectory`.

The flagship migration should set an explicit stable namespace such as `"prod"` and
test an offline relaunch after simulating client-key rotation. Otherwise the flagship
can still regress to code defaults after the exact credential-rotation event that
motivated the cache-identity change.

### P2-F6 — Correct the public error comments

The `LeverError.server` comment still says "any other non-2xx/304", while transport
§6.1 maps unexpected successful statuses such as 204 to `.server(status:)` too. Change
it to "any HTTP status other than 200, 304, or 401" or equivalent.

`invalidResponse` now also covers non-HTTP responses and an invalid 304, not only a
body decode failure; broaden that comment as well.

### P2-F7 — Correct the watch/App Group wording

The phrase "watch complications hosted in the iOS extension" is inaccurate. The
portable rule is same-device sharing:

- iOS app and its iOS widget/extension may share an iOS App Group container; and
- watchOS app and its watchOS widget/complication extension may share a watchOS App
  Group container on the Watch.

An iPhone app and an independent watchOS app remain cross-device and require their own
clients or an explicit transfer mechanism.

### P2-F8 — Validate the SSE response before parsing bytes

The SSE connection should require status 200 and the expected `text/event-stream`
media type before treating the response as open. A 200 HTML proxy/error page should
not enter the event parser and wait for EOF/watchdog behavior.

Specify mappings for 401, 503, redirects, other statuses, non-HTTP responses, and a
wrong/missing media type, then include them in M7's scripted-stream matrix.

### P2-F9 — Separate contract-fixture coverage from Foundation-only transport tests

M5 says request construction is byte-exact against M9 fixtures and then names cases
such as non-HTTP responses and redirect refusal. The HTTP fixture package should pin
real server behavior and wire bytes; Foundation-only events cannot be generated or
verified by the service.

State explicitly that:

- M9 fixtures cover request URLs/headers, 200/304/401/server statuses, ETags, and
  bodies that the real service can emit; and
- SDK-local scripted transport/session tests cover non-HTTP responses, redirect
  delegate behavior, cancellation, and malformed platform responses.

## 4. Disposition checklist (resolved 2026-08-14)

All nine findings were accepted and folded into [spec 0002](./spec.md) and
[plan 0002](./plan.md) in the same documentation pass:

- [x] Positive intervals below the 60-second polling floor — spec §3, §5.1
  (timer clamps to 60 s; lifecycle edges keep the configured value; `.zero`
  arms no timer)
- [x] Representation-owned ETag and fetch timestamps — spec §4 (activated and
  staged each carry `etag`/`fetchedAt`; validator and interval clock read the
  newest representation)
- [x] Persisting activated-state freshness after 304 — spec §6.1, §7
  (metadata-only cache write, no observation)
- [x] `lastKnownVersion` wording for 304 — spec §4 (derived from the newest
  validated representation; a 304 confirms, never supplies)
- [x] Cache-only mode or a narrowed App Group promise — mode adopted:
  `automaticUpdates` in spec §2/§5/§7 (supersedes pass 1's deferral)
- [x] Cross-process first-identity convergence — spec §7 (exclusive create;
  loser re-reads the winner)
- [x] Stable `cacheNamespace` in M11 — plan M11 (set it; offline relaunch after
  simulated rotation is acceptance)
- [x] Public `LeverError` comments — spec §2
- [x] Same-device watch/App Group wording — spec §7
- [x] SSE status and content-type validation — spec §6.2, §10.3, plan M7
- [x] HTTP fixtures versus SDK-local transport tests — plan M5 (fixtures pin
  what the service can emit; scripted tests cover Foundation-only events)

The plan is ready to enter M1.
