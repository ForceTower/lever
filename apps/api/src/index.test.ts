import { expect, test } from "bun:test";
import { service } from "./index";

test("workspace skeleton is wired", () => {
  expect(service.name).toBe("lever");
});
