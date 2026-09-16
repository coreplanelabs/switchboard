import { describe, expect, it } from "vitest";
import { RestoreWaiters } from "./restoreWaiters.js";

// The ledger behind the resident Worker's POST /await-restore
// (docs/reference/specs/execution.md item 25): requests are held in memory and
// answered together by the ONE publish the lifecycle transition makes — no
// polling, no retry timer.
describe("RestoreWaiters — the ledger of held /await-restore requests (item 25)", () => {
  it("wait() holds until publish, and one publish answers every held waiter with the outcome", async () => {
    const ledger = new RestoreWaiters();
    let settled = 0;
    const a = ledger.wait().then((o) => (settled++, o));
    const b = ledger.wait().then((o) => (settled++, o));
    expect(ledger.size).toBe(2);
    await Promise.resolve(); // a microtask passes; nothing settles without a publish
    expect(settled).toBe(0);
    ledger.publish({ state: "warm", reason: "" });
    await expect(a).resolves.toEqual({ state: "warm", reason: "" });
    await expect(b).resolves.toEqual({ state: "warm", reason: "" });
    expect(settled).toBe(2);
  });

  it("publish empties the ledger — a later waiter is held for the NEXT transition, not answered by the last", async () => {
    const ledger = new RestoreWaiters();
    const first = ledger.wait();
    ledger.publish({ state: "degraded", reason: "restore-failed: boom" });
    await expect(first).resolves.toEqual({ state: "degraded", reason: "restore-failed: boom" });
    expect(ledger.size).toBe(0);
    let late: unknown;
    void ledger.wait().then((o) => (late = o));
    expect(ledger.size).toBe(1);
    await Promise.resolve();
    expect(late).toBeUndefined();
    ledger.publish({ state: "warm", reason: "" });
    await Promise.resolve();
    expect(late).toEqual({ state: "warm", reason: "" });
  });

  it("publish with nothing held is a no-op", () => {
    const ledger = new RestoreWaiters();
    expect(() => ledger.publish({ state: "warm", reason: "" })).not.toThrow();
    expect(ledger.size).toBe(0);
  });
});
