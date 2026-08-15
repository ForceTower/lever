# Lever Agent Instructions

## Overall

- Lever is a self-hosted remote config service — a Firebase Remote Config replacement:
  a Bun + Hono server that evaluates targeting rules server-side, thin client SDKs
  (TypeScript, Kotlin, Swift), and a minimal admin dashboard. One deployment serves
  many projects.
- **This repo is public.** Never commit secrets, credentials, or personal
  infrastructure specifics — deployment examples stay generic.
- Status: pre-implementation. `docs/research/0001-product-scope/research.md` is the
  founding document — cite it for every "why". Workflow: research docs capture why,
  specs (`docs/specs/`) pin down how, then implementation.
- Code readability matters most.
- ALWAYS read and understand relevant files before proposing edits. Do not speculate
  about code you have not inspected.

## Product invariants

These are settled decisions (research 0001). Do not drift from them; changing one is a
deliberate act that starts with updating the research doc, not the code.

- **Server-side evaluation only.** Clients send context (platform, appVersion, custom
  attributes); the server returns fully resolved values + version + ETag. SDKs never
  contain a rule engine.
- **SSE is a nudge, not a source of truth.** The stream carries version numbers only —
  never values. On a nudge the SDK runs its normal fetch-and-activate; a dead stream
  degrades to min-interval polling, never to broken config.
- **SDK three-layer floor:** live values → disk-cached last-activated values → code
  defaults. An unreachable server means stale config, never a broken app. This must be
  covered by tests, not just intent.
- **Fetch-and-activate.** Fetched values are staged; reads are stable until
  `activate()`. Push nudges auto-activate by default, with an opt-out.
- **Publish is immutable.** Versions are append-only with diffs; rollback republishes
  an old version as a new one. The version chain is the audit log.
- **No secrets in config values.** Resolved values are readable by end users; client
  keys (`pk_…`) are identifiers, not credentials. User-facing docs repeat this loudly.

## Terminology

- **parameter** — a typed config key (`boolean | string | number | json`) with a
  default value and ordered conditional values (first match wins).
- **environment** — prod/staging/dev within a project; owns one public client key.
- **resolve** — server-side evaluation of every parameter for a given client context.
- **version** — an immutable published snapshot of an environment's config.

## Tooling

- `mise` for tool version management, `bun` for packages and scripts (never `npm`,
  `yarn`, or `pnpm`; `bunx` in place of `npx`), `oxlint` for linting and `oxfmt` for
  formatting (never `prettier` or `eslint`).
- Workspace scripts: `bun run check` (lint + format check + both tsconfigs), `fix`,
  `fmt`, `lint`. `apps/admin` is typechecked by its own tsconfig (JSX, DOM libs) and
  linted **without** `--type-aware`: oxlint's type pass does not resolve the `@/`
  alias, so aliased types would degrade to `any` and the rules would misfire.
- Run the fixer frequently and after finishing a task; do not hand-fix formatting.

## Dashboard (`apps/admin`)

- Vite + React + TanStack Router/Query + Tailwind v4 + shadcn, deployed separately
  from the API (spec 0001 §9.4) — it may depend on the HTTP contract, never on
  `apps/api` source.
- UI comes from shadcn: `bunx shadcn@latest add <component>` writes into
  `src/components/ui`. Extend a generated component's `cva` variants when a new tone
  is needed; do not hand-roll a parallel component. `src/styles/index.css` owns the
  theme, including the `warn` / `add` / `del` diff tones.
- Draft-vs-published state is read from the server's publish diff
  (`GET /environments/:id/diff`), never recomputed client-side.

## TypeScript conventions

- File naming: `kebab-case.ts`. Named exports over default exports.
- Avoid `any` and casting; validate unknown data at boundaries with `zod`, prefer type
  guards over assertions. Let inference work — add explicit types only when inference
  is insufficient.
- Database access goes through Kysely (custom bun:sqlite dialect in
  `apps/api/src/db/kysely.ts`); no hand-written SQL strings outside migrations.
  Inside `withTransaction`, query only through the repos handed to the callback.
- Never use `.merge()`/`.extend()` on zod schemas (TS2589 risk) — spread `.shape` into
  a flat `z.object()` instead:

```ts
const merged = z.object({ ...schemaA.shape, ...schemaB.shape });
```

## Source Control

- Default branch is `main`; branch from it and PR against it.
- Do not add any Claude co-author or "generated with" note to commits.
