import { describe, expect, it } from "vitest";
import {
  AUTO_REBUILD_BUDGET,
  AUTO_REBUILD_WINDOW_MS,
  autoRebuildDecision,
  isAutoRebuildEligible,
  REHYDRATION_FAILURE_RE,
} from "./residentAutoRebuild.js";

// A resident that goes `down` on a reason only a rebuild can escape is rebuilt
// on that transition — not after three watchdog passes — under a budget that
// stops a flapping resident from rebuilding forever
// (docs/reference/specs/resident-repos.md item 36).

const T0 = Date.parse("2026-09-16T22:32:28.224Z");
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 60 * 60_000;

describe("autoRebuildDecision (the down transition decides; the watchdog is the backstop)", () => {
  it("a rehydration down with an empty history is rebuilt at once, and the history records the instant", () => {
    const d = autoRebuildDecision({
      reason: "r2-restore-failed: exit 143: no output — container stopped so the transfer cannot land on a rebuild",
      history: [],
      now: T0,
    });
    expect(d.action).toBe("rebuild");
    if (d.action !== "rebuild") throw new Error("unreachable");
    expect(d.history).toEqual([iso(T0)]);
    expect(d.reason).toBe(
      `auto-rebuild (1 of ${AUTO_REBUILD_BUDGET} in 24 h): r2-restore-failed: exit 143: no output — container stopped so the transfer cannot land on a rebuild`,
    );
  });

  it("every reason only a rebuild can escape is eligible; a provision failure never is — it would loop against the same broken build", () => {
    for (const reason of [
      "no-snapshot: resident has no recorded snapshot to rehydrate from",
      "snapshot-stamp-mismatch: restored disk {sha:abc} != stamp {sha:def}",
      "r2-restore-failed: checkout restore stalled: 0 bytes written in 120000 ms",
      "runtime-unreachable: the container's control port did not answer within 30 s (attempt 6 of 6)",
      "infra-streak: 5 consecutive cycles failed in the resident's own steps (last: fetch, since …) — a recreated container failed the same way; rebuilding",
    ]) {
      expect(REHYDRATION_FAILURE_RE.test(reason), reason).toBe(true);
      expect(isAutoRebuildEligible(reason), reason).toBe(true);
      expect(autoRebuildDecision({ reason, history: [], now: T0 }).action, reason).toBe("rebuild");
    }
    for (const reason of [
      "provision-failed at install: exit 1",
      "provision-timeout: onboarding stuck past its budget (watchdog)",
      "disk-full: install: ENOSPC",
      "",
    ]) {
      expect(isAutoRebuildEligible(reason), reason).toBe(false);
      expect(autoRebuildDecision({ reason, history: [], now: T0 })).toEqual({ action: "not-eligible", why: "reason" });
    }
  });

  it("the budget is spent at AUTO_REBUILD_BUDGET rebuilds inside the window: the resident stays down with the reason naming the budget and the one way back — never a reopen instant nothing acts on", () => {
    const history = [iso(T0 - 5 * HOUR), iso(T0 - 1 * HOUR)];
    expect(history).toHaveLength(AUTO_REBUILD_BUDGET);
    const d = autoRebuildDecision({ reason: "no-snapshot: nothing recorded", history, now: T0 });
    expect(d.action).toBe("budget-spent");
    if (d.action !== "budget-spent") throw new Error("unreachable");
    expect(d.history).toEqual(history);
    expect(d.reason).toBe(
      `no-snapshot: nothing recorded — auto-rebuild budget spent (${AUTO_REBUILD_BUDGET} in 24 h) — repo rebuild resets it`,
    );
    expect(d.reason).not.toMatch(/reopen/);
  });

  it("a rebuild older than the window no longer counts: the history is pruned before it is judged and before it is written back", () => {
    const history = [iso(T0 - AUTO_REBUILD_WINDOW_MS - 1), iso(T0 - 3 * HOUR)];
    const d = autoRebuildDecision({ reason: "no-snapshot: nothing recorded", history, now: T0 });
    expect(d.action).toBe("rebuild");
    if (d.action !== "rebuild") throw new Error("unreachable");
    expect(d.history).toEqual([iso(T0 - 3 * HOUR), iso(T0)]);
    expect(d.reason).toMatch(/^auto-rebuild \(2 of 2 in 24 h\): /);
  });

  it("a reason already stamped budget-spent is never judged again: the stamp is written once and the watchdog's passes leave it alone", () => {
    const spent = autoRebuildDecision({
      reason: "no-snapshot: nothing recorded",
      history: [iso(T0 - 2 * HOUR), iso(T0 - HOUR)],
      now: T0,
    });
    if (spent.action !== "budget-spent") throw new Error("unreachable");
    expect(isAutoRebuildEligible(spent.reason)).toBe(false);
    expect(autoRebuildDecision({ reason: spent.reason, history: [], now: T0 + HOUR })).toEqual({
      action: "not-eligible",
      why: "already-spent",
    });
  });

  it("malformed history entries are dropped, never counted and never rethrown", () => {
    const d = autoRebuildDecision({
      reason: "no-snapshot: nothing recorded",
      history: ["not a date", "", iso(T0 - HOUR)],
      now: T0,
    });
    expect(d.action).toBe("rebuild");
    if (d.action !== "rebuild") throw new Error("unreachable");
    expect(d.history).toEqual([iso(T0 - HOUR), iso(T0)]);
  });
});
