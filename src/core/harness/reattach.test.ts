import { describe, expect, it } from "vitest";
import { HeldSends, PROMPT_ECHO_WAIT_MS, reattachBoundMessage } from "./reattach.js";

// Feature: docs/reference/specs/harness-pi.md item 16 — the one gate every write
// to pi takes after a re-attach left a prompt in doubt: while that prompt awaits
// its echo every later write is held behind it in the order it was sent, a
// second prompt in doubt is appended (never overwriting the first), and the
// gate moves on by the echo (landed, nothing to send) or the bound — measured
// on the harness's clock, never in loop ticks a streaming pi starves — so pi
// sees the order the loop sent.

const T0 = 1_700_000_000_000;
const P1 = { id: "p1", type: "prompt", message: "first" };
const P2 = { id: "p2", type: "prompt", message: "second" };
const S1 = { type: "steer", message: "S1" };
const S2 = { type: "steer", message: "S2" };

function gate() {
  const sent: Record<string, unknown>[] = [];
  const held = new HeldSends((command) => void sent.push(command));
  return { sent, held };
}

describe("HeldSends — the one gate every write to pi takes (harness-pi item 16)", () => {
  it("with no prompt in doubt a send goes out at once, and the clock passing is nothing", () => {
    const { sent, held } = gate();
    held.send(S1);
    held.tick(T0 + 10 * PROMPT_ECHO_WAIT_MS);
    held.send(S2);
    expect(sent).toEqual([S1, S2]);
    expect(held.holding).toBe(false);
  });

  it("while a prompt awaits its echo every send is held behind it in order; once the bound has elapsed on the clock the prompt is re-sent steer-delivered once and the held writes follow it", () => {
    const { sent, held } = gate();
    held.await(P1, T0);
    held.send(S1);
    held.send(S2);
    expect(held.holding).toBe(true);
    held.tick(T0 + PROMPT_ECHO_WAIT_MS - 1);
    expect(sent).toEqual([]); // within the bound: nothing moves, however many times the clock is read
    held.tick(T0 + PROMPT_ECHO_WAIT_MS - 1);
    expect(sent).toEqual([]);
    held.tick(T0 + PROMPT_ECHO_WAIT_MS);
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }, S1, S2]);
    expect(held.holding).toBe(false);
  });

  it("the bound is the clock, not a count: a burst of reads within the same instant never advances it, and a streaming pi that keeps the loop from ticking cannot stall the gate past the bound", () => {
    const { sent, held } = gate();
    held.await(P1, T0);
    for (let i = 0; i < 100; i++) held.tick(T0 + 1); // a hundred records in one millisecond: no time
    expect(sent).toEqual([]);
    held.tick(T0 + PROMPT_ECHO_WAIT_MS); // one read past the bound, no loop tick ever fired
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }]);
  });

  it("the echo of the awaited prompt means it landed: it is never re-sent, and the writes held behind it go out in order", () => {
    const { sent, held } = gate();
    held.await(P1, T0);
    held.send(S1);
    held.send(S2);
    held.echoed("p1", T0 + 500);
    expect(sent).toEqual([S1, S2]);
    expect(held.holding).toBe(false);
  });

  it("a second prompt in doubt is appended, never overwriting the first: awaited in its turn, its wait starting only once it is the head", () => {
    const { sent, held } = gate();
    held.await(P1, T0);
    held.send(S1);
    held.await(P2, T0 + 1_000);
    held.send(S2);
    held.tick(T0 + PROMPT_ECHO_WAIT_MS); // P1's bound: P1 re-sent, S1 released, P2 now the head
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }, S1]);
    expect(held.holding).toBe(true);
    held.tick(T0 + 2 * PROMPT_ECHO_WAIT_MS - 1); // P2's own bound counts from when it became the head
    expect(sent).toHaveLength(2);
    held.echoed("p2", T0 + 2 * PROMPT_ECHO_WAIT_MS - 1);
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }, S1, S2]);
    expect(held.holding).toBe(false);
  });

  it("the echo of a later prompt in doubt marks it landed where it stands: when the gate reaches it nothing is sent and the writes behind it go out", () => {
    const { sent, held } = gate();
    held.await(P1, T0);
    held.await(P2, T0);
    held.send(S2);
    held.echoed("p2", T0 + 100);
    expect(sent).toEqual([]); // P1 still holds the gate
    held.tick(T0 + PROMPT_ECHO_WAIT_MS);
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }, S2]); // P2 landed: never re-sent
    expect(held.holding).toBe(false);
  });

  it("sendNow passes the hold, not the chain: a gate reply sent while a prompt in doubt holds the gate is delivered at once (it answers an ask pi already made), never queued behind the prompt — and the turn content behind the prompt still waits", () => {
    const { sent, held } = gate();
    const reply = { id: "d1", type: "extension_ui_response", response: { confirmed: true } };
    held.await(P1, T0);
    held.send(S1);
    held.sendNow(reply);
    expect(sent).toEqual([reply]); // out at once, past the hold — through the same deliver as every other write
    expect(held.holding).toBe(true); // the prompt still awaits its echo; S1 still waits behind it
    held.echoed("p1", T0 + 10);
    expect(sent).toEqual([reply, S1]);
    // With nothing held, sendNow is send: delivered in its turn.
    held.sendNow(reply);
    expect(sent).toEqual([reply, S1, reply]);
    expect(held.holding).toBe(false);
  });

  it("two prompts in doubt back to back: the second's wait starts the moment the first's bound re-sends it and it becomes the head — never left with no clock, never re-sent at the first's bound", () => {
    const { sent, held } = gate();
    held.await(P1, T0);
    held.await(P2, T0); // adjacent: nothing between them for `release` to deliver
    held.tick(T0 + PROMPT_ECHO_WAIT_MS); // P1's bound: P1 re-sent; P2 is now the head, its wait starting here
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }]);
    expect(held.holding).toBe(true);
    held.tick(T0 + PROMPT_ECHO_WAIT_MS + 1); // P2's own bound has barely begun: nothing
    expect(sent).toHaveLength(1);
    held.tick(T0 + 2 * PROMPT_ECHO_WAIT_MS - 1);
    expect(sent).toHaveLength(1);
    held.tick(T0 + 2 * PROMPT_ECHO_WAIT_MS); // P2's bound, counted from when it became the head
    expect(sent).toEqual([
      { ...P1, streamingBehavior: "steer" },
      { ...P2, streamingBehavior: "steer" },
    ]);
    expect(held.holding).toBe(false);
  });

  it("dropHeld empties the gate without delivering: what a loop or turn still held when it ended — its prompt in doubt, the writes behind it — is gone, an onDelivered never fires, a later tick re-sends nothing, and the next send goes out at once", () => {
    const { sent, held } = gate();
    const delivered: string[] = [];
    held.await(P1, T0);
    held.send(S1, () => delivered.push("S1"));
    held.await(P2, T0);
    held.dropHeld();
    expect(held.holding).toBe(false);
    expect(sent).toEqual([]);
    held.tick(T0 + 2 * PROMPT_ECHO_WAIT_MS); // the dropped prompts' bounds are nobody's
    expect(sent).toEqual([]);
    held.send(S2);
    expect(sent).toEqual([S2]);
    expect(delivered).toEqual([]);
  });

  it("an echo under another id changes nothing", () => {
    const { sent, held } = gate();
    held.await(P1, T0);
    held.send(S1);
    held.echoed("state:x", T0 + 100);
    expect(sent).toEqual([]);
    expect(held.holding).toBe(true);
  });

  it("a send's onDelivered fires when the write actually leaves the gate — at once with no hold, or on the release — so a clock stamped there (the finale's) starts when pi got the steer, not when the loop asked", () => {
    const { sent, held } = gate();
    const delivered: string[] = [];
    held.send(S1, () => delivered.push("S1"));
    expect(delivered).toEqual(["S1"]);
    held.await(P1, T0);
    held.send(S2, () => delivered.push("S2"));
    expect(delivered).toEqual(["S1"]); // held: not yet
    held.echoed("p1", T0 + 10);
    expect(delivered).toEqual(["S1", "S2"]);
    expect(sent).toEqual([S1, S2]);
  });
});

describe("reattachBoundMessage — the bound names the harness's own process", () => {
  it("says which process answered alive: pi on the pi driver, OpenCode on the bridge — never pi in a container that runs opencode serve", () => {
    expect(reattachBoundMessage("word-alive", 8, "OpenCode")).toMatch(/while the row's OpenCode answered alive/);
    expect(reattachBoundMessage("word-alive", 8, "OpenCode")).toMatch(/never a relaunch beside a live OpenCode/);
    expect(reattachBoundMessage("word-alive", 8, "OpenCode")).not.toMatch(/\bpi\b/);
    expect(reattachBoundMessage("word-alive", 8, "pi")).toMatch(/while the row's pi answered alive/);
    expect(reattachBoundMessage("control-reset", 8, "pi")).toMatch(
      /^the resident's control plane reset under the run 8 times with no progress/,
    );
  });
});
