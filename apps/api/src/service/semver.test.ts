import { describe, expect, test } from "bun:test";
import { compareSemver, parseSemver, type Semver } from "./semver";

function parsed(input: string): Semver {
  const version = parseSemver(input);
  if (version === undefined) throw new Error(`expected valid semver: ${input}`);
  return version;
}

describe("parseSemver", () => {
  test.each([
    "1.0.0",
    "0.0.0",
    "10.20.30",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-0.3.7",
    "1.0.0-x-y-z.--",
    "1.0.0+build.1",
    "1.0.0-beta+exp.sha.5114f85",
  ])("accepts %s", (input) => {
    expect(parseSemver(input)).toBeDefined();
  });

  test.each([
    "",
    "5.2",
    "1",
    "1.0.0.0",
    "01.0.0",
    "1.02.0",
    "1.0.0-",
    "1.0.0+",
    "1.0.0-01",
    "v1.0.0",
    " 1.0.0",
    "1.0.0 ",
    "1.0.0-beta..1",
  ])("rejects %s", (input) => {
    expect(parseSemver(input)).toBeUndefined();
  });

  test("splits numeric and alphanumeric prerelease identifiers", () => {
    expect(parsed("1.2.3-beta.11.x")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["beta", 11, "x"],
    });
  });
});

describe("compareSemver", () => {
  // The ordered chain from semver.org §11.
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "2.0.0",
  ];

  test("orders the semver.org precedence chain", () => {
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        const left = ordered[i];
        const right = ordered[j];
        if (left === undefined || right === undefined) continue;
        const expected = i < j ? -1 : i > j ? 1 : 0;
        expect(compareSemver(parsed(left), parsed(right))).toBe(expected);
      }
    }
  });

  test("ignores build metadata", () => {
    expect(compareSemver(parsed("1.0.0+a"), parsed("1.0.0+b"))).toBe(0);
    expect(compareSemver(parsed("1.0.0-beta+a"), parsed("1.0.0-beta+b"))).toBe(0);
  });

  test("compares numeric prerelease identifiers numerically, not lexically", () => {
    expect(compareSemver(parsed("1.0.0-2"), parsed("1.0.0-11"))).toBe(-1);
  });
});
