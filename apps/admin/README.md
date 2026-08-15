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
