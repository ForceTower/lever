import { describe, expect, test } from "bun:test";
import { createTokenService } from "./tokens";

const SECRET = "test-jwt-secret-test-jwt-secret-32";
const OTHER = "another-secret-another-secret-42!";

const claims = { accountId: "account-1", sessionId: "session-1" };
const inAnHour = () => Date.now() + 60 * 60 * 1000;

describe("createTokenService", () => {
  test("round-trips the account and session ids", async () => {
    const tokens = createTokenService(SECRET);
    const token = await tokens.sign({ ...claims, expiresAt: inAnHour() });
    expect(await tokens.verify(token)).toEqual({ sub: "account-1", jti: "session-1" });
  });

  test("refuses a token signed with a different secret", async () => {
    const mine = createTokenService(SECRET);
    const theirs = createTokenService(OTHER);
    const token = await theirs.sign({ ...claims, expiresAt: inAnHour() });
    expect(await mine.verify(token)).toBeUndefined();
  });

  test("refuses a tampered payload", async () => {
    const tokens = createTokenService(SECRET);
    const token = await tokens.sign({ ...claims, expiresAt: inAnHour() });
    const [header, payload, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "someone-else", jti: "session-1" }),
      "utf8",
    ).toString("base64url");
    expect(await tokens.verify(`${header}.${forged}.${signature}`)).toBeUndefined();
    expect(payload).not.toBe(forged);
  });

  test("refuses an expired token", async () => {
    const tokens = createTokenService(SECRET);
    // Beyond the 30s clock tolerance the verifier allows.
    const token = await tokens.sign({ ...claims, expiresAt: Date.now() - 120_000 });
    expect(await tokens.verify(token)).toBeUndefined();
  });

  test.each(["", "garbage", "a.b.c", "not.a.jwt.at.all"])("refuses %j", async (token) => {
    expect(await createTokenService(SECRET).verify(token)).toBeUndefined();
  });

  test("the token carries no permission claims — grants are resolved live", async () => {
    const tokens = createTokenService(SECRET);
    const token = await tokens.sign({ ...claims, expiresAt: inAnHour() });
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    expect(payload.permissions).toBeUndefined();
    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat", "iss", "jti", "sub"]);
  });
});
