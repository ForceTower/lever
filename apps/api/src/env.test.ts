import { describe, expect, test } from "bun:test";
import { envVarsSchema, parseAdminTokens } from "./env";

const SECRET = "S3cr3tS3cr3tS3cr3tS3cr3tS3cr3t42"; // 32 chars

describe("parseAdminTokens", () => {
  test("parses named tokens", () => {
    expect(parseAdminTokens(`joao:${SECRET},ci-bot:${"Z".repeat(40)}`)).toEqual([
      { name: "joao", secret: SECRET },
      { name: "ci-bot", secret: "Z".repeat(40) },
    ]);
  });

  test.each([
    ["", "empty"],
    ["justaname", "no separator"],
    [`joao:${SECRET}:extra`, "extra separator"],
    [`Joao:${SECRET}`, "uppercase name"],
    [`${"n".repeat(33)}:${SECRET}`, "name too long"],
    ["joao:tooshort", "secret below 32 chars"],
    [`joao:${"a".repeat(31)}!`, "secret with symbol"],
    [`joao:${SECRET},`, "trailing comma"],
    [`joao:${SECRET},joao:${"B".repeat(32)}`, "duplicate name"],
  ])("rejects %j (%s)", (raw) => {
    expect(() => parseAdminTokens(raw)).toThrow();
  });
});

describe("envVarsSchema", () => {
  test("applies defaults and parses admin tokens", () => {
    const parsed = envVarsSchema.parse({ LEVER_ADMIN_TOKENS: `joao:${SECRET}` });
    expect(parsed).toEqual({
      NODE_ENV: "development",
      PORT: 3000,
      DATABASE_PATH: "./data/lever.db",
      LEVER_ADMIN_TOKENS: [{ name: "joao", secret: SECRET }],
      LEVER_ALLOWED_ORIGINS: "*",
      SSE_HEARTBEAT_MS: 25_000,
      SSE_MAX_SUBSCRIBERS: 2_000,
      LOG_LEVEL: "info",
    });
  });

  test("refuses missing or malformed admin tokens", () => {
    expect(envVarsSchema.safeParse({}).success).toBe(false);
    expect(envVarsSchema.safeParse({ LEVER_ADMIN_TOKENS: "joao:short" }).success).toBe(false);
  });

  test("coerces numeric vars from strings", () => {
    const parsed = envVarsSchema.parse({ LEVER_ADMIN_TOKENS: `joao:${SECRET}`, PORT: "8080" });
    expect(parsed.PORT).toBe(8080);
  });
});
