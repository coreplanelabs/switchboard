import { describe, expect, it } from "vitest";
import {
  DEPS_LEASE_KEY_PREFIX,
  IN_FLIGHT_KEY_PREFIX,
  inFlightKey,
  inFlightRow,
  MIRROR_MUTEX_KEY,
  REFRESH_CYCLE_LEASE_MS,
  STALE_MIDFLIGHT_MS,
  depsLeaseKey,
  leaseIsDead,
  liveInFlight,
  mintIncarnationId,
  releaseMutex,
  takeMutex,
  type InFlightRow,
  type Lease,
} from "./residentIncarnation.js";

const NOW = 1_700_000_000_000;
const CURRENT = "inc-current";
const OTHER = "inc-previous";
const BUDGET = 10 * 60_000;

const lease = (over: Partial<Lease> = {}): Lease => ({
  holder: `${CURRENT}:1`,
  incarnation: CURRENT,
  expiresAt: NOW + BUDGET,
  step: "fetch",
  ...over,
});

describe("mintIncarnationId — one id per isolate start", () => {
  it("two mints never collide and each is a non-empty opaque string", () => {
    const a = mintIncarnationId();
    const b = mintIncarnationId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(8);
  });
  it("the id is whatever the random source says (the source is the only entropy)", () => {
    expect(mintIncarnationId(() => "fixed")).toBe("fixed");
  });
});

describe("leaseIsDead — the one predicate every lease is judged by", () => {
  it("a lease of the current incarnation inside its budget is alive", () => {
    expect(leaseIsDead(lease(), NOW, CURRENT)).toBe(false);
    expect(leaseIsDead(lease({ expiresAt: NOW }), NOW, CURRENT)).toBe(false); // the last instant still counts
  });
  it("a lease of another incarnation is dead however fresh its expiry", () => {
    expect(leaseIsDead(lease({ incarnation: OTHER, expiresAt: NOW + BUDGET }), NOW, CURRENT)).toBe(true);
  });
  it("a lease past its expiry is dead even for the current incarnation (the backstop for a holder that hung without an isolate swap)", () => {
    expect(leaseIsDead(lease({ expiresAt: NOW - 1 }), NOW, CURRENT)).toBe(true);
  });
});

describe("takeMutex — take when free or the holder is dead, wait only for a live holder", () => {
  it("an empty row (a fresh resident) is taken and the row records the current incarnation, the step and the budget as expiry", () => {
    const d = takeMutex(undefined, NOW, CURRENT, BUDGET, "fetch", `${CURRENT}:7`);
    expect(d).toEqual({
      action: "take",
      why: "free",
      dead: undefined,
      row: { holder: `${CURRENT}:7`, incarnation: CURRENT, expiresAt: NOW + BUDGET, step: "fetch" },
    });
  });
  it("a live holder of the current incarnation makes the caller wait, for at most what is left of the holder's budget", () => {
    const d = takeMutex(lease({ expiresAt: NOW + 30_000 }), NOW, CURRENT, BUDGET, "fetch", `${CURRENT}:2`);
    expect(d).toEqual({ action: "wait", row: lease({ expiresAt: NOW + 30_000 }), remainingMs: 30_000 });
  });
  it("a holder of another incarnation is dead: taken immediately, the dead lease handed back so its tree can be swept", () => {
    const dead = lease({
      incarnation: OTHER,
      holder: `${OTHER}:9`,
      step: "deps-install",
      tree: "/workspace/deps/.scratch-a1",
    });
    const d = takeMutex(dead, NOW, CURRENT, BUDGET, "deps-install", `${CURRENT}:3`);
    expect(d).toMatchObject({ action: "take", why: "holder-incarnation-gone", dead });
    expect((d as { row: Lease }).row).toEqual({
      holder: `${CURRENT}:3`,
      incarnation: CURRENT,
      expiresAt: NOW + BUDGET,
      step: "deps-install",
    });
  });
  it("an expired holder is dead: taken immediately with the expiry named as the reason", () => {
    const d = takeMutex(lease({ expiresAt: NOW - 1 }), NOW, CURRENT, BUDGET, "build", `${CURRENT}:4`);
    expect(d).toMatchObject({ action: "take", why: "holder-expired" });
  });
  it("the taken row carries the tree when the caller names one, and no tree key otherwise", () => {
    const withTree = takeMutex(undefined, NOW, CURRENT, BUDGET, "deps-install", "h", "/workspace/deps/.scratch-x");
    expect((withTree as { row: Lease }).row.tree).toBe("/workspace/deps/.scratch-x");
    const without = takeMutex(undefined, NOW, CURRENT, BUDGET, "fetch", "h");
    expect("tree" in (without as { row: Lease }).row).toBe(false);
  });
});

describe("releaseMutex — a holder releases only its own row", () => {
  it("the holder's own row is released (the row goes away)", () => {
    expect(releaseMutex(lease({ holder: "h1" }), "h1")).toEqual({ released: true, row: undefined });
  });
  it("a row another holder took over (this holder was judged dead meanwhile) is left in place", () => {
    const foreign = lease({ holder: "h2" });
    expect(releaseMutex(foreign, "h1")).toEqual({ released: false, row: foreign });
  });
  it("no row at all is a harmless release", () => {
    expect(releaseMutex(undefined, "h1")).toEqual({ released: false, row: undefined });
  });
});

describe("the in-flight row — what the watchdog reads instead of the isolate's memos", () => {
  const empty: InFlightRow = { refresh: null, hydration: null };
  it("an absent row means nothing is in flight", () => {
    expect(liveInFlight(undefined, NOW, CURRENT)).toEqual({ refresh: false, hydration: false });
  });
  it("a refresh lease of the current incarnation inside its budget is a cycle in flight; a hydration lease likewise", () => {
    const row = inFlightRow(lease({ step: "refresh" }), lease({ step: "restore" }));
    expect(liveInFlight(row, NOW, CURRENT)).toEqual({ refresh: true, hydration: true });
  });
  it("leases of a previous incarnation are dead: an isolate swap ends what the swap killed", () => {
    const row = inFlightRow(lease({ incarnation: OTHER }), null);
    expect(liveInFlight(row, NOW, CURRENT)).toEqual({ refresh: false, hydration: false });
  });
  it("a hydration past the stale bound is dead, the way the watchdog judged the memo", () => {
    const row = inFlightRow(null, lease({ expiresAt: NOW + STALE_MIDFLIGHT_MS }));
    expect(liveInFlight(row, NOW + STALE_MIDFLIGHT_MS, CURRENT).hydration).toBe(true);
    expect(liveInFlight(row, NOW + STALE_MIDFLIGHT_MS + 1, CURRENT).hydration).toBe(false);
  });
  it("each fact has its own document, so recording one never rewrites the other", () => {
    expect(inFlightKey("refresh")).toBe("resident:inFlight:refresh");
    expect(inFlightKey("hydration")).toBe("resident:inFlight:hydration");
    expect(inFlightRow(undefined, undefined)).toEqual(empty);
  });
  it("the refresh lease outlasts every budgeted cycle: longer than the stale bound the watchdog uses for a hydration", () => {
    expect(REFRESH_CYCLE_LEASE_MS).toBeGreaterThan(STALE_MIDFLIGHT_MS);
    expect(STALE_MIDFLIGHT_MS).toBe(30 * 60_000);
  });
});

describe("storage keys — one document per fact, under the resident's prefix", () => {
  it("the mutex, the in-flight facts and the per-key deps lease have distinct keys", () => {
    expect(MIRROR_MUTEX_KEY).toBe("resident:mirrorMutex");
    expect(IN_FLIGHT_KEY_PREFIX).toBe("resident:inFlight:");
    expect(depsLeaseKey("a".repeat(64))).toBe(`${DEPS_LEASE_KEY_PREFIX}${"a".repeat(64)}`);
    expect(new Set([MIRROR_MUTEX_KEY, IN_FLIGHT_KEY_PREFIX, DEPS_LEASE_KEY_PREFIX]).size).toBe(3);
  });
  it("a deps lease key is only ever built from a lockfile key", () => {
    expect(() => depsLeaseKey("../etc")).toThrow(/lockfile key/);
  });
});
