import { describe, expect, it } from "vitest";
import { createStatusBudget } from "./statusBudget.js";

// Feature: docs/reference/specs/run-visibility.md item 8 — one process-wide edit budget
// at Slack's published rate; progress frames stop at the terminal reserve, at
// each card's fair share and at the channel spacing; terminal frames reserve a
// slot and never wait behind progress traffic.

function budget(perMinute = 50, reserve?: number, channelSpacingMs = 0) {
  let t = 0;
  const b = createStatusBudget({
    perMinute,
    ...(reserve !== undefined ? { reserve } : {}),
    channelSpacingMs,
    now: () => t,
  });
  return { b, advance: (ms: number) => void (t += ms) };
}

describe("process budget", () => {
  it("progress frames draw the bucket down to the reserve and are then refused; a terminal frame still takes a token at once", () => {
    const { b } = budget(50, 10);
    let allowed = 0;
    while (b.tryProgress(`c${allowed}`, `ch${allowed}`)) allowed++; // fresh card and channel each time: only the bucket binds
    expect(allowed).toBe(40);
    expect(b.tokens()).toBe(10);
    expect(b.tryProgress("cx", "chx")).toBe(false);
    expect(b.takeTerminal("chx")).toBe(0);
    expect(b.tokens()).toBe(9);
  });

  it("the reserve defaults to a fifth of the rate", () => {
    const { b } = budget(50);
    let allowed = 0;
    while (b.tryProgress(`c${allowed}`, `ch${allowed}`)) allowed++;
    expect(allowed).toBe(40);
  });

  it("a terminal frame on an empty bucket reserves a token: the bucket goes negative and the caller is told when it is funded; progress frames yield meanwhile", () => {
    const { b, advance } = budget(5, 0); // 1 token every 12 s
    for (let i = 0; i < 5; i++) expect(b.tryProgress(`c${i}`, `ch${i}`)).toBe(true);
    expect(b.tokens()).toBe(0);
    expect(b.takeTerminal("t1")).toBe(12_000);
    expect(b.takeTerminal("t2")).toBe(24_000);
    expect(b.tokens()).toBe(-2);
    advance(12_000);
    expect(b.tryProgress("c9", "ch9")).toBe(false); // the refill funds the reservations first
    advance(24_000);
    expect(b.tokens()).toBe(1);
    expect(b.tryProgress("c9", "ch9")).toBe(true);
  });

  it("refills at the rate: 50 a minute is one token every 1.2 s, capped at the capacity", () => {
    const { b, advance } = budget(50, 10);
    let n = 0;
    while (b.tryProgress(`c${n}`, `ch${n}`)) n++;
    expect(b.tryProgress("cx", "chx")).toBe(false);
    advance(1_199);
    expect(b.tryProgress("cx", "chx")).toBe(false);
    advance(1);
    expect(b.tryProgress("cx", "chx")).toBe(true);
    advance(600_000);
    expect(b.tokens()).toBe(50);
  });

  it("fair share: a live card paints at most once per (live cards ÷ progress rate), so lockstep siblings all get a turn", () => {
    const { b, advance } = budget(50, 10); // progress rate 40/min → 4 cards: one edit per 6 s each
    for (const c of ["a", "b", "c", "d"]) b.open(c);
    expect(["a", "b", "c", "d"].map((c) => b.tryProgress(c, `ch-${c}`))).toEqual([true, true, true, true]);
    expect(b.tokens()).toBe(46); // tokens were there — the fair share, not the bucket, refuses the repeat
    expect(b.tryProgress("a", "ch-a")).toBe(false);
    advance(5_999);
    expect(b.tryProgress("a", "ch-a")).toBe(false);
    advance(1);
    expect(b.tryProgress("a", "ch-a")).toBe(true);
    // A card that closed frees its share: three live cards → one edit per 4.5 s.
    b.close("d");
    advance(4_500);
    expect(b.tryProgress("a", "ch-a")).toBe(true);
  });

  it("a card whose run died without close() stops asking and is swept out of the share after the live window; a card that keeps asking (even refused) stays", () => {
    const { b, advance } = budget(50, 10); // progress rate 40/min
    for (const c of ["a", "b", "c", "d"]) b.open(c);
    // Four live cards: a's share is one edit per 6 s.
    expect(b.tryProgress("a", "ch-a")).toBe(true);
    advance(5_999);
    expect(b.tryProgress("a", "ch-a")).toBe(false);
    // b, c, d never ask again (their runs crashed before done()); a keeps asking every 5 s.
    for (let i = 0; i < 13; i++) {
      advance(5_000);
      b.tryProgress("a", "ch-a");
    }
    // 60 s of silence swept the three: a alone → one edit per 1.5 s.
    advance(1_500);
    expect(b.tryProgress("a", "ch-a")).toBe(true);
    advance(1_499);
    expect(b.tryProgress("a", "ch-a")).toBe(false);
    advance(1);
    expect(b.tryProgress("a", "ch-a")).toBe(true);
  });

  it("a card never opened (or a lone card) is not held to a share — the coalescer's floor is the only pacing", () => {
    const { b } = budget(50, 10);
    expect(b.tryProgress("solo", "s1")).toBe(true);
    expect(b.tryProgress("solo", "s2")).toBe(true);
    b.open("one");
    expect(b.tryProgress("one", "o1")).toBe(true);
    expect(b.tryProgress("one", "o2")).toBe(false); // one live card: 1.5 s share — inside the 3 s coalescer floor in production
  });

  it("channel spacing: two cards in one channel never edit inside the same second; a terminal frame books the channel's next free second", () => {
    const { b, advance } = budget(600, 0, 1_000);
    expect(b.tryProgress("a", "C1")).toBe(true);
    expect(b.tryProgress("b", "C1")).toBe(false); // same channel, same instant
    expect(b.tryProgress("b", "C2")).toBe(true);
    advance(999);
    expect(b.tryProgress("b", "C1")).toBe(false);
    advance(1);
    expect(b.tryProgress("b", "C1")).toBe(true);
    // Three terminals in C1 at once: now, +1 s, +2 s — and a progress frame yields until the last has painted.
    advance(1_000);
    expect(b.takeTerminal("C1")).toBe(0);
    expect(b.takeTerminal("C1")).toBe(1_000);
    expect(b.takeTerminal("C1")).toBe(2_000);
    expect(b.tryProgress("a", "C1")).toBe(false);
    advance(2_999);
    expect(b.tryProgress("a", "C1")).toBe(false);
    advance(1);
    expect(b.tryProgress("a", "C1")).toBe(true);
  });

  it("a terminal wait is the later of the token's and the channel slot's", () => {
    const { b } = budget(5, 0, 1_000); // 1 token every 12 s
    for (let i = 0; i < 5; i++) b.tryProgress(`c${i}`, `ch${i}`);
    expect(b.takeTerminal("C1")).toBe(12_000); // the token is the constraint
    expect(b.takeTerminal("C1")).toBe(24_000); // the next token (13 s would clear the channel, 24 s the token)
  });

  it("a clock that goes backwards does not drain the bucket", () => {
    let t = 10_000;
    const b = createStatusBudget({ perMinute: 50, reserve: 0, now: () => t });
    b.tryProgress("c", "ch");
    t = 0;
    expect(b.tokens()).toBe(49);
  });
});
