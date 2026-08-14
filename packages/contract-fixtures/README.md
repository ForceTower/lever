# @lever/contract-fixtures

Shared fixtures: JSON files that define what correct behavior means, once, for every
implementation. The server's tests and the TypeScript, Kotlin, and Swift SDK test
suites all consume these files verbatim.

Rules:

- **JSON fixture files only — no runtime code.** Any logic in this package would not
  be portable across those languages.
- Fixtures are **generated and verified against the real server** by
  `apps/api/src/api/http-fixtures.test.ts` and
  `apps/api/src/service/fixtures.test.ts`, so a tape can never drift from what lever
  actually emits. `bun run fixtures:update` re-records; plain `bun test` verifies.

## `fixtures/evaluation/*.json`, `fixtures/canonicalization.json`

Spec 0001 §10.2: `{ name, snapshot, context, expected }` evaluation cases, and the
canonicalization cases that pin `canonicalize()`'s exact output bytes (spec 0001 §3.3).

## `fixtures/http/*.json`

Spec 0002 §10.4: recorded HTTP conversations against `GET /v1/resolve`. Each SDK
replays the `response` of every step through its transport double, asserts the
`request` it built matches, and checks `expect`.

```jsonc
{
  "name": "resolve-repeat-304", // must equal the file's basename
  "description": "…",
  "setup": {
    // how the server test builds the environment
    "conditions": [{ "name": "…", "clauses": [/* spec 0001 §4 */] }],
    "parameters": [
      {
        "key": "…",
        "type": "boolean",
        "defaultValue": false,
        "conditionalValues": [{ "condition": "<condition name>", "value": true }],
      },
    ],
    "publish": true, // false → a never-published environment (version 0)
  },
  "steps": [
    {
      "before": "rotate-key", // optional server-side act before this step
      "request": {
        "path": "/v1/resolve",
        "context": {
          "platform": "ios",
          "appVersion": "5.2.0",
          "clientId": "…",
          "attributes": { "locale": "pt-BR" },
        },
        "query": "platform=ios&appVersion=5.2.0&clientId=…&attr.locale=pt-BR",
        "ifNoneMatch": { "fromStep": 1 }, // send the ETag recorded by step 1 (1-based)
      },
      "response": { "status": 304, "etag": "\"…\"", "body": null }, // recorded, never hand-edited
      "expect": {
        "activatedVersion": 1,
        "changed": false,
        "error": "invalidKey",
        "reads": [{ "key": "…", "type": "boolean", "default": false, "expected": true }],
      },
    },
  ],
}
```

Notes that make the tapes replayable in any language:

- **`request.query` is the exact query string an SDK must produce.** Reserved names
  come first in the fixed order `platform`, `appVersion`, `clientId`; then `attr.*`
  sorted by name in ascending **UTF-8 byte order**. Values are percent-encoded over
  UTF-8 with the RFC 3986 unreserved set (`A-Za-z0-9-._~`) — a space is `%20`, never
  `+`. The server test rebuilds the query from `context` and asserts it equals this
  string, so the encoding rule is pinned on both sides.
- **The client key is fixed at configure time.** `"before": "rotate-key"` rotates the
  environment's key server-side while the client keeps sending the old one — that is
  how the 401 tape is produced, not by a special-cased response.
- **`response` is a recording.** ETags are SHA-256 over the canonical response body,
  so a matching ETag pins the exact bytes, not merely an equivalent JSON shape.
  Regenerate with `bun run fixtures:update` rather than editing by hand.
- **`expect.reads[].type`** names the SDK-side key type, not the wire type — that is
  the point of the mismatch tape. `boolean`, `string`, `int`, `double`, and `json`
  (decoded into a string-to-string map, so a non-string member is a decode failure
  that must fall back to `default`).
- **`expect.error`** is the error an explicit `fetch()` must surface for that step;
  absent means the step must succeed. `expect.activatedVersion` and `expect.reads`
  are asserted after the step either way — a failed fetch must leave the previous
  snapshot serving.
