import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerTakeover } from "./takeover.js";

// Feature: docs/reference/specs/harness-pi.md item 7 — what the harness door
// reads of this generation's takeover of the ledger's live runs: whether the
// boot reclaim has listed the ledger yet, and which runs are still on their
// way back (handed to the launcher and not yet ended, or held by another
// generation until the sweep takes them).

afterEach(() => vi.useRealTimers());

const outcome = (resumable: string[], liveElsewhere: string[] = []) => ({
  resumable: resumable.map((runId) => ({ row: { runId } })),
  liveElsewhere: liveElsewhere.map((runId) => ({ runId })),
});

describe("LedgerTakeover — the ledger's live runs this generation has not finished taking over (harness-pi item 7)", () => {
  it("is unsettled until the boot reclaim's outcome is taken (or settle() says there is no ledger); whenSettled resolves true then, and false when its bound elapses first", async () => {
    vi.useFakeTimers();
    const t = new LedgerTakeover();
    expect(t.settled).toBe(false);
    const late = t.whenSettled(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await late).toBe(false);
    expect(t.settled).toBe(false);
    const inTime = t.whenSettled(1_000);
    await vi.advanceTimersByTimeAsync(300);
    t.take(outcome([]));
    expect(await inTime).toBe(true);
    expect(t.settled).toBe(true);
    // Settled already: answered at once, no timer left behind.
    expect(await t.whenSettled(1_000)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const none = new LedgerTakeover();
    none.settle();
    expect(none.settled).toBe(true);
  });

  it("a run the reclaim handed to the launcher is pending until done() says its resume ended; a run held by another generation is pending while the latest listing names it", () => {
    const t = new LedgerTakeover();
    expect(t.pending("r1")).toBe(false);
    t.take(outcome(["r1", "r2"], ["r3"]));
    expect(t.pending("r1")).toBe(true);
    expect(t.pending("r2")).toBe(true);
    expect(t.pending("r3")).toBe(true);
    expect(t.pending("r9")).toBe(false);
    t.done("r1");
    expect(t.pending("r1")).toBe(false);
    expect(t.pending("r2")).toBe(true);
    // The sweep's next listing: r3 is now ours and launched, r4 is live elsewhere; r2's resume still runs.
    t.take(outcome(["r3"], ["r4"]));
    expect(t.pending("r2")).toBe(true);
    expect(t.pending("r3")).toBe(true);
    expect(t.pending("r4")).toBe(true);
    // A listing that no longer names a run elsewhere (the other generation finished it) drops it.
    t.take(outcome([], []));
    expect(t.pending("r4")).toBe(false);
    expect(t.pending("r3")).toBe(true);
    t.done("r3");
    t.done("r2");
    expect(t.pending("r2")).toBe(false);
    expect(t.pending("r3")).toBe(false);
    // done() for a run never taken is a no-op.
    t.done("r9");
    expect(t.pending("r9")).toBe(false);
  });
});
