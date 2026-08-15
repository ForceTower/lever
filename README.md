# lever

Self-hosted remote config: typed parameters, targeted values, instant propagation — one
deployment serving every project.

Lever replaces Firebase Remote Config for apps that want to own their config plane. The
server evaluates targeting rules and hands clients fully resolved values; SDKs (Kotlin,
Swift, TypeScript) stay thin: fetch-and-activate, disk cache, code defaults as the floor,
and a server-sent-events nudge for instant rollout.

**Status:** the backend service (resolve, stream, admin API, passkey admin auth,
publish/rollback) is implemented; the dashboard and SDKs are next. The founding scope and every "why" live in
[docs/research/0001-product-scope/research.md](docs/research/0001-product-scope/research.md);
the service design in [docs/specs/0001-service/spec.md](docs/specs/0001-service/spec.md).

## Running

Requirements: [mise](https://mise.jdx.dev) (pins bun) — or a matching
[bun](https://bun.sh) directly.

```sh
mise install
bun install

# The dashboard runs on its own domain, so the API needs to be told which origin
# that is; in development it is the Vite dev server.
LEVER_ADMIN_ORIGINS="http://localhost:5173" \
LEVER_WEBAUTHN_RP_ID="localhost" \
LEVER_WEBAUTHN_ORIGINS="http://localhost:5173" \
LEVER_JWT_SECRET="$(head -c 32 /dev/urandom | base64)" \
  bun run --cwd apps/api dev
```

The server migrates its SQLite schema automatically at boot and listens on `:3000`.
`GET /healthz` answers when it is up.

Every JSON response — resolve and admin alike — is one envelope:

```jsonc
{ "ok": true, "message": "…", "data": { /* the payload */ }, "error": null }
{ "ok": false, "message": "…", "data": null, "error": { "code": "not_found" } }
```

`message` is for humans; branch on the status and `error.code`. The resolve `ETag`
validates `data` only, so it never changes because wording did.

### Creating the first admin

Admin access is a passkey login against an account. There is no default account and
no shared secret — you mint a one-time enrollment code against the database:

```sh
bun run --cwd apps/api admin:enroll <username> --name "Your Name"
```

It prints a code valid for 15 minutes, which the dashboard's registration screen
exchanges for a passkey. Run it again any time to enrol another device — **do that
at least once**: with no password there is no reset, and a second credential is the
difference between a lost phone and a lockout. The command works against the
database file directly, so it is also the recovery path if every credential is lost.

### Configuration

| Variable                    | Default           | Meaning                                                                          |
| --------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| `PORT`                      | `3000`            | Listen port                                                                      |
| `DATABASE_PATH`             | `./data/lever.db` | SQLite file (WAL mode)                                                           |
| `LEVER_ALLOWED_ORIGINS`     | `*`               | CORS origins for the public read surface (`/v1/resolve`, `/v1/stream`)           |
| `LEVER_ADMIN_ORIGINS`       | — (required)      | CORS origins for `/v1/admin` — the dashboard's origin. `*` is rejected           |
| `LEVER_WEBAUTHN_RP_ID`      | — (required)      | The **dashboard's** domain, not the API's. Changing it invalidates every passkey |
| `LEVER_WEBAUTHN_ORIGINS`    | — (required)      | Origins a passkey assertion may come from; must sit under the RP id              |
| `LEVER_WEBAUTHN_RP_NAME`    | `Lever`           | Name shown in the platform's passkey prompt                                      |
| `LEVER_JWT_SECRET`          | — (required)      | Signs admin session tokens; 32+ chars. Rotating it logs everyone out             |
| `LEVER_ADMIN_SESSION_HOURS` | `8`               | Admin session lifetime; does not slide                                           |
| `SSE_HEARTBEAT_MS`          | `25000`           | Stream heartbeat interval                                                        |
| `SSE_MAX_SUBSCRIBERS`       | `2000`            | Stream cap; past it clients get 503 and fall back to polling                     |
| `LOG_LEVEL`                 | `info`            | `debug` / `info` / `warn` / `error`                                              |

### Docker

```sh
docker build -f apps/api/Dockerfile -t lever .
docker run -d --name lever \
  -p 3000:3000 \
  -v lever-data:/data \
  -e LEVER_ADMIN_ORIGINS="https://lever.example.dev" \
  -e LEVER_WEBAUTHN_RP_ID="lever.example.dev" \
  -e LEVER_WEBAUTHN_ORIGINS="https://lever.example.dev" \
  -e LEVER_JWT_SECRET="<32+ random chars>" \
  lever
```

Run **exactly one container**: the resolve cache and the SSE registry live in process
memory by design. Put any reverse proxy or tunnel you like in front; nothing else is
required.

The image serves the API only. The dashboard is a static SPA with its own build and
its own deployment at its own domain — the two are coupled by configuration (the
origin variables above), not by packaging, so a dashboard release never restarts the
config service.

## Security model, in two lines

- **Client keys (`pk_…`) are identifiers, not credentials.** They authorize reading one
  environment's resolved config — which end users can see anyway.
- **Admin access is a passkey**, bound to the dashboard's domain and backed by a
  revocable server-side session. There is no shared admin secret to leak, and
  revoking a session or a permission takes effect on the next request. Every
  non-`GET` admin request is recorded in an audit log.
- **Never put secrets in config values.** Resolved values are readable by every end
  user of your app. API keys for client-side services are fine (they are public by
  nature); server credentials are not.

## Backups

The database is one SQLite file in WAL mode. Never copy it with `cp` while the server
runs — that races the checkpointer. Use SQLite's own snapshotting:

```sh
sqlite3 /data/lever.db "VACUUM INTO '/backups/lever-$(date +%F).db'"
```

Versions are append-only and kept forever; the version chain is the audit log, and the
backup taken before an upgrade is the rollback story for the schema itself.

## Development

```sh
bun run check   # lint (oxlint) + format check (oxfmt) + types (tsc)
bun run fix     # auto-fix lint + format
bun test        # all suites, in-memory SQLite, no network
```

Workflow: research docs capture _why_ (`docs/research/`), specs pin down _how_
(`docs/specs/`), then implementation. Start with the research doc if you want to
understand the shape of the thing.
