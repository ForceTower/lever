# @lever/contract-fixtures

Shared resolve fixtures (spec 0001 §10.2): JSON files of
`{ snapshot, context, expected }` cases that define what correct evaluation means,
once, for every implementation.

Rules:

- **JSON fixture files only — no runtime code.** The server's evaluation tests and the
  TypeScript, Kotlin, and Swift SDK test suites all consume these files verbatim; any
  logic in this package would not be portable across those languages.
- Server behavior fixtures (ETag stability, 304, empty-context defaults) live
  alongside the evaluation cases as HTTP cases keyed by canonical response bodies,
  including the case that pins `canonicalize()`'s exact output bytes (spec §3.3).

Fixtures land with spec 0001 phase 2 (evaluation engine); `fixtures/` is empty until
then.
