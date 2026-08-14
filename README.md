# lever

Self-hosted remote config: typed parameters, targeted values, instant propagation — one
deployment serving every project.

Lever replaces Firebase Remote Config for apps that want to own their config plane. The
server evaluates targeting rules and hands clients fully resolved values; SDKs (Kotlin,
Swift, TypeScript) stay thin: fetch-and-activate, disk cache, code defaults as the floor,
and a server-sent-events nudge for instant rollout.

**Status:** the backend service (resolve, stream, admin API, publish/rollback) is
implemented; the dashboard and SDKs are next. The founding scope and every "why" live in
[docs/research/0001-product-scope/research.md](docs/research/0001-product-scope/research.md);
the service design in [docs/specs/0001-service/spec.md](docs/specs/0001-service/spec.md).

## Running

Requirements: [mise](https://mise.jdx.dev) (pins bun) — or a matching
[bun](https://bun.sh) directly.

```sh
mise install
bun install
LEVER_ADMIN_TOKENS="admin:$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)" \
  bun run --cwd apps/api dev
```

The server migrates its SQLite schema automatically at boot and listens on `:3000`.
`GET /healthz` answers when it is up.

### Configuration

| Variable                | Default           | Meaning                                                                                                                        |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                  | `3000`            | Listen port                                                                                                                    |
| `DATABASE_PATH`         | `./data/lever.db` | SQLite file (WAL mode)                                                                                                         |
| `LEVER_ADMIN_TOKENS`    | — (required)      | Comma-separated `name:secret` pairs; names `[a-z0-9-]{1,32}`, secrets `[A-Za-z0-9]{32,}`. The name becomes the publish author. |
| `LEVER_ALLOWED_ORIGINS` | `*`               | CORS origins for the public read surface (`/v1/resolve`, `/v1/stream`)                                                         |
| `SSE_HEARTBEAT_MS`      | `25000`           | Stream heartbeat interval                                                                                                      |
| `SSE_MAX_SUBSCRIBERS`   | `2000`            | Stream cap; past it clients get 503 and fall back to polling                                                                   |
| `LOG_LEVEL`             | `info`            | `debug` / `info` / `warn` / `error`                                                                                            |

### Docker

```sh
docker build -f apps/api/Dockerfile -t lever .
docker run -d --name lever \
  -p 3000:3000 \
  -v lever-data:/data \
  -e LEVER_ADMIN_TOKENS="admin:<a-32+-char-alphanumeric-secret>" \
  lever
```

Run **exactly one container**: the resolve cache and the SSE registry live in process
memory by design. Put any reverse proxy or tunnel you like in front; nothing else is
required.

## Security model, in two lines

- **Client keys (`pk_…`) are identifiers, not credentials.** They authorize reading one
  environment's resolved config — which end users can see anyway. Admin tokens are the
  only secrets; keep them in a password manager and rotate by editing the env var.
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
