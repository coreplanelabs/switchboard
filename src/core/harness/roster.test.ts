import { describe, expect, expectTypeOf, it } from "vitest";
import type { Harness, HarnessName } from "./contract.js";
import { DEFAULT_HARNESS, HARNESS_NAMES, harnessForPreset, isHarnessName, type HarnessRoster } from "./roster.js";

// Feature: docs/reference/specs/harness.md item 8 — one roster, one word. The
// name a harness object declares IS the configuration word `harness.<preset>`
// takes; the validator, the loop's pick and a resumed row's judge all read the
// same list, so no second spelling of the harness names exists to drift.

const named = (name: HarnessName): Harness => ({ name }) as unknown as Harness;
const roster: HarnessRoster = { pi: named("pi"), opencode: named("opencode") };

describe("the harness roster — the names, the default and the pick", () => {
  it("HARNESS_NAMES is exactly the union the facts declare — a facts shape without a roster word, or a word without a shape, fails to build", () => {
    expectTypeOf<(typeof HARNESS_NAMES)[number]>().toEqualTypeOf<HarnessName>();
    expect([...HARNESS_NAMES]).toEqual(["pi", "opencode"]);
  });

  it("the default word is pi: nothing defaults to OpenCode", () => {
    expect(DEFAULT_HARNESS).toBe("pi");
    expect(HARNESS_NAMES).toContain(DEFAULT_HARNESS);
  });

  it("isHarnessName admits the roster's words and nothing else — not a near miss, not another type", () => {
    for (const word of HARNESS_NAMES) expect(isHarnessName(word), word).toBe(true);
    for (const word of ["codex", "native", "Pi", "", true, 1, null, undefined, ["pi"], { pi: 1 }])
      expect(isHarnessName(word), JSON.stringify(word)).toBe(false);
  });

  it("harnessForPreset picks the preset's word off the roster, and pi for a preset the block does not name or with no block at all", () => {
    expect(harnessForPreset(roster, { coding: "opencode" }, "coding")).toBe(roster.opencode);
    expect(harnessForPreset(roster, { coding: "opencode" }, "review")).toBe(roster.pi);
    expect(harnessForPreset(roster, { coding: "pi", review: "opencode" }, "review")).toBe(roster.opencode);
    expect(harnessForPreset(roster, {}, "coding")).toBe(roster.pi);
    expect(harnessForPreset(roster, undefined, "coding")).toBe(roster.pi);
  });
});
