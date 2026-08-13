/**
 * Behavior the canonicalization fixtures cannot express: values JSON cannot
 * carry. The serialization rules themselves are pinned by the fixtures.
 */
import { expect, test } from "bun:test";
import { canonicalize } from "./canonicalize";

test("canonicalize serializes -0 as 0", () => {
  expect(canonicalize(-0)).toBe("0");
});

test("canonicalize refuses non-finite numbers", () => {
  expect(() => canonicalize(Infinity)).toThrow();
  expect(() => canonicalize(NaN)).toThrow();
  expect(() => canonicalize([-Infinity])).toThrow();
});
