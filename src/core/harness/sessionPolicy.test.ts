import { describe, expect, it } from "vitest";
import { harnessLaunchIntentOf, originalSessionPolicyOf, sameOriginalSessionPolicy } from "./sessionPolicy.js";

describe("durable launch intent closed contract", () => {
  it("accepts declared intent and refuses malformed or inherited authority", () => {
    const intent = {
      version: 1,
      harness: "opencode",
      phase: "prepared",
      ordinal: 0,
      sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "read" },
    };
    expect(harnessLaunchIntentOf(intent)).toEqual(intent);
    for (const invalid of [
      undefined,
      { ...intent, phase: "finished" },
      { ...intent, harness: "other" },
      { ...intent, extra: true },
      { ...intent, sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "write" } },
      Object.create(intent),
    ]) {
      expect(harnessLaunchIntentOf(invalid)).toBeUndefined();
    }
  });
});

describe("original session policy closed contract", () => {
  it.each(["none", "read", "write"] as const)("accepts original native %s without changing its route", (identity) => {
    expect(originalSessionPolicyOf({ version: 1, commandRoute: "native", identity })).toEqual({
      version: 1,
      commandRoute: "native",
      identity,
    });
  });
  it("accepts only the declared hosted read policy and compares semantic fields", () => {
    const first = { version: 1, commandRoute: "hosted-review", identity: "read" };
    const reordered = { identity: "read", commandRoute: "hosted-review", version: 1 };
    expect(originalSessionPolicyOf(first)).toEqual(first);
    expect(sameOriginalSessionPolicy(first, reordered)).toBe(true);
    expect(sameOriginalSessionPolicy(first, { ...first, commandRoute: "native" })).toBe(false);
    expect(sameOriginalSessionPolicy(first, { ...first, identity: "write" })).toBe(false);
  });
  it("keeps missing, malformed, extra-field and inherited evidence unknown", () => {
    const inherited = Object.assign(Object.create({ version: 1, commandRoute: "native", identity: "read" }), {
      a: 1,
      b: 2,
      c: 3,
    });
    for (const value of [
      undefined,
      null,
      [],
      {},
      inherited,
      { version: "1", commandRoute: "native", identity: "read" },
      { version: 2, commandRoute: "native", identity: "read" },
      { version: 1, commandRoute: "other", identity: "read" },
      { version: 1, commandRoute: "hosted-review", identity: "write" },
      { version: 1, commandRoute: "native", identity: "unknown" },
      { version: 1, commandRoute: "native", identity: "read", extra: true },
      { version: 1, commandRoute: { toString: () => "native" }, identity: "read" },
    ]) {
      expect(originalSessionPolicyOf(value)).toBeUndefined();
      expect(sameOriginalSessionPolicy(value, value)).toBe(false);
    }
  });
});
