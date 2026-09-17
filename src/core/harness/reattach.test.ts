import { describe, expect, it } from "vitest";
import type { Landing } from "./pi/transport.js";
import { HeldSends, PROMPT_ECHO_WAIT_MS, reattachBoundMessage } from "./reattach.js";

// Feature: docs/reference/specs/harness-pi.md item 16 — the one gate every write
// to pi takes after a re-attach left a prompt in doubt: while that prompt awaits
// its echo every later write of turn content is held behind it in the order it
// was sent, a second prompt in doubt is appended (never overwriting the first),
// and the gate moves on by the echo (landed, nothing to send) or the bound —
// measured on the harness's clock on the iterations the feed is quiet, never in
// loop ticks a streaming pi starves and never while a catch-up burst is still
// being handed out — so pi sees the order the loop sent.

const T0 = 1_700_000_000_000;
const P1 = { id: "p1", type: "prompt", message: "first" };
const P2 = { id: "p2", type: "prompt", message: "second" };
const S1 = { type: "steer", message: "S1" };
const S2 = { type: "steer", message: "S2" };
const REPLY = { id: "d1", type: "extension_ui_response", response: { confirmed: true } };
const ABORT = { type: "abort" };

/** The gate over a transport whose every write lands, unless the test says otherwise per command. */
function gate(landing: (command: Record<string, unknown>) => Landing = () => "landed") {
  const sent: Record<string, unknown>[] = [];
  const held = new HeldSends((command) => {
    sent.push(command);
    return Promise.resolve(landing(command));
  });
  return { sent, held };
}
/** The transport's answer reaches the gate a microtask later. */
const landed = () => new Promise<void>((r) => setImmediate(r));

describe("HeldSends — the one gate every write to pi takes (harness-pi item 16)", () => {
  it("with no prompt in doubt a send goes out at once, and the clock passing is nothing", () => {
    const { sent, held } = gate();
    held.send(S1);
    held.quiet(T0 + 10 * PROMPT_ECHO_WAIT_MS);
    held.send(S2);
    expect(sent).toEqual([S1, S2]);
    expect(held.holding).toBe(false);
  });

  it("while a prompt awaits its echo every send is held behind it in order; once the bound has elapsed on the quiet clock the prompt is re-sent steer-delivered once and the held writes follow it", () => {
    const { sent, held } = gate();
    held.await(P1);
    held.send(S1);
    held.send(S2);
    expect(held.holding).toBe(true);
    held.quiet(T0); // the first quiet read: the clock starts here
    held.quiet(T0 + PROMPT_ECHO_WAIT_MS - 1);
    expect(sent).toEqual([]); // within the bound: nothing moves, however many times the clock is read
    held.quiet(T0 + PROMPT_ECHO_WAIT_MS - 1);
    expect(sent).toEqual([]);
    held.quiet(T0 + PROMPT_ECHO_WAIT_MS);
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }, S1, S2]);
    expect(held.holding).toBe(false);
  });

  it("the awaited head's clock starts at the first QUIET read after it became the head, not when it was awaited: time before the feed goes quiet is nothing", () => {
    const { sent, held } = gate();
    held.await(P1);
    // Records still arriving for a whole bound: the loop never reads the clock.
    held.quiet(T0 + PROMPT_ECHO_WAIT_MS); // the first quiet read, a bound later: the clock starts only now
    expect(sent).toEqual([]);
    held.quiet(T0 + 2 * PROMPT_ECHO_WAIT_MS - 1);
    expect(sent).toEqual([]);
    held.quiet(T0 + 2 * PROMPT_ECHO_WAIT_MS);
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }]);
  });

  it("a catch-up burst is no time under a ticking clock: records arriving for longer than the bound never advance the awaited head's clock, so the echo late in the burst lands the prompt and nothing is re-sent — and a burst with no echo re-sends it once the feed is quiet", () => {
    const { sent, held } = gate();
    held.await(P1);
    held.send(S1);
    held.quiet(T0); // quiet once: the clock starts
    // A burst under a slow mirror: five seconds of records, the loop reading no
    // clock while they are still being handed out; the echo is the last record.
    held.echoed("p1");
    expect(sent).toEqual([S1]); // landed: S1 released, P1 never re-sent
    held.quiet(T0 + 5_000); // the feed quiet again, past the bound: nothing to judge
    expect(sent).toEqual([S1]);

    const noEcho = gate();
    noEcho.held.await(P1);
    noEcho.held.quiet(T0);
    noEcho.held.quiet(T0 + 5_000); // a burst carrying no echo, then quiet: pi never had the prompt
    expect(noEcho.sent).toEqual([{ ...P1, streamingBehavior: "steer" }]);
  });

  it("the bound is the clock, not a count: a burst of quiet reads within the same instant never advances it, and a streaming pi that keeps the loop from ticking cannot stall the gate past the bound", () => {
    const { sent, held } = gate();
    held.await(P1);
    held.quiet(T0);
    for (let i = 0; i < 100; i++) held.quiet(T0 + 1); // a hundred records in one millisecond: no time
    expect(sent).toEqual([]);
    held.quiet(T0 + PROMPT_ECHO_WAIT_MS); // one quiet read past the bound, no loop tick ever fired
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }]);
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

  it("a second prompt in doubt is appended, never overwriting the first: awaited in its turn, its clock starting only once it is the head and the feed is quiet", () => {
    const { sent, held } = gate();
    held.await(P1);
    held.send(S1);
    held.await(P2);
    held.send(S2);
    held.quiet(T0);
    held.quiet(T0 + PROMPT_ECHO_WAIT_MS); // P1's bound: P1 re-sent, S1 released, P2 now the head — its clock starts here, the feed being quiet
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }, S1]);
    expect(held.holding).toBe(true);
    held.quiet(T0 + 2 * PROMPT_ECHO_WAIT_MS - 1); // P2's own bound counts from when it became the head
    expect(sent).toHaveLength(2);
    held.echoed("p2");
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }, S1, S2]);
    expect(held.holding).toBe(false);
  });

  it("the echo of a later prompt in doubt marks it landed where it stands: when the gate reaches it nothing is sent and the writes behind it go out — and the head keeps the clock it has", () => {
    const { sent, held } = gate();
    held.await(P1);
    held.await(P2);
    held.send(S2);
    held.quiet(T0);
    held.echoed("p2");
    expect(sent).toEqual([]); // P1 still holds the gate
    held.quiet(T0 + PROMPT_ECHO_WAIT_MS); // P1's clock ran from T0: the later echo was no reason to wait longer
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }, S2]); // P2 landed: never re-sent
    expect(held.holding).toBe(false);
  });

  it("a gate reply and an abort pass the hold inside send itself, by their types — the reply answers an ask pi already made, the abort is a stop the bound must not outwait — while the turn content behind the prompt still waits; with nothing held they are delivered in their turn", () => {
    const { sent, held } = gate();
    held.await(P1);
    held.send(S1);
    held.send(REPLY);
    held.send(ABORT);
    expect(sent).toEqual([REPLY, ABORT]); // out at once, past the hold — through the same deliver as every other write
    expect(held.holding).toBe(true); // the prompt still awaits its echo; S1 still waits behind it
    held.echoed("p1");
    expect(sent).toEqual([REPLY, ABORT, S1]);
    held.send(REPLY);
    held.send(ABORT);
    expect(sent).toEqual([REPLY, ABORT, S1, REPLY, ABORT]);
    expect(held.holding).toBe(false);
  });

  it("two prompts in doubt back to back: the second's clock starts the moment the first's bound re-sends it and it becomes the head (the feed is quiet then) — never left with no clock, never re-sent at the first's bound", () => {
    const { sent, held } = gate();
    held.await(P1);
    held.await(P2); // adjacent: nothing between them for `release` to deliver
    held.quiet(T0);
    held.quiet(T0 + PROMPT_ECHO_WAIT_MS); // P1's bound: P1 re-sent; P2 is now the head, its clock starting here
    expect(sent).toEqual([{ ...P1, streamingBehavior: "steer" }]);
    expect(held.holding).toBe(true);
    held.quiet(T0 + PROMPT_ECHO_WAIT_MS + 1); // P2's own bound has barely begun: nothing
    expect(sent).toHaveLength(1);
    held.quiet(T0 + 2 * PROMPT_ECHO_WAIT_MS - 1);
    expect(sent).toHaveLength(1);
    held.quiet(T0 + 2 * PROMPT_ECHO_WAIT_MS); // P2's bound, counted from when it became the head
    expect(sent).toEqual([
      { ...P1, streamingBehavior: "steer" },
      { ...P2, streamingBehavior: "steer" },
    ]);
    expect(held.holding).toBe(false);
  });

  it("dropHeld empties the gate without delivering and answers what it dropped: what a loop or turn still held when it ended — its prompt in doubt, the writes behind it — is gone, an onLanded never fires, a later quiet read re-sends nothing, and the next send goes out at once", async () => {
    const { sent, held } = gate();
    const landedOnes: string[] = [];
    held.await(P1);
    held.send(S1, () => landedOnes.push("S1"));
    held.await(P2);
    expect(held.dropHeld()).toEqual([P1, S1, P2]);
    expect(held.holding).toBe(false);
    expect(sent).toEqual([]);
    held.quiet(T0);
    held.quiet(T0 + 2 * PROMPT_ECHO_WAIT_MS); // the dropped prompts' bounds are nobody's
    expect(sent).toEqual([]);
    held.send(S2);
    expect(sent).toEqual([S2]);
    await landed();
    expect(landedOnes).toEqual([]);
    expect(held.dropHeld()).toEqual([]);
  });

  it("dropHeld forgets the callback of a write in flight too: the loop or turn that sent it has ended, so its landing — however late, whatever it is — runs nothing, while a send after the drop is heard as before", async () => {
    const settles: ((landing: Landing) => void)[] = [];
    const landings: string[] = [];
    const held = new HeldSends(() => new Promise<Landing>((r) => settles.push(r)));
    held.send(S1, (landing) => landings.push(`S1:${landing}`)); // dispatched at once: in flight, not held
    expect(held.dropHeld()).toEqual([]); // nothing held — but the in-flight write's sender has ended
    settles[0]("failed"); // its landing comes after the loop ended: nobody's
    await landed();
    expect(landings).toEqual([]);
    held.send(S2, (landing) => landings.push(`S2:${landing}`));
    settles[1]("landed");
    await landed();
    expect(landings).toEqual(["S2:landed"]);
  });

  it("a re-asked abort passes the hold ahead of an awaited prompt and the writes held behind it: the loop's tick asking again for a stop whose write the reset failed, under an await-echo resolution, the abort — a stop — is dispatched at once while the prompt in doubt and its followers stay held", () => {
    const { sent, held } = gate();
    held.await(P1); // the prompt in doubt holds the gate
    held.send(S1); // an unsent steer, held behind P1
    held.send(ABORT); // the tick's re-ask
    expect(sent).toEqual([ABORT]); // the stop reaches pi at once, ahead of P1 and S1
    expect(held.holding).toBe(true); // P1 still awaits its echo; S1 still behind it
  });

  it("dropHeld keeps an abort's callback alone: a stop in flight when the loop or turn ended is the one landing it still wants on the record, so its landing — failed or landed — still runs after the drop, while a steer's in flight is forgotten as before", async () => {
    const settles: ((landing: Landing) => void)[] = [];
    const landings: string[] = [];
    const held = new HeldSends(() => new Promise<Landing>((r) => settles.push(r)));
    held.send(S1, (landing) => landings.push(`S1:${landing}`)); // the steer, in flight
    held.send(ABORT, (landing) => landings.push(`abort:${landing}`)); // the stop, in flight behind it
    expect(held.dropHeld()).toEqual([]); // nothing held; both in flight when the loop ended
    settles[0]("landed"); // the steer's landing: nobody's
    settles[1]("failed"); // the stop's: still heard, so a swallowed stop is seen
    await landed();
    expect(landings).toEqual(["abort:failed"]);
  });

  it("an echo under another id changes nothing", () => {
    const { sent, held } = gate();
    held.await(P1);
    held.send(S1);
    held.quiet(T0);
    held.echoed("state:x");
    expect(sent).toEqual([]);
    expect(held.holding).toBe(true);
  });

  it("a send's onLanded fires when the write has LANDED at the transport — at once with no hold, on the release, or when it failed with the reset — never at the hand-off to a chain that only holds it: a `held` landing keeps the callback for the re-send of the same object, so a clock stamped there (the finale's) starts when pi has the steer", async () => {
    const landings = new Map<Record<string, unknown>, Landing>();
    const { sent, held } = gate((command) => landings.get(command) ?? "landed");
    const landedOnes: string[] = [];
    held.send(S1, () => landedOnes.push("S1"));
    await landed();
    expect(landedOnes).toEqual(["S1"]);
    held.await(P1);
    held.send(S2, () => landedOnes.push("S2"));
    await landed();
    expect(landedOnes).toEqual(["S1"]); // held behind P1: not yet
    held.echoed("p1");
    await landed();
    expect(landedOnes).toEqual(["S1", "S2"]);
    expect(sent).toEqual([S1, S2]);

    // A spent chain: the transport only holds the steer for the re-attach
    // (`held`), so nothing is stamped; the fresh transport re-sends the very
    // object through `send` — no callback given, the kept one runs at landing.
    const wrapUp = { type: "steer", message: "wrap up" };
    landings.set(wrapUp, "held");
    held.send(wrapUp, (landing) => landedOnes.push(`wrapUp:${landing}`));
    await landed();
    expect(landedOnes).toEqual(["S1", "S2"]);
    landings.set(wrapUp, "landed");
    held.send(wrapUp);
    await landed();
    expect(landedOnes).toEqual(["S1", "S2", "wrapUp:landed"]);

    // A write that FAILED with the reset settled too, and the callback is told
    // so: the sender decides what a failed wrap-up means (harness-pi item 16:
    // no clock, asked again), never the gate.
    const lost = { type: "steer", message: "lost" };
    landings.set(lost, "failed");
    held.send(lost, (landing) => landedOnes.push(`lost:${landing}`));
    await landed();
    expect(landedOnes).toEqual(["S1", "S2", "wrapUp:landed", "lost:failed"]);

    // A write nothing kept (`dropped`: a closed transport) is over too, and the
    // callback is told so — a clock or a label waiting on it gives up now
    // rather than for ever; the callback is not kept, so a later send of the
    // same object runs nothing.
    const gone = { type: "steer", message: "gone" };
    landings.set(gone, "dropped");
    held.send(gone, (landing) => landedOnes.push(`gone:${landing}`));
    await landed();
    expect(landedOnes).toEqual(["S1", "S2", "wrapUp:landed", "lost:failed", "gone:dropped"]);
    landings.set(gone, "landed");
    held.send(gone);
    await landed();
    expect(landedOnes).toEqual(["S1", "S2", "wrapUp:landed", "lost:failed", "gone:dropped"]);
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
