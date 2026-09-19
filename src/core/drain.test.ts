import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW_MS } from "../channels/slackCatchUp.js";
import {
  COLD_START_ALLOWANCE_MS,
  DRAIN_DEADLINE_MS,
  HANDOFF_BUDGET_MS,
  HELD_NOT_HANDED_OFF,
  MIN_CATCH_UP_WINDOW_MS,
  catchUpWindowWarning,
  createDrainDeadline,
  drainHoldLine,
  heldRunsText,
} from "./drain.js";

// Feature: docs/reference/specs/slack-channel.md item 7 — the reconnect catch-up window is
// the ONLY recovery for mentions posted while a deploy-time drain holds the
// socket closed, so it must cover the whole drain deadline plus a cold
// start. Lowering DEFAULT_WINDOW_MS below that is a silent blackout regression.
describe("catch-up window vs drain deadline", () => {
  it("the default window covers the drain deadline plus the cold-start allowance", () => {
    expect(MIN_CATCH_UP_WINDOW_MS).toBe(DRAIN_DEADLINE_MS + COLD_START_ALLOWANCE_MS);
    expect(DEFAULT_WINDOW_MS).toBeGreaterThanOrEqual(MIN_CATCH_UP_WINDOW_MS);
  });

  it("the deadline is the 15 min Cloudflare rollout grace and the default window is 30 min", () => {
    expect(DRAIN_DEADLINE_MS).toBe(15 * 60_000);
    expect(DEFAULT_WINDOW_MS).toBe(30 * 60_000);
  });
});

// Feature: docs/reference/specs/slack-channel.md item 8 — the drain deadline is the
// bound for a run that will not end, never the schedule: a draining bot whose
// held-run count reaches zero exits within the handoff grace, so the deploy's
// "waiting until live" shows 0 runs for seconds, not minutes.
describe("createDrainDeadline — the drain's wait bound collapses when the last held run ends", () => {
  const startedAt = 1_000_000;

  it("holds the full deadline while a run holds the drain", () => {
    const deadlineAt = createDrainDeadline(startedAt);
    expect(deadlineAt(startedAt, 1)).toBe(startedAt + DRAIN_DEADLINE_MS);
    expect(deadlineAt(startedAt + 60_000, 3)).toBe(startedAt + DRAIN_DEADLINE_MS);
  });

  it("drain begins with one run, the run ends: the bound collapses to the handoff grace from that moment, not the deadline", () => {
    const deadlineAt = createDrainDeadline(startedAt);
    expect(deadlineAt(startedAt, 1)).toBe(startedAt + DRAIN_DEADLINE_MS);
    const runEndedAt = startedAt + 17_000;
    expect(deadlineAt(runEndedAt, 0)).toBe(runEndedAt + HANDOFF_BUDGET_MS);
    expect(deadlineAt(runEndedAt, 0)).toBeLessThan(startedAt + DRAIN_DEADLINE_MS);
  });

  it("a drain that starts with nothing held gets the handoff grace at once", () => {
    const deadlineAt = createDrainDeadline(startedAt);
    expect(deadlineAt(startedAt, 0)).toBe(startedAt + HANDOFF_BUDGET_MS);
  });

  it("once collapsed the bound is fixed — later polls never extend it", () => {
    const deadlineAt = createDrainDeadline(startedAt);
    const collapsed = deadlineAt(startedAt + 5_000, 0);
    expect(deadlineAt(startedAt + 9_000, 0)).toBe(collapsed);
    expect(deadlineAt(startedAt + 9_000, 1)).toBe(collapsed);
  });

  it("the collapsed bound never reaches past the full deadline", () => {
    const deadlineAt = createDrainDeadline(startedAt);
    const nearDeadline = startedAt + DRAIN_DEADLINE_MS - 1_000;
    expect(deadlineAt(nearDeadline, 0)).toBe(startedAt + DRAIN_DEADLINE_MS);
  });
});

describe("catchUpWindowWarning (slack.catchUp.windowMinutes)", () => {
  it("is silent when unset (default applies) or at/above the safe minimum", () => {
    expect(catchUpWindowWarning(undefined)).toBeUndefined();
    expect(catchUpWindowWarning(20)).toBeUndefined();
    expect(catchUpWindowWarning(30)).toBeUndefined();
  });

  it("names the drain deadline and the minimum when the configured window is below it, without changing the value", () => {
    const w = catchUpWindowWarning(10);
    expect(w).toContain("10 min");
    expect(w).toContain("15 min drain deadline");
    expect(w).toContain("20 min");
  });

  it("calls out a non-positive or non-finite window as unusable", () => {
    expect(catchUpWindowWarning(0)).toContain("positive");
    expect(catchUpWindowWarning(-5)).toContain("positive");
    expect(catchUpWindowWarning(Number.NaN)).toContain("positive");
  });
});

// The drain's hold line (slack-channel.md item 8): the dispatcher's inFlight
// once read 0 while a ghost registry row held the drain for its full deadline,
// so the line names what is actually held — the registry-active run ids and
// why — never a count from another ledger.
describe("drainHoldLine", () => {
  it("names each registry-active run id and why it holds (not handed off)", () => {
    expect(
      drainHoldLine([
        { id: "slack:C1:1.1", why: HELD_NOT_HANDED_OFF },
        { id: "slack:C2:2.2", why: HELD_NOT_HANDED_OFF },
      ]),
    ).toBe(
      "[drain] holding for 2 registry-active run(s): slack:C1:1.1 (not handed off), slack:C2:2.2 (not handed off)",
    );
  });

  it("heldRunsText renders one `id (why)` per run, comma-separated", () => {
    expect(heldRunsText([{ id: "a", why: "not handed off" }])).toBe("a (not handed off)");
  });
});
