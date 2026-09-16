import { describe, expect, it } from "vitest";
import {
  RESTORE_WAIT_MAX_MS,
  RestoreWaiters,
  restoredAfterWaitNote,
  restoreWaitFallbackNote,
} from "./residentRestoreEvent.js";
import { WAKE_WAIT_MAX_MS } from "./residentWake.js";

describe("RestoreWaiters", () => {
  it("a publish that leaves `restoring` answers every subscriber once, with the state it landed on", async () => {
    const waiters = new RestoreWaiters();
    const a = waiters.subscribe();
    const b = waiters.subscribe();
    expect(waiters.size).toBe(2);
    waiters.publish("warm", "");
    expect(await a).toEqual({ state: "warm", reason: "" });
    expect(await b).toEqual({ state: "warm", reason: "" });
    expect(waiters.size).toBe(0);
  });

  it("a transition into (or re-assertion of) `restoring` answers nobody — the restore is still running", async () => {
    const waiters = new RestoreWaiters();
    void waiters.subscribe();
    waiters.publish("restoring", "rehydrating");
    expect(waiters.size).toBe(1);
  });

  it("a subscriber arriving after a publish waits for the NEXT event — answers are never replayed", async () => {
    const waiters = new RestoreWaiters();
    waiters.publish("warm", "");
    const late = waiters.subscribe();
    expect(waiters.size).toBe(1);
    waiters.publish("degraded", "r2-restore-failed: boom");
    expect(await late).toEqual({ state: "degraded", reason: "r2-restore-failed: boom" });
  });

  it("a failed restore is the event too: the subscriber gets the state and decides", async () => {
    const waiters = new RestoreWaiters();
    const sub = waiters.subscribe();
    waiters.publish("down", "r2-restore-failed: boom");
    expect(await sub).toEqual({ state: "down", reason: "r2-restore-failed: boom" });
  });
});

describe("the restore-wait notes and ceiling", () => {
  it("the ceiling stays within the wake path's own (a restore is the same wait seen earlier)", () => {
    expect(RESTORE_WAIT_MAX_MS).toBeLessThanOrEqual(WAKE_WAIT_MAX_MS);
  });

  it("the attach note names the wait, and carries a non-warm state beside it", () => {
    expect(restoredAfterWaitNote(42_000, undefined)).toBe("restored after 42s (waited for the resident's restore)");
    expect(restoredAfterWaitNote(9_500, "refreshing")).toBe(
      "restored after 10s (waited for the resident's restore) — refreshing",
    );
  });

  it("the cold-fallback note names the wait and the state the resident was left in", () => {
    expect(restoreWaitFallbackNote(180_000, "restoring (rehydrating)")).toBe(
      "resident restoring (rehydrating) after waiting 180s for the resident's restore — using fresh sandbox",
    );
  });
});
