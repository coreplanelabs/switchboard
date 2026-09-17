import { describe, expect, it } from "vitest";
import { HeldSends, PROMPT_ECHO_WAIT_TICKS, reattachBoundMessage } from "./reattach.js";

// Feature: docs/reference/specs/harness-pi.md item 16 — the one gate every write
// to pi takes after a re-attach left a prompt in doubt: while that prompt awaits
// its echo every later write is held behind it in the order it was sent, a
// second prompt in doubt is appended (never overwriting the first), and the
// gate moves on by the echo (landed, nothing to send) or the bound (re-sent
// steer-delivered once) — so pi sees the order the loop sent.

const P1 = { id: "p1", type: "prompt", message: "first" };
const P2 = { id: "p2", type: "prompt", message: "second" };
const S1 = { type: "steer", message: "S1" };
const S2 = { type: "steer", message: "S2" };

function gate() {
  const sent: Record<string, unknown>[] = [];
  const held = new HeldSends((command) => void sent.push(command));
  return { sent, held };
}
const ticks = (held: HeldSends, n: number) => {
  for (let i = 0; i < n; i++) held.tick();
};

describe("HeldSends — the one gate every write to pi takes (harness-pi item 16)", () => {
  it("with no prompt in doubt a send goes out at once, and a tick is nothing", () => {
    const { sent, held } = gate();
    held.send(S1);
    held.tick();
    held.send(S2);
    expect(sent).toEqual([S1, S2]);
    expect(held.holding).toBe(false);
  });

  it("while a prompt awaits its echo every send is held behind it in order; past the bound of ticks the prompt is re-sent steer-delivered once and the held writes follow it", () => {
    const { sent, held } = gate();
    held.await(P1);
    held.send(S1);
    held.send(S2);
    expect(held.holding).toBe(true);
    ticks(held, PROMPT_ECHO_WAIT_TICKS);
    expect(sent).toEqual([]); // within the bound: nothing moves
    held.tick();
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }, S1, S2]);
    expect(held.holding).toBe(false);
  });

  it("the echo of the awaited prompt means it landed: it is never re-sent, and the writes held behind it go out in order", () => {
    const { sent, held } = gate();
    held.await(P1);
    held.send(S1);
    held.send(S2);
    held.echoed("p1");
    expect(sent).toEqual([S1, S2]);
    expect(held.holding).toBe(false);
  });

  it("a second prompt in doubt is appended, never overwriting the first: awaited in its turn, its wait starting only once it is the head", () => {
    const { sent, held } = gate();
    held.await(P1);
    held.send(S1);
    held.await(P2);
    held.send(S2);
    ticks(held, PROMPT_ECHO_WAIT_TICKS + 1); // P1's bound: P1 re-sent, S1 released, P2 now awaited
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }, S1]);
    expect(held.holding).toBe(true);
    ticks(held, PROMPT_ECHO_WAIT_TICKS); // P2's own wait, counted from when it became the head
    expect(sent).toHaveLength(2);
    held.echoed("p2");
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }, S1, S2]);
    expect(held.holding).toBe(false);
  });

  it("the echo of a later prompt in doubt marks it landed where it stands: when the gate reaches it nothing is sent and the writes behind it go out", () => {
    const { sent, held } = gate();
    held.await(P1);
    held.await(P2);
    held.send(S2);
    held.echoed("p2");
    expect(sent).toEqual([]); // P1 still holds the gate
    ticks(held, PROMPT_ECHO_WAIT_TICKS + 1);
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }, S2]); // P2 landed: never re-sent
    expect(held.holding).toBe(false);
  });

  it("an echo under another id changes nothing", () => {
    const { sent, held } = gate();
    held.await(P1);
    held.send(S1);
    held.echoed("state:x");
    expect(sent).toEqual([]);
    expect(held.holding).toBe(true);
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
