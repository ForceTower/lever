# @lever/admin

The Lever dashboard: projects and environments, the parameter draft, the
condition library, and the publish review. A static SPA (Vite + React + shadcn)
with its own build and its own deployment — it talks to the service over
`/v1/admin` and shares nothing with it but the HTTP contract.

## Running it

```sh
cp .env.example .env
bun run --cwd apps/admin dev
```

The API must be running with this origin allowed:

```sh
LEVER_ADMIN_ORIGINS="http://localhost:5173" \
LEVER_WEBAUTHN_RP_ID="localhost" \
LEVER_WEBAUTHN_ORIGINS="http://localhost:5173" \
LEVER_JWT_SECRET="$(head -c 32 /dev/urandom | base64)" \
  bun run --cwd apps/api dev
```

Sign-in is a passkey. A fresh deployment has no credentials, so mint an
enrollment code and exchange it on the sign-in screen under _Have an enrollment
code?_:

```sh
bun run --cwd apps/api admin:enroll <username> --name "Your Name"
```

`bun run --cwd apps/admin build` produces `dist/` — plain static files for any
host. Nothing in the bundle is a secret: the session token lives in
`localStorage` and is minted by the passkey ceremony.

## Deploying

`wrangler.jsonc` deploys `dist/` as an assets-only Worker — no server, and
`not_found_handling` hands every router-owned path back `index.html`.
`VITE_API_BASE_URL` is read at **build** time and compiled into the bundle, so a
deployment is pinned to one API origin.

There is no deploy workflow in this repo: Cloudflare builds from the repository
directly, which is also what gives preview builds per branch. Connect the repo in
the Workers dashboard and set:

| Setting                       | Value                                                             |
| ----------------------------- | ----------------------------------------------------------------- |
| Path                          | `/` — the workspace lockfile lives there                          |
| Build command                 | `bun install --frozen-lockfile && bun run --cwd apps/admin build` |
| Deploy command                | `bun run --cwd apps/admin deploy`                                 |
| Non-production deploy command | `bun run --cwd apps/admin deploy:preview`                         |
| `VITE_API_BASE_URL`           | build variable — the API's origin                                 |
| `BUN_VERSION`                 | build variable — match `.mise.toml`                               |

`VITE_API_BASE_URL` has to be a **build** variable, not a Worker runtime one:
there is no runtime here to read it.

Point the API at the dashboard's origin afterwards — `LEVER_ADMIN_ORIGINS`,
`LEVER_WEBAUTHN_RP_ID` and `LEVER_WEBAUTHN_ORIGINS` all describe _this_ app's
domain, not the API's. The RP id is what a passkey is bound to: changing it
invalidates every enrolled credential.

**Preview builds cannot sign in.** A preview gets a fresh hostname per
deployment, and both gates in front of the admin surface are exact-origin by
design: WebAuthn refuses an assertion from an origin outside the RP id, and
`LEVER_ADMIN_ORIGINS` is an allowlist that rejects `*`. Previews are for reading
the UI; a preview that needs a session wants its own API with its own origins
listed, not a wildcard on the real one.

## Shape

```
src/
  app/          providers, router, the session gate
  components/   app shell, shared pieces, components/ui = shadcn
  features/     one directory per screen
  lib/api/      the /v1/admin transport and the wire types
  lib/queries.ts  react-query hooks; every draft edit refreshes the same four reads
```

Three things the UI is responsible for, all of them from research 0001:

- **Draft vs live is never ambiguous.** Every value carries where it stands
  relative to the published version, derived from the server's own publish diff
  (`GET /environments/:id/diff`) rather than a local comparison.
- **Refusals explain themselves.** A blocked delete names what references the
  thing; a blocked type change names the values that would fail; a publish
  conflict says someone else published and offers to reload the diff.
- **No secrets in config values.** The warning sits on the value editors and the
  parameter list, not only in the docs.
