import { expect, it, vi } from "vitest";
vi.mock("../../secrets.js", () => {
  throw new Error("Worker facts decoder must not load bot secrets");
});
import { harnessFactsOf } from "./facts.js";

it("decodes saved producer facts without the bot runtime", () => {
  expect(harnessFactsOf({ harness: "pi", pid: 12, logOffset: 9, launchOrdinal: 2 })).toEqual({
    harness: "pi",
    pid: 12,
    logOffset: 9,
    launchOrdinal: 2,
    relaunches: 0,
  });
  expect(harnessFactsOf({ harness: "unknown", pid: 12, logOffset: 9 })).toBeUndefined();
});
