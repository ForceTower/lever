/**
 * Repository-level coverage for the §3.2.1 identity tables — the guards the
 * HTTP tests exercise only indirectly.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createTestApp, type TestApp } from "../test-support";

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
});

const accounts = () => app.env.repos.adminAccounts;
const sessions = () => app.env.repos.adminSessions;

async function account(username = "operator") {
  return accounts().create({ username, name: username });
}

describe("admin account repo", () => {
  test("usernames are unique", async () => {
    await account();
    expect(account()).rejects.toThrow();
  });

  test("grants are replaced wholesale", async () => {
    const created = await account();
    await accounts().replaceGrants(created.id, ["config:read", "config:write"]);
    expect(await accounts().listGrants(created.id)).toEqual(["config:read", "config:write"]);

    await accounts().replaceGrants(created.id, ["config:read"]);
    expect(await accounts().listGrants(created.id)).toEqual(["config:read"]);

    await accounts().replaceGrants(created.id, []);
    expect(await accounts().listGrants(created.id)).toEqual([]);
  });

  // A disabled account cannot log in, so counting it would let the last usable
  // manager be removed (§8.1.5).
  test("countHolders ignores disabled accounts", async () => {
    const first = await account("one");
    const second = await account("two");
    await accounts().replaceGrants(first.id, ["accounts:manage"]);
    await accounts().replaceGrants(second.id, ["accounts:manage"]);
    expect(await accounts().countHolders("accounts:manage")).toBe(2);

    await accounts().update(second.id, { disabledAt: Date.now() });
    expect(await accounts().countHolders("accounts:manage")).toBe(1);
  });

  test("deleting an account cascades its credentials, grants, and sessions", async () => {
    const created = await account();
    await accounts().replaceGrants(created.id, ["config:read"]);
    await accounts().addCredential({
      id: "credential-1",
      accountId: created.id,
      publicKey: new TextEncoder().encode("key"),
      counter: 0,
      transports: ["internal"],
      name: "phone",
    });
    await sessions().create({
      id: Bun.randomUUIDv7(),
      accountId: created.id,
      expiresAt: Date.now() + 1000,
      ip: null,
      userAgent: null,
    });

    expect(await accounts().remove(created.id)).toBe(true);
    expect(await accounts().listGrants(created.id)).toEqual([]);
    expect(await accounts().getCredential("credential-1")).toBeUndefined();
    expect(await sessions().listByAccount(created.id)).toHaveLength(0);
  });

  test("credential transports round-trip and a corrupt list degrades to empty", async () => {
    const created = await account();
    await accounts().addCredential({
      id: "credential-1",
      accountId: created.id,
      publicKey: new TextEncoder().encode("key"),
      counter: 3,
      transports: ["internal", "hybrid"],
      name: "phone",
    });
    expect((await accounts().getCredential("credential-1"))?.transports).toEqual([
      "internal",
      "hybrid",
    ]);

    app.env.sqlite.exec("UPDATE admin_credentials SET transports = 'not json'");
    expect((await accounts().getCredential("credential-1"))?.transports).toEqual([]);
  });

  test("touchCredential advances the counter and stamps last use", async () => {
    const created = await account();
    await accounts().addCredential({
      id: "credential-1",
      accountId: created.id,
      publicKey: new TextEncoder().encode("key"),
      counter: 1,
      transports: [],
      name: "phone",
    });
    await accounts().touchCredential("credential-1", 7);
    const stored = await accounts().getCredential("credential-1");
    expect(stored?.counter).toBe(7);
    expect(stored?.lastUsedAt).toBeNumber();
  });
});

describe("enrollment codes", () => {
  test("an expired or consumed code is not live", async () => {
    const created = await account();
    await accounts().createEnrollment({
      accountId: created.id,
      codeHash: "expired",
      expiresAt: Date.now() - 1,
    });
    expect(await accounts().findLiveEnrollment("expired", Date.now())).toBeUndefined();

    await accounts().createEnrollment({
      accountId: created.id,
      codeHash: "live",
      expiresAt: Date.now() + 60_000,
    });
    const live = await accounts().findLiveEnrollment("live", Date.now());
    expect(live).toBeDefined();
    await accounts().consumeEnrollment(live?.id ?? "", Date.now());
    expect(await accounts().findLiveEnrollment("live", Date.now())).toBeUndefined();
  });

  // The `consumed_at IS NULL` guard is what makes redemption single-use when two
  // requests race the same code.
  test("only one of two consumers of the same code reports success", async () => {
    const created = await account();
    await accounts().createEnrollment({
      accountId: created.id,
      codeHash: "race",
      expiresAt: Date.now() + 60_000,
    });
    const enrollment = await accounts().findLiveEnrollment("race", Date.now());
    const now = Date.now();

    const results = await Promise.all([
      accounts().consumeEnrollment(enrollment?.id ?? "", now),
      accounts().consumeEnrollment(enrollment?.id ?? "", now),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("admin session repo", () => {
  async function live(accountId: string, expiresAt = Date.now() + 60_000) {
    const id = Bun.randomUUIDv7();
    await sessions().create({ id, accountId, expiresAt, ip: null, userAgent: null });
    return id;
  }

  test("a revoked or expired session is not live", async () => {
    const created = await account();
    const revoked = await live(created.id);
    const expired = await live(created.id, Date.now() - 1);
    const good = await live(created.id);

    await sessions().revoke(revoked, Date.now());
    expect(await sessions().findLiveById(revoked, Date.now())).toBeUndefined();
    expect(await sessions().findLiveById(expired, Date.now())).toBeUndefined();
    expect(await sessions().findLiveById(good, Date.now())).toBeDefined();
  });

  test("revoking twice reports success only once", async () => {
    const created = await account();
    const id = await live(created.id);
    expect(await sessions().revoke(id, Date.now())).toBe(true);
    expect(await sessions().revoke(id, Date.now())).toBe(false);
  });

  test("revokeAllForAccount closes every live session", async () => {
    const created = await account();
    await live(created.id);
    await live(created.id);
    expect(await sessions().revokeAllForAccount(created.id, Date.now())).toBe(2);
    expect(await sessions().revokeAllForAccount(created.id, Date.now())).toBe(0);
  });

  test("the sweep drops rows past the cutoff and keeps the rest", async () => {
    const created = await account();
    const old = await live(created.id, Date.now() - 100_000);
    const recent = await live(created.id);

    expect(await sessions().deleteExpiredBefore(Date.now() - 50_000)).toBe(1);
    expect(await sessions().getById(old)).toBeUndefined();
    expect(await sessions().getById(recent)).toBeDefined();
  });
});
