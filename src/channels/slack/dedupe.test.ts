import { describe, expect, it } from "vitest";
import { dedupeDelivery, STALE_DELIVERY_MS } from "./dedupe.js";

const BOT = "U0BOT";

// Feature: docs/reference/specs/slack-channel.md item 9 — Slack re-delivers an event whose
// original delivery was never acked (a deploy blackout), and a live path that
// runs it unconditionally double-runs it: a mention posted into a drain is
// answered by the reconnect catch-up within minutes, then RE-delivered ~6 min
// after it was posted and run again in full — a duplicate run and a duplicate
// answer in the thread. The guard drops that redelivery.
describe("dedupeDelivery (redelivery guard)", () => {
  /** In-memory handled-set standing in for the module's process-wide one. */
  function memState(seed: string[] = []) {
    const set = new Set(seed);
    return {
      was: (c: string, ts: string) => set.has(`${c}:${ts}`),
      mark: (c: string, ts: string) => void set.add(`${c}:${ts}`),
      set,
    };
  }
  /** A client whose conversations.replies answers one canned thread (or throws). */
  function repliesClient(thread: Array<{ ts: string; bot_id?: string; user?: string }> | Error) {
    const calls: Array<{ channel: string; ts: string }> = [];
    return {
      calls,
      conversations: {
        history: async () => ({}),
        replies: async (args: { channel: string; ts: string }) => {
          calls.push({ channel: args.channel, ts: args.ts });
          if (thread instanceof Error) throw thread;
          return { messages: thread };
        },
      },
    };
  }

  // A redelivery's real shape: posted at TS, re-delivered ~6 min later.
  const TS = "1788121551.504339"; // the mention, 20:25:51Z
  const REDELIVERY_MS = Date.UTC(2026, 7, 30, 20, 31, 57, 633); // the ghost delivery, 20:31:57Z
  const ev = { channel: "C1234567890", ts: TS, threadTs: TS, botUserId: BOT } as const;

  it("same-process redelivery (catch-up answered it, Slack re-delivered at +6 min) → dropped without any API call", async () => {
    const state = memState([`C1234567890:${TS}`]); // catch-up's handle() claimed it
    const client = repliesClient(new Error("must not be called"));
    await expect(dedupeDelivery(client, ev, REDELIVERY_MS, state)).resolves.toBe(
      "already handled in this process (a Slack redelivery)",
    );
    expect(client.calls).toHaveLength(0);
  });

  it("cross-process redelivery (the first handling died with the old container): stale + bot already replied in the thread → dropped after one replies fetch", async () => {
    const state = memState(); // fresh process: nothing handled here
    const client = repliesClient([
      { ts: TS, user: "UA" }, // the mention
      { ts: "1788121677.778409", bot_id: "B1" }, // ⏱ late-pickup note
      { ts: "1788121678.289369", bot_id: "B1" }, // status card
      { ts: "1788121716.609039", bot_id: "B1" }, // the answer
    ]);
    const drop = await dedupeDelivery(client, ev, REDELIVERY_MS, state);
    expect(drop).toMatch(
      /^already answered in its thread \(delivered 36\ds after it was posted — a Slack redelivery\)$/,
    );
    expect(client.calls).toEqual([{ channel: "C1234567890", ts: TS }]);
    // The pair is claimed either way — a third delivery is dropped by check 1.
    expect(state.was("C1234567890", TS)).toBe(true);
  });

  it("stale but UNANSWERED (the 👀-then-killed shape) → runs; bot messages before it don't count", async () => {
    const state = memState();
    const client = repliesClient([
      { ts: "1788121000.000000", bot_id: "B1" }, // bot spoke earlier in the thread
      { ts: TS, user: "UA" },
    ]);
    await expect(dedupeDelivery(client, ev, REDELIVERY_MS, state)).resolves.toBeNull();
  });

  it("fresh delivery (younger than STALE_DELIVERY_MS) → runs with no fetch; the second delivery of the same ts is then dropped", async () => {
    const state = memState();
    const client = repliesClient(new Error("must not be called"));
    const freshNow = Number(TS) * 1000 + STALE_DELIVERY_MS - 1;
    await expect(dedupeDelivery(client, ev, freshNow, state)).resolves.toBeNull();
    await expect(dedupeDelivery(client, ev, freshNow, state)).resolves.toBe(
      "already handled in this process (a Slack redelivery)",
    );
    expect(client.calls).toHaveLength(0);
  });

  it("fail-open: an unfetchable thread runs the event (a lost request is worse than a duplicate)", async () => {
    const state = memState();
    const client = repliesClient(new Error("ratelimited"));
    await expect(dedupeDelivery(client, ev, REDELIVERY_MS, state)).resolves.toBeNull();
    expect(client.calls).toHaveLength(1);
  });

  it("no botUserId → no Slack check (cannot judge authorship); a malformed ts never fetches", async () => {
    const state = memState();
    const client = repliesClient(new Error("must not be called"));
    await expect(dedupeDelivery(client, { ...ev, botUserId: undefined }, REDELIVERY_MS, state)).resolves.toBeNull();
    await expect(
      dedupeDelivery(client, { ...ev, ts: "not-a-ts", threadTs: "not-a-ts" }, REDELIVERY_MS, state),
    ).resolves.toBeNull();
    expect(client.calls).toHaveLength(0);
  });

  it("a catch-up replay skips both checks — the scan already judged it against Slack state — but still claims the pair", async () => {
    const state = memState([`C1234567890:${TS}`]);
    const client = repliesClient(new Error("must not be called"));
    await expect(dedupeDelivery(client, { ...ev, caughtUp: true }, REDELIVERY_MS, state)).resolves.toBeNull();
    expect(client.calls).toHaveLength(0);
    expect(state.was("C1234567890", TS)).toBe(true);
  });
});
