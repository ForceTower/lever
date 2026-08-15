/**
 * §10.3 admin auth coverage: the passkey ceremony over a WebAuthn double, the
 * session lifecycle, the permission split, and the audit log.
 */
import { describe, expect, test } from "bun:test";
import { createTestApp, dataOf, errorCodeOf, type TestApp } from "../../test-support";
import type { Permission } from "../../service/permissions";

const post = (body: unknown) => ({ method: "POST", body });

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** A registration response of the right shape; the double ignores the crypto. */
function registrationResponse(id = "credential-1") {
  return {
    id,
    rawId: id,
    type: "public-key" as const,
    response: { clientDataJSON: "Y2xpZW50", attestationObject: "YXR0ZXN0" },
  };
}

function authenticationResponse(id = "credential-1") {
  return {
    id,
    rawId: id,
    type: "public-key" as const,
    response: { clientDataJSON: "Y2xpZW50", authenticatorData: "YXV0aA", signature: "c2ln" },
  };
}

async function createAccount(
  app: TestApp,
  options: { username?: string; permissions?: Permission[] } = {},
) {
  return app.env.services.adminAuth.createAccount({
    username: options.username ?? "operator",
    name: "Operator",
    permissions: options.permissions ?? ["config:read", "config:write"],
  });
}

/** Drives register/options → register/verify over HTTP and returns the response. */
async function enroll(app: TestApp, code: string, credentialId = "credential-1") {
  const options = await dataOf(
    await app.request("/v1/admin/auth/register/options", {
      ...post({ code }),
      token: null,
    }),
  );
  return app.request("/v1/admin/auth/register/verify", {
    ...post({
      code,
      challengeId: options.challengeId,
      credentialName: "phone",
      response: registrationResponse(credentialId),
    }),
    token: null,
  });
}

async function login(app: TestApp, username?: string, credentialId = "credential-1") {
  const options = await dataOf(
    await app.request("/v1/admin/auth/login/options", {
      ...post(username === undefined ? {} : { username }),
      token: null,
    }),
  );
  return app.request("/v1/admin/auth/login/verify", {
    ...post({
      challengeId: options.challengeId,
      response: authenticationResponse(credentialId),
    }),
    token: null,
  });
}

describe("passkey enrollment (§8.1.2)", () => {
  test("a code enrols a credential and returns a working session", async () => {
    const app = createTestApp();
    const { enrollment } = await createAccount(app);

    const registered = await enroll(app, enrollment.code);
    expect(registered.status).toBe(201);
    const session = await dataOf(registered);
    expect(session.account.username).toBe("operator");

    const projects = await app.request("/v1/admin/projects", { token: session.token });
    expect(projects.status).toBe(200);
  });

  test("an enrollment code is single-use", async () => {
    const app = createTestApp();
    const { enrollment } = await createAccount(app);
    expect((await enroll(app, enrollment.code)).status).toBe(201);

    // The consumed code is refused at the very first step of a second ceremony.
    const again = await app.request("/v1/admin/auth/register/options", {
      ...post({ code: enrollment.code }),
      token: null,
    });
    expect(again.status).toBe(401);
    expect(await errorCodeOf(again)).toBe("unauthorized");
  });

  test("an expired code is refused", async () => {
    const app = createTestApp();
    const { account } = await createAccount(app);
    const code = "expired-code";
    await app.env.repos.adminAccounts.createEnrollment({
      accountId: account.id,
      codeHash: hash(code),
      expiresAt: Date.now() - 1,
    });
    const res = await app.request("/v1/admin/auth/register/options", {
      ...post({ code }),
      token: null,
    });
    expect(res.status).toBe(401);
  });

  test("an unknown code is refused", async () => {
    const app = createTestApp();
    const res = await app.request("/v1/admin/auth/register/options", {
      ...post({ code: "nope" }),
      token: null,
    });
    expect(res.status).toBe(401);
  });

  // §8.1.3: challenges are tagged with the ceremony that created them.
  test("a login challenge cannot be redeemed as a registration", async () => {
    const app = createTestApp();
    const { enrollment } = await createAccount(app);
    const loginOptions = await dataOf(
      await app.request("/v1/admin/auth/login/options", { ...post({}), token: null }),
    );

    const res = await app.request("/v1/admin/auth/register/verify", {
      ...post({
        code: enrollment.code,
        challengeId: loginOptions.challengeId,
        credentialName: "phone",
        response: registrationResponse(),
      }),
      token: null,
    });
    expect(res.status).toBe(401);
  });

  test("a challenge is single-use", async () => {
    const app = createTestApp();
    const { account } = await createAccount(app);
    const first = await app.env.services.adminAuth.mintEnrollment(account.id);
    const second = await app.env.services.adminAuth.mintEnrollment(account.id);

    const options = await dataOf(
      await app.request("/v1/admin/auth/register/options", {
        ...post({ code: first.code }),
        token: null,
      }),
    );
    const body = {
      challengeId: options.challengeId,
      credentialName: "phone",
      response: registrationResponse(),
    };
    expect(
      (
        await app.request("/v1/admin/auth/register/verify", {
          ...post({ ...body, code: first.code }),
          token: null,
        })
      ).status,
    ).toBe(201);
    // Same challenge, a fresh unconsumed code: the challenge alone must stop it.
    const replay = await app.request("/v1/admin/auth/register/verify", {
      ...post({ ...body, code: second.code }),
      token: null,
    });
    expect(replay.status).toBe(401);
  });
});

describe("passkey login (§8.1.3)", () => {
  test("a registered credential logs in", async () => {
    const app = createTestApp();
    const { enrollment } = await createAccount(app);
    await enroll(app, enrollment.code);

    const res = await login(app, "operator");
    expect(res.status).toBe(200);
    const session = await dataOf(res);
    expect((await app.request("/v1/admin/projects", { token: session.token })).status).toBe(200);
  });

  // The endpoint is pre-assertion: it must not reveal who holds admin access.
  test("login options answer identically for a known and an unknown username", async () => {
    const app = createTestApp();
    const { enrollment } = await createAccount(app);
    await enroll(app, enrollment.code);

    const known = await app.request("/v1/admin/auth/login/options", {
      ...post({ username: "operator" }),
      token: null,
    });
    const unknown = await app.request("/v1/admin/auth/login/options", {
      ...post({ username: "ghost" }),
      token: null,
    });
    expect(known.status).toBe(unknown.status);
    const knownBody = await known.json();
    const unknownBody = await unknown.json();
    expect(Object.keys(knownBody).sort()).toEqual(Object.keys(unknownBody).sort());
    expect(knownBody.message).toBe(unknownBody.message);
  });

  test("a failed assertion is the same generic 401", async () => {
    const app = createTestApp();
    const { enrollment } = await createAccount(app);
    await enroll(app, enrollment.code);

    app.webauthn.rejectNext = true;
    const res = await login(app, "operator");
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe("unauthorized");
  });

  test("an unknown credential is refused", async () => {
    const app = createTestApp();
    const res = await login(app, undefined, "never-registered");
    expect(res.status).toBe(401);
  });

  test("an account with no grants cannot log in", async () => {
    const app = createTestApp();
    const { account, enrollment } = await createAccount(app, { permissions: [] });
    await enroll(app, enrollment.code);
    await app.env.repos.adminAccounts.replaceGrants(account.id, []);

    expect((await login(app, "operator")).status).toBe(401);
  });

  test("a disabled account cannot log in", async () => {
    const app = createTestApp();
    const { account, enrollment } = await createAccount(app);
    await enroll(app, enrollment.code);
    await app.env.services.adminAuth.updateAccount(account.id, { disabled: true });

    expect((await login(app, "operator")).status).toBe(401);
  });
});

describe("sessions (§8.1.4)", () => {
  test("garbage, unsigned, and foreign-signed tokens are all 401", async () => {
    const app = createTestApp();
    const other = createTestApp({
      vars: { LEVER_JWT_SECRET: "another-secret-another-secret-42!" },
    });
    const foreign = await other.signIn();

    for (const token of ["garbage", "a.b.c", foreign]) {
      expect((await app.request("/v1/admin/projects", { token })).status).toBe(401);
    }
  });

  test("logout revokes exactly the calling session", async () => {
    const app = createTestApp();
    const first = await app.signIn({ username: "one" });
    const second = await app.signIn({ username: "two" });

    expect(
      (await app.request("/v1/admin/auth/logout", { method: "POST", token: first })).status,
    ).toBe(200);
    expect((await app.request("/v1/admin/projects", { token: first })).status).toBe(401);
    expect((await app.request("/v1/admin/projects", { token: second })).status).toBe(200);
  });

  test("an expired session is refused even with a valid signature", async () => {
    const app = createTestApp();
    const account = await app.env.repos.adminAccounts.create({ username: "old", name: "Old" });
    await app.env.repos.adminAccounts.replaceGrants(account.id, ["config:read"]);
    const sessionId = Bun.randomUUIDv7();
    const expiresAt = Date.now() - 1000;
    await app.env.repos.adminSessions.create({
      id: sessionId,
      accountId: account.id,
      expiresAt,
      ip: null,
      userAgent: null,
    });
    // Signed with a future exp so the JWT itself verifies — only the row is stale.
    const token = await app.env.tokens.sign({
      accountId: account.id,
      sessionId,
      expiresAt: Date.now() + 60_000,
    });
    expect((await app.request("/v1/admin/projects", { token })).status).toBe(401);
  });

  test("disabling an account kills its live sessions on the next request", async () => {
    const app = createTestApp();
    const token = await app.signIn({ username: "victim", permissions: ["config:read"] });
    const account = await app.env.repos.adminAccounts.getByUsername("victim");
    expect((await app.request("/v1/admin/projects", { token })).status).toBe(200);

    await app.env.services.adminAuth.updateAccount(account?.id ?? "", { disabled: true });
    expect((await app.request("/v1/admin/projects", { token })).status).toBe(401);
  });

  // Grants are resolved live, never carried in the token (§8.1.4).
  test("a grant revoked mid-session applies on the next request with no re-login", async () => {
    const app = createTestApp();
    const token = await app.signIn({
      username: "editor",
      permissions: ["config:read", "config:write"],
    });
    const account = await app.env.repos.adminAccounts.getByUsername("editor");
    expect(
      (await app.request("/v1/admin/projects", { ...post({ key: "a", name: "A" }), token })).status,
    ).toBe(201);

    await app.env.repos.adminAccounts.replaceGrants(account?.id ?? "", ["config:read"]);
    expect(
      (await app.request("/v1/admin/projects", { ...post({ key: "b", name: "B" }), token })).status,
    ).toBe(403);
    // Still a valid session — only the write verb is gone.
    expect((await app.request("/v1/admin/projects", { token })).status).toBe(200);
  });

  test("stripping every grant ends the session entirely", async () => {
    const app = createTestApp();
    const token = await app.signIn({ username: "nobody", permissions: ["config:read"] });
    const account = await app.env.repos.adminAccounts.getByUsername("nobody");
    await app.env.repos.adminAccounts.replaceGrants(account?.id ?? "", []);
    expect((await app.request("/v1/admin/projects", { token })).status).toBe(401);
  });

  test("/auth/session reports the account and its live grants", async () => {
    const app = createTestApp();
    const token = await app.signIn({ username: "who", permissions: ["config:read"] });
    const body = await dataOf(await app.request("/v1/admin/auth/session", { token }));
    expect(body.account.username).toBe("who");
    expect(body.permissions).toEqual(["config:read"]);
  });
});

describe("permissions (§8.1.5)", () => {
  async function seedEnvironment(app: TestApp) {
    const admin = await app.signIn({ username: "root" });
    const project = await dataOf(
      await app.request("/v1/admin/projects", {
        ...post({ key: "acme", name: "Acme" }),
        token: admin,
      }),
    );
    const environment = await dataOf(
      await app.request(`/v1/admin/projects/${project.id}/environments`, {
        ...post({ key: "prod" }),
        token: admin,
      }),
    );
    await app.request(`/v1/admin/environments/${environment.id}/parameters`, {
      ...post({ key: "gate", type: "boolean", defaultValue: false }),
      token: admin,
    });
    return { admin, project, environment };
  }

  test("config:read cannot write", async () => {
    const app = createTestApp();
    const token = await app.signIn({ username: "reader", permissions: ["config:read"] });
    const res = await app.request("/v1/admin/projects", {
      ...post({ key: "x", name: "X" }),
      token,
    });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe("forbidden");
  });

  test("config:write cannot publish", async () => {
    const app = createTestApp();
    const { environment } = await seedEnvironment(app);
    const token = await app.signIn({
      username: "writer",
      permissions: ["config:read", "config:write"],
    });
    const res = await app.request(`/v1/admin/environments/${environment.id}/publish`, {
      ...post({}),
      token,
    });
    expect(res.status).toBe(403);
  });

  test("config:publish cannot rotate a client key or delete an environment", async () => {
    const app = createTestApp();
    const { environment } = await seedEnvironment(app);
    const token = await app.signIn({
      username: "publisher",
      permissions: ["config:read", "config:write", "config:publish"],
    });
    expect(
      (
        await app.request(`/v1/admin/environments/${environment.id}/publish`, {
          ...post({}),
          token,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(`/v1/admin/environments/${environment.id}/rotate-key`, {
          method: "POST",
          token,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/v1/admin/environments/${environment.id}`, {
          method: "DELETE",
          body: { confirm: "prod" },
          token,
        })
      ).status,
    ).toBe(403);
  });

  test("the identity surface needs accounts:manage", async () => {
    const app = createTestApp();
    const token = await app.signIn({
      username: "operator",
      permissions: ["config:read", "config:write", "config:publish", "config:admin"],
    });
    expect((await app.request("/v1/admin/accounts", { token })).status).toBe(403);
  });

  test("an account cannot remove its own accounts:manage grant", async () => {
    const app = createTestApp();
    const token = await app.signIn({ username: "self" });
    const account = await app.env.repos.adminAccounts.getByUsername("self");
    const res = await app.request(`/v1/admin/accounts/${account?.id}/grants`, {
      method: "PUT",
      body: { permissions: ["config:read"] },
      token,
    });
    expect(res.status).toBe(409);
  });

  test("the last accounts:manage holder cannot be deleted or disabled", async () => {
    const app = createTestApp();
    const token = await app.signIn({ username: "only-admin" });
    const other = await app.signIn({ username: "helper", permissions: ["config:read"] });
    expect(other).toBeString();
    const account = await app.env.repos.adminAccounts.getByUsername("only-admin");

    expect(
      (await app.request(`/v1/admin/accounts/${account?.id}`, { method: "DELETE", token })).status,
    ).toBe(409);
    expect(
      (
        await app.request(`/v1/admin/accounts/${account?.id}`, {
          method: "PATCH",
          body: { disabled: true },
          token,
        })
      ).status,
    ).toBe(409);
  });

  test("two concurrent attempts cannot strip the last two managers between them", async () => {
    const app = createTestApp();
    const token = await app.signIn({ username: "admin-a" });
    const second = await app.signIn({ username: "admin-b" });
    const a = await app.env.repos.adminAccounts.getByUsername("admin-a");
    const b = await app.env.repos.adminAccounts.getByUsername("admin-b");

    // Each tries to delete the other. Whatever order they serialize in, the set
    // must not end up empty: exactly one deletion lands, and the loser is
    // refused — by the guard if it still has a session, by auth if its own
    // account went first.
    const results = await Promise.all([
      app.request(`/v1/admin/accounts/${b?.id}`, { method: "DELETE", token }),
      app.request(`/v1/admin/accounts/${a?.id}`, { method: "DELETE", token: second }),
    ]);
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409 || status === 401)).toHaveLength(1);
    expect(await app.env.repos.adminAccounts.countHolders("accounts:manage")).toBe(1);
  });
});

describe("audit (§8.1.6)", () => {
  test("a mutating request writes one row with account, path, and status", async () => {
    const app = createTestApp();
    const token = await app.signIn({ username: "author" });
    await app.request("/v1/admin/projects", { ...post({ key: "acme", name: "Acme" }), token });

    const entries = await app.env.repos.adminAudit.list(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.username).toBe("author");
    expect(entries[0]?.method).toBe("POST");
    expect(entries[0]?.path).toBe("/v1/admin/projects");
    expect(entries[0]?.status).toBe(201);
    expect(entries[0]?.body).toEqual({ key: "acme", name: "Acme" });
  });

  test("GET requests are not recorded", async () => {
    const app = createTestApp();
    const token = await app.signIn();
    await app.request("/v1/admin/projects", { token });
    expect(await app.env.repos.adminAudit.list(10)).toHaveLength(0);
  });

  test("a rejected write is recorded with its 4xx status", async () => {
    const app = createTestApp();
    const token = await app.signIn({ username: "reader", permissions: ["config:read"] });
    await app.request("/v1/admin/projects", { ...post({ key: "x", name: "X" }), token });

    const entries = await app.env.repos.adminAudit.list(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe(403);
  });

  // An audit log that captures credentials is a liability, not a record.
  test("enrollment bodies are recorded as null", async () => {
    const app = createTestApp();
    const token = await app.signIn({ username: "manager" });
    const created = await dataOf(
      await app.request("/v1/admin/accounts", {
        ...post({ username: "newbie", name: "Newbie", permissions: ["config:read"] }),
        token,
      }),
    );
    await app.request(`/v1/admin/accounts/${created.account.id}/enrollments`, {
      method: "POST",
      token,
    });

    const entries = await app.env.repos.adminAudit.list(10);
    const enrollmentEntry = entries.find((entry) => entry.path.endsWith("/enrollments"));
    expect(enrollmentEntry).toBeDefined();
    expect(enrollmentEntry?.body).toBeNull();
    expect(enrollmentEntry?.status).toBe(201);
  });

  test("the unauthenticated ceremony surface is never audited", async () => {
    const app = createTestApp();
    const { enrollment } = await createAccount(app);
    await enroll(app, enrollment.code);
    expect(await app.env.repos.adminAudit.list(10)).toHaveLength(0);
  });
});
