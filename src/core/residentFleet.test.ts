import { describe, expect, it } from "vitest";
import type { ResidentAdminResponse } from "./residentAdmin.js";
import { FLEET_REFRESH_MS, NO_FLEET, watchResidentFleet } from "./residentFleet.js";

// Feature: features/routing-and-config.md item 11 — the resident cap the About
// block names comes from the resident Worker's own listing, read in the
// background, never a constant in the bot.

function admin(answers: Array<ResidentAdminResponse | Error>) {
  let calls = 0;
  return {
    calls: () => calls,
    residents: async () => {
      calls++;
      const next = answers.shift();
      if (!next) throw new Error("no more answers");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe("watchResidentFleet", () => {
  it("is unknown until the first listing answers, then the Worker's cap; a later listing updates it", async () => {
    const a = admin([
      { status: 200, data: { cap: 6, count: 2, residents: [] } },
      { status: 200, data: { cap: 8, count: 2, residents: [] } },
    ]);
    const fleet = watchResidentFleet(a, { warn: () => {} });
    expect(fleet.cap()).toBeUndefined();
    await fleet.refresh();
    expect(fleet.cap()).toBe(6);
    await fleet.refresh();
    expect(fleet.cap()).toBe(8);
  });

  it("a non-200 answer, a throw, or a listing without a numeric cap leaves the last value and warns — never a crash on the run path", async () => {
    const warnings: string[] = [];
    const a = admin([
      { status: 200, data: { cap: 6 } },
      { status: 503, data: { error: "down" } },
      new Error("fetch failed"),
      { status: 200, data: { cap: "six" } },
    ]);
    const fleet = watchResidentFleet(a, { warn: (m) => warnings.push(m) });
    await fleet.refresh();
    await fleet.refresh();
    await fleet.refresh();
    await fleet.refresh();
    expect(fleet.cap()).toBe(6);
    expect(warnings).toEqual([
      "[residents] fleet facts not refreshed: /residents answered 503",
      "[residents] fleet facts not refreshed: fetch failed",
    ]);
  });

  it("start() reads at once and then on the interval (unref'd); stop() clears it", async () => {
    const a = admin([
      { status: 200, data: { cap: 6 } },
      { status: 200, data: { cap: 7 } },
    ]);
    let tick: (() => void) | undefined;
    let unrefed = false;
    let cleared = false;
    const fleet = watchResidentFleet(a, {
      warn: () => {},
      refreshMs: 1234,
      setInterval: (fn, ms) => {
        expect(ms).toBe(1234);
        tick = fn;
        return { unref: () => void (unrefed = true) };
      },
      clearInterval: () => void (cleared = true),
    });
    fleet.start();
    await new Promise((r) => setImmediate(r));
    expect(fleet.cap()).toBe(6);
    expect(unrefed).toBe(true);
    tick!();
    await new Promise((r) => setImmediate(r));
    expect(fleet.cap()).toBe(7);
    fleet.stop();
    expect(cleared).toBe(true);
    expect(FLEET_REFRESH_MS).toBe(5 * 60_000);
  });

  it("NO_FLEET knows nothing", () => {
    expect(NO_FLEET.cap()).toBeUndefined();
  });
});
