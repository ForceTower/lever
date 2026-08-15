import { describe, expect, test } from "bun:test";
import { envVarsSchema } from "./env";

const SECRET = "test-jwt-secret-test-jwt-secret-32";

const VALID = {
  LEVER_ADMIN_ORIGINS: "https://portal.lever.test",
  LEVER_WEBAUTHN_RP_ID: "lever.test",
  LEVER_WEBAUTHN_ORIGINS: "https://portal.lever.test",
  LEVER_JWT_SECRET: SECRET,
};

describe("envVarsSchema", () => {
  test("applies defaults and parses origin lists", () => {
    expect(envVarsSchema.parse(VALID)).toEqual({
      NODE_ENV: "development",
      PORT: 3000,
      DATABASE_PATH: "./data/lever.db",
      LEVER_ALLOWED_ORIGINS: "*",
      LEVER_ADMIN_ORIGINS: ["https://portal.lever.test"],
      LEVER_WEBAUTHN_RP_ID: "lever.test",
      LEVER_WEBAUTHN_ORIGINS: ["https://portal.lever.test"],
      LEVER_WEBAUTHN_RP_NAME: "Lever",
      LEVER_ADMIN_SESSION_HOURS: 8,
      LEVER_JWT_SECRET: SECRET,
      SSE_HEARTBEAT_MS: 25_000,
      SSE_MAX_SUBSCRIBERS: 2_000,
      LOG_LEVEL: "info",
    });
  });

  test("requires the four config values only the operator knows (§9.1)", () => {
    expect(envVarsSchema.safeParse({}).success).toBe(false);
    for (const omitted of Object.keys(VALID)) {
      const vars: Record<string, string> = { ...VALID };
      delete vars[omitted];
      expect(envVarsSchema.safeParse(vars).success).toBe(false);
    }
  });

  test("splits and trims a multi-origin list", () => {
    const parsed = envVarsSchema.parse({
      ...VALID,
      LEVER_ADMIN_ORIGINS: "https://portal.lever.test, http://localhost:5173",
      LEVER_WEBAUTHN_ORIGINS: "https://portal.lever.test,https://admin.lever.test",
    });
    expect(parsed.LEVER_ADMIN_ORIGINS).toEqual([
      "https://portal.lever.test",
      "http://localhost:5173",
    ]);
    expect(parsed.LEVER_WEBAUTHN_ORIGINS).toEqual([
      "https://portal.lever.test",
      "https://admin.lever.test",
    ]);
  });

  // §5.3: an authenticated surface that echoes any origin is how a hostile page
  // reaches an operator's session.
  test("refuses a wildcard admin origin", () => {
    expect(envVarsSchema.safeParse({ ...VALID, LEVER_ADMIN_ORIGINS: "*" }).success).toBe(false);
  });

  test.each([
    ["portal.lever.test", "no scheme"],
    ["https://portal.lever.test/admin", "has a path"],
    ["", "empty"],
  ])("refuses %j as an origin (%s)", (origin) => {
    expect(envVarsSchema.safeParse({ ...VALID, LEVER_ADMIN_ORIGINS: origin }).success).toBe(false);
  });

  // §8.1.1: the common misconfiguration is pointing the RP id at the API's
  // domain, which would make every assertion fail at login instead of at boot.
  test("refuses an RP id that is not a suffix of the WebAuthn origins", () => {
    const result = envVarsSchema.safeParse({ ...VALID, LEVER_WEBAUTHN_RP_ID: "api.example.dev" });
    expect(result.success).toBe(false);
  });

  test("accepts an RP id that is a parent domain of the origin", () => {
    const parsed = envVarsSchema.parse({
      ...VALID,
      LEVER_WEBAUTHN_RP_ID: "lever.test",
      LEVER_WEBAUTHN_ORIGINS: "https://portal.lever.test",
    });
    expect(parsed.LEVER_WEBAUTHN_RP_ID).toBe("lever.test");
  });

  test("refuses a JWT secret below the HS256 floor", () => {
    expect(envVarsSchema.safeParse({ ...VALID, LEVER_JWT_SECRET: "short" }).success).toBe(false);
  });

  test("coerces numeric vars from strings", () => {
    const parsed = envVarsSchema.parse({ ...VALID, PORT: "8080", LEVER_ADMIN_SESSION_HOURS: "2" });
    expect(parsed.PORT).toBe(8080);
    expect(parsed.LEVER_ADMIN_SESSION_HOURS).toBe(2);
  });
});
