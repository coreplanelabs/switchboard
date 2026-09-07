import { describe, expect, it, vi } from "vitest";
import {
  ACK_GRACE_MS,
  catchUpMissedMentions,
  findMissed,
  findOrphanedCards,
  interruptedCardFrame,
  isAckedByBot,
  ORPHAN_CARD_WINDOW_MS,
  type CatchUpClient,
  type SlackHistoryMessage,
} from "./slackCatchUp.js";

// Feature: features/slack-channel.md item 7 — mentions that land while the
// Socket Mode websocket is down (bot rollover) are caught up from channel
// history on (re)connect, never run twice.

const BOT = "U0BOT";
const NOW = 1_788_040_800_000; // 2026-08-29T22:00:00Z
const ts = (secondsAgo: number, frac = "000100") => `${Math.floor(NOW / 1000) - secondsAgo}.${frac}`;
const mention = (over: Partial<SlackHistoryMessage> = {}): SlackHistoryMessage & { ts: string } => ({
  type: "message",
  user: "U0USER",
  text: `<@${BOT}> agent:review https://github.com/o/r/pull/180`,
  ts: ts(60),
  ...over,
});

describe("isAckedByBot", () => {
  it("true only when the bot's own 👀 is on the message", () => {
    expect(isAckedByBot(mention({ reactions: [{ name: "eyes", users: ["U0OTHER", BOT], count: 2 }] }), BOT)).toBe(true);
    expect(isAckedByBot(mention({ reactions: [{ name: "eyes", users: ["U0OTHER"], count: 1 }] }), BOT)).toBe(false);
    expect(isAckedByBot(mention({ reactions: [{ name: "thumbsup", users: [BOT], count: 1 }] }), BOT)).toBe(false);
    expect(isAckedByBot(mention(), BOT)).toBe(false);
  });
});

describe("findMissed (pure selection over fetched history)", () => {
  const cutoff = NOW - 20 * 60_000;
  const base = { botUserId: BOT, cutoffMs: cutoff, nowMs: NOW, alreadyHandled: () => false };

  it("picks an un-acked top-level mention inside the window, threaded to itself", () => {
    const m = mention();
    const out = findMissed({ ...base, channel: "C1", parents: [m], threads: new Map() });
    expect(out).toEqual([{ channel: "C1", user: "U0USER", text: m.text, ts: m.ts, threadTs: m.ts, files: undefined }]);
  });

  it("skips a 👀-acked mention younger than ACK_GRACE_MS — its card is on the way", () => {
    const m = mention({ ts: ts(ACK_GRACE_MS / 1000 - 1), reactions: [{ name: "eyes", users: [BOT], count: 1 }] });
    expect(findMissed({ ...base, channel: "C1", parents: [m], threads: new Map() })).toEqual([]);
  });

  // #317 (2026-08-30 16:33Z): the process acked a thread reply, a deploy
  // rollover killed it 8 s later — before the status card — and the next
  // process's scan skipped the reply as "acked". 👀 alone is not "handled".
  it("re-runs a 👀-acked message older than ACK_GRACE_MS when the bot never replied after it (#317)", () => {
    const parent = mention({ ts: ts(ACK_GRACE_MS / 1000 + 1), reactions: [{ name: "eyes", users: [BOT], count: 1 }] });
    expect(findMissed({ ...base, channel: "C1", parents: [parent], threads: new Map() }).map((x) => x.ts)).toEqual([
      parent.ts,
    ]);

    const root = mention({ ts: ts(800), reactions: [{ name: "eyes", users: [BOT], count: 1 }] });
    const rootCard = {
      type: "message",
      user: BOT,
      bot_id: "B1",
      text: "✅ coding · 4s",
      ts: ts(799),
      thread_ts: root.ts,
    };
    const follow = mention({
      ts: ts(31),
      thread_ts: root.ts,
      text: `<@${BOT}> run git remote -v`,
      reactions: [{ name: "eyes", users: [BOT], count: 1 }],
    });
    const threads = new Map([[root.ts, [root, rootCard, follow]]]);
    expect(findMissed({ ...base, channel: "C1", parents: [root], threads }).map((x) => x.ts)).toEqual([follow.ts]);
  });

  it("skips a 👀-acked message of any age once the bot replied after it", () => {
    const m = mention({ ts: ts(800), reactions: [{ name: "eyes", users: [BOT], count: 1 }] });
    const threads = new Map([
      [m.ts, [m, { type: "message", user: BOT, bot_id: "B1", text: "✅ done", ts: ts(790), thread_ts: m.ts }]],
    ]);
    expect(findMissed({ ...base, channel: "C1", parents: [m], threads })).toEqual([]);
  });

  it("skips a mention the bot already replied to in-thread (ack lost, but a status card/reply exists)", () => {
    const m = mention({ reply_count: 1, latest_reply: ts(30) });
    const threads = new Map([
      [m.ts, [m, { type: "message", user: BOT, bot_id: "B1", text: "⏳ working", ts: ts(30), thread_ts: m.ts }]],
    ]);
    expect(findMissed({ ...base, channel: "C1", parents: [m], threads })).toEqual([]);
  });

  it("does NOT treat a human's reply as the bot having handled it (and the bump itself is a missed follow-up, as live)", () => {
    const m = mention({ reply_count: 1, latest_reply: ts(30) });
    const bump = { type: "message", user: "U0OTHER", text: "bump", ts: ts(30), thread_ts: m.ts };
    const threads = new Map([[m.ts, [m, bump]]]);
    expect(findMissed({ ...base, channel: "C1", parents: [m], threads }).map((x) => x.ts)).toEqual([m.ts, bump.ts]);
  });

  it("ignores top-level messages older than the window, without a mention, from bots, or subtyped", () => {
    const parents: SlackHistoryMessage[] = [
      mention({ ts: ts(30 * 60) }), // too old
      mention({ text: "no mention here" }),
      mention({ bot_id: "B9", user: BOT }),
      mention({ subtype: "channel_join" }),
    ];
    expect(findMissed({ ...base, channel: "C1", parents, threads: new Map() })).toEqual([]);
  });

  it("keeps file_share mentions and carries the files through", () => {
    const files = [{ id: "F1", name: "a.png", mimetype: "image/png" }];
    const m = mention({ subtype: "file_share", files });
    const out = findMissed({ ...base, channel: "C1", parents: [m], threads: new Map() });
    expect(out[0]?.files).toBe(files);
  });

  it("skips messages this process already handled live (same-process dedupe)", () => {
    const m = mention();
    const out = findMissed({
      ...base,
      channel: "C1",
      parents: [m],
      threads: new Map(),
      alreadyHandled: (channel, t) => channel === "C1" && t === m.ts,
    });
    expect(out).toEqual([]);
  });

  it("picks an un-acked in-thread mention (a rereview follow-up) even when the parent is old", () => {
    const parent = mention({ ts: ts(3 * 86_400), reply_count: 3, latest_reply: ts(45) });
    const follow = mention({ ts: ts(45), thread_ts: parent.ts, text: `<@${BOT}> please re-review` });
    const threads = new Map([
      [
        parent.ts,
        [parent, { ...mention({ ts: ts(3000), thread_ts: parent.ts, user: BOT, bot_id: "B1", text: "done" }) }, follow],
      ],
    ]);
    const out = findMissed({ ...base, channel: "C1", parents: [parent], threads });
    expect(out).toEqual([
      { channel: "C1", user: "U0USER", text: follow.text, ts: follow.ts, threadTs: parent.ts, files: undefined },
    ]);
  });

  it("picks an un-acked, un-mentioned follow-up in a thread the bot participates in (live trigger 1c)", () => {
    const parent = mention({ ts: ts(3000), reply_count: 2, latest_reply: ts(40) });
    const botReply = {
      type: "message",
      user: BOT,
      bot_id: "B1",
      text: "here you go",
      ts: ts(2000),
      thread_ts: parent.ts,
    };
    const follow = {
      type: "message",
      user: "U0USER",
      text: "and now do the other thing",
      ts: ts(40),
      thread_ts: parent.ts,
    };
    const threads = new Map([[parent.ts, [parent, botReply, follow]]]);
    const out = findMissed({ ...base, channel: "C1", parents: [parent], threads });
    expect(out.map((m) => m.ts)).toEqual([follow.ts]);
  });

  it("ignores an un-mentioned follow-up in a thread the bot is NOT part of", () => {
    const parent = {
      type: "message",
      user: "U0A",
      text: "chatting",
      ts: ts(3000),
      reply_count: 1,
      latest_reply: ts(40),
    };
    const follow = { type: "message", user: "U0B", text: "yep", ts: ts(40), thread_ts: parent.ts };
    const threads = new Map([[parent.ts, [parent, follow]]]);
    expect(findMissed({ ...base, channel: "C1", parents: [parent], threads })).toEqual([]);
  });

  it("skips a thread reply the bot answered after it, and one from the bot itself", () => {
    const parent = mention({ ts: ts(3000), reply_count: 3, latest_reply: ts(10) });
    const follow = mention({ ts: ts(40), thread_ts: parent.ts, text: `<@${BOT}> again` });
    const botAfter = { type: "message", user: BOT, bot_id: "B1", text: "✅ done", ts: ts(10), thread_ts: parent.ts };
    const threads = new Map([[parent.ts, [parent, follow, botAfter]]]);
    expect(findMissed({ ...base, channel: "C1", parents: [parent], threads })).toEqual([]);
  });

  it("returns missed messages oldest-first across parents and threads", () => {
    const p1 = mention({ ts: ts(50, "000001") });
    const p2 = mention({ ts: ts(120, "000001"), reply_count: 1, latest_reply: ts(20) });
    const follow = mention({ ts: ts(20), thread_ts: p2.ts });
    const threads = new Map([[p2.ts, [p2, follow]]]);
    const out = findMissed({ ...base, channel: "C1", parents: [p1, p2], threads });
    expect(out.map((m) => m.ts)).toEqual([p2.ts, p1.ts, follow.ts]);
  });
});

function mockClient(
  over: {
    channels?: Array<{ id: string }>;
    history?: Record<string, SlackHistoryMessage[]>;
    replies?: Record<string, SlackHistoryMessage[]>;
    historyError?: string;
  } = {},
) {
  const history = over.history ?? {};
  const replies = over.replies ?? {};
  const client = {
    users: {
      conversations: vi.fn(async () => ({ channels: over.channels ?? [{ id: "C1" }], response_metadata: {} })),
    },
    conversations: {
      history: vi.fn(async ({ channel }: { channel: string }) => {
        if (over.historyError) throw new Error(over.historyError);
        return { messages: history[channel] ?? [], response_metadata: {} };
      }),
      replies: vi.fn(async ({ channel, ts: t }: { channel: string; ts: string }) => ({
        messages: replies[`${channel}:${t}`] ?? [],
        response_metadata: {},
      })),
    },
  };
  return client as typeof client & CatchUpClient;
}

describe("catchUpMissedMentions (runner over the Slack Web API)", () => {
  it("scans every channel the bot is in and re-dispatches un-acked mentions, oldest first", async () => {
    const a = mention({ ts: ts(70) });
    const b = mention({ ts: ts(10), reactions: [{ name: "eyes", users: [BOT], count: 1 }] }); // acked 10 s ago: card on the way
    const c = mention({ ts: ts(90) });
    const client = mockClient({ channels: [{ id: "C1" }, { id: "C2" }], history: { C1: [b, a], C2: [c] } });
    const onMissed = vi.fn();
    const log = vi.fn();
    const out = await catchUpMissedMentions({
      client,
      botUserId: BOT,
      now: NOW,
      alreadyHandled: () => false,
      onMissed,
      log,
    });
    expect(out).toEqual({ channels: 2, missed: 2, orphans: 0, skippedChannels: 0 });
    expect(onMissed.mock.calls.map(([m]) => [m.channel, m.ts])).toEqual([
      ["C1", a.ts],
      ["C2", c.ts],
    ]);
    expect(client.users.conversations).toHaveBeenCalledWith(
      expect.objectContaining({ types: "public_channel,private_channel", exclude_archived: true }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("2 missed"));
  });

  it("scans channels concurrently (bounded), and still re-dispatches in channel order", async () => {
    const channels = [{ id: "C1" }, { id: "C2" }, { id: "C3" }];
    const hits = { C1: mention({ ts: ts(10) }), C2: mention({ ts: ts(20) }), C3: mention({ ts: ts(30) }) };
    const client = mockClient({ channels, history: { C1: [hits.C1], C2: [hits.C2], C3: [hits.C3] } });
    let inFlight = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    client.conversations.history.mockImplementation(async ({ channel }: { channel: string }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => gates.push(r));
      inFlight--;
      return { messages: [hits[channel as keyof typeof hits]], response_metadata: { next_cursor: "" } };
    });
    const onMissed = vi.fn();
    const p = catchUpMissedMentions({ client, botUserId: BOT, now: NOW, alreadyHandled: () => false, onMissed });
    await new Promise((r) => setTimeout(r, 0));
    expect(inFlight).toBe(3); // all three channel scans in flight before any history page came back
    // Resolve out of order: C3 first, then C1, then C2 — dispatch order must not follow it.
    gates
      .splice(0)
      .reverse()
      .forEach((r) => r());
    const out = await p;
    expect(peak).toBe(3);
    expect(out).toMatchObject({ channels: 3, missed: 3 });
    expect(onMissed.mock.calls.map(([m]) => m.channel)).toEqual(["C1", "C2", "C3"]);
  });

  it("fetches replies only for threads with activity inside the window", async () => {
    const quiet = mention({ ts: ts(5000), reply_count: 2, latest_reply: ts(4000) });
    const active = mention({ ts: ts(5000, "000002"), reply_count: 2, latest_reply: ts(30) });
    const follow = mention({ ts: ts(30), thread_ts: active.ts });
    const client = mockClient({
      history: { C1: [active, quiet] },
      replies: { [`C1:${active.ts}`]: [active, follow] },
    });
    const onMissed = vi.fn();
    await catchUpMissedMentions({ client, botUserId: BOT, now: NOW, alreadyHandled: () => false, onMissed });
    expect(client.conversations.replies).toHaveBeenCalledTimes(1);
    expect(client.conversations.replies).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C1", ts: active.ts }),
    );
    expect(onMissed.mock.calls.map(([m]) => m.ts)).toEqual([follow.ts]);
  });

  it("does nothing when everything was handled (the common reconnect)", async () => {
    const client = mockClient({
      history: { C1: [mention({ ts: ts(10), reactions: [{ name: "eyes", users: [BOT], count: 1 }] })] },
    });
    const onMissed = vi.fn();
    const out = await catchUpMissedMentions({
      client,
      botUserId: BOT,
      now: NOW,
      alreadyHandled: () => false,
      onMissed,
    });
    expect(out).toEqual({ channels: 1, missed: 0, orphans: 0, skippedChannels: 0 });
    expect(onMissed).not.toHaveBeenCalled();
  });

  it("never throws: a channel whose history fails is logged and skipped", async () => {
    const client = mockClient({ historyError: "missing_scope" });
    const log = vi.fn();
    const out = await catchUpMissedMentions({
      client,
      botUserId: BOT,
      now: NOW,
      alreadyHandled: () => false,
      onMissed: vi.fn(),
      log,
    });
    expect(out).toEqual({ channels: 1, missed: 0, orphans: 0, skippedChannels: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("missing_scope"));
  });

  it("a dispatch that rejects does not stop the remaining catch-up", async () => {
    const a = mention({ ts: ts(70) });
    const b = mention({ ts: ts(50) });
    const client = mockClient({ history: { C1: [b, a] } });
    const onMissed = vi.fn(async ({ ts: t }: { ts: string }) => {
      if (t === a.ts) throw new Error("boom");
    });
    const log = vi.fn();
    const out = await catchUpMissedMentions({
      client,
      botUserId: BOT,
      now: NOW,
      alreadyHandled: () => false,
      onMissed,
      log,
    });
    expect(out.missed).toBe(2);
    expect(onMissed).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("pages a long thread's replies by cursor so the newest (in-window) messages are seen", async () => {
    const parent = mention({ ts: ts(5000), reply_count: 3, latest_reply: ts(30) });
    const botReply = { type: "message", user: BOT, bot_id: "B1", text: "here", ts: ts(4000), thread_ts: parent.ts };
    const follow = { type: "message", user: "U0USER", text: "one more thing", ts: ts(30), thread_ts: parent.ts };
    const client = mockClient({ history: { C1: [parent] } });
    client.conversations.replies
      .mockResolvedValueOnce({ messages: [parent, botReply], response_metadata: { next_cursor: "r2" } })
      .mockResolvedValueOnce({ messages: [follow], response_metadata: { next_cursor: "" } });
    const onMissed = vi.fn();
    await catchUpMissedMentions({ client, botUserId: BOT, now: NOW, alreadyHandled: () => false, onMissed });
    expect(client.conversations.replies).toHaveBeenCalledTimes(2);
    expect(client.conversations.replies.mock.calls[1][0]).toEqual(
      expect.objectContaining({ ts: parent.ts, cursor: "r2" }),
    );
    // the bot's reply on page 1 makes it a participating thread; the follow-up on page 2 is the missed message
    expect(onMissed.mock.calls.map(([m]) => m.ts)).toEqual([follow.ts]);
  });

  it("asks history for the parent-lookback window and pages until it runs out", async () => {
    const client = mockClient();
    client.conversations.history
      .mockResolvedValueOnce({ messages: [mention({ ts: ts(100) })], response_metadata: { next_cursor: "c2" } })
      .mockResolvedValueOnce({
        messages: [mention({ ts: ts(5), reactions: [{ name: "eyes", users: [BOT], count: 1 }] })],
        response_metadata: { next_cursor: "" },
      });
    const onMissed = vi.fn();
    await catchUpMissedMentions({
      client,
      botUserId: BOT,
      now: NOW,
      alreadyHandled: () => false,
      onMissed,
      parentLookbackMs: 86_400_000,
    });
    expect(client.conversations.history).toHaveBeenCalledTimes(2);
    const first = client.conversations.history.mock.calls[0][0] as unknown as { oldest: string; cursor?: string };
    expect(Number(first.oldest)).toBeCloseTo((NOW - 86_400_000) / 1000, 0);
    expect(client.conversations.history.mock.calls[1][0]).toEqual(expect.objectContaining({ cursor: "c2" }));
    expect(onMissed).toHaveBeenCalledTimes(1);
  });
});

// Feature: features/slack-channel.md item 8 — a status card left spinning by a
// process that died mid-run (a deploy rollout that killed the container before
// the drain finished — live 2026-08-29 23:51Z, PR #214's review froze at
// "153s — thinking") is closed as interrupted by the next connect's sweep, so
// the requester never stares at a frozen spinner.
describe("findOrphanedCards (pure selection of the bot's own frozen live cards)", () => {
  const cutoff = NOW - ORPHAN_CARD_WINDOW_MS;
  const parent = mention({ ts: ts(600), reply_count: 1, latest_reply: ts(500) });
  const card = (text: string, over: Partial<SlackHistoryMessage> = {}): SlackHistoryMessage => ({
    type: "message",
    user: BOT,
    bot_id: "B1",
    text,
    ts: ts(500),
    thread_ts: parent.ts,
    ...over,
  });
  const threads = (...replies: SlackHistoryMessage[]) => new Map([[parent.ts, [parent, ...replies]]]);
  const base = { channel: "C1", botUserId: BOT, cutoffMs: cutoff, ownedHere: () => false };

  it("picks a bot card whose text starts with a live glyph (spinner or 👀 setup), inside the window", () => {
    for (const glyph of ["◐", "◓", "◑", "◒", "👀"]) {
      const c = card(`${glyph} *review* on \`anthropic/claude-fable-5\` · 153s — thinking (88s since last tool)`);
      expect(findOrphanedCards({ ...base, threads: threads(c) }), glyph).toEqual([
        { channel: "C1", ts: c.ts, text: c.text },
      ]);
    }
  });

  it("skips closed cards (✅ / ❌ / ⏹), human messages, bot replies without a glyph, and cards older than the window", () => {
    const closed = ["✅ *review* · 203s", "❌ *review* · failed", "⏹ *review* · stopped", "Here is my answer"].map(
      (t) => card(t),
    );
    const human = card("◓ pretending", { user: "U0USER", bot_id: undefined });
    const old = card("◓ *review* · 9000s", { ts: ts(3 * 3600) });
    expect(findOrphanedCards({ ...base, threads: threads(...closed, human, old) })).toEqual([]);
  });

  it("skips a live card THIS process owns (a reconnect without a restart must not close a running run's card)", () => {
    const mine = card("◓ *review* · 12s");
    const out = findOrphanedCards({
      ...base,
      threads: threads(mine),
      ownedHere: (ch, t) => ch === "C1" && t === mine.ts,
    });
    expect(out).toEqual([]);
  });
});

describe("interruptedCardFrame", () => {
  it("keeps the run label and elapsed time, drops the spinner and the thinking suffix, explains and tells the reader what to do", () => {
    const f = interruptedCardFrame(
      "◓ *review* on `anthropic/claude-fable-5` · resident refreshing · 153s — thinking (88s since last tool)",
    );
    expect(f.title).toBe("❌ interrupted · *review* on `anthropic/claude-fable-5` · resident refreshing · 153s");
    expect(f.detail).toMatch(/restarted .* while this run was in flight/);
    expect(f.detail).toMatch(/re-send/i);
  });

  it("un-escapes the mrkdwn entities Slack returns in history so the label is not double-escaped on re-render", () => {
    const f = interruptedCardFrame("👀 *coding* on `x` &amp; friends · preparing workspace…");
    expect(f.title).toBe("❌ interrupted · *coding* on `x` & friends · preparing workspace…");
  });

  it("un-escapes exactly once: a literal `&amp;lt;` in the label becomes `&lt;`, not `<`", () => {
    const f = interruptedCardFrame("◓ *general* · &amp;lt;tag&amp;gt; · 3s");
    expect(f.title).toBe("❌ interrupted · *general* · &lt;tag&gt; · 3s");
  });

  // #357 (live 2026-08-30 22:06Z): a card frozen mid-drain carries the shutdown
  // notice; the interrupted title must not keep the stale "finishing this run"
  // clause — the run was NOT finished.
  it("drops the trailing drain notice (unicode ⏸ form), keeping label and elapsed", () => {
    const f = interruptedCardFrame(
      "◐ *coding* on `anthropic/claude-fable-5` · resident · main@7f13a94 · 323s · ⏸ deploy in progress — finishing this run before the bot restarts",
    );
    expect(f.title).toBe("❌ interrupted · *coding* on `anthropic/claude-fable-5` · resident · main@7f13a94 · 323s");
  });

  it("drops the drain notice when Slack history returns the glyph as a :shortcode:", () => {
    const f = interruptedCardFrame(
      "◐ *coding* on `m` · 323s · :double_vertical_bar: deploy in progress — finishing this run before the bot restarts",
    );
    expect(f.title).toBe("❌ interrupted · *coding* on `m` · 323s");
  });

  it("drops both the thinking suffix and the drain notice when the card carries both", () => {
    const f = interruptedCardFrame(
      "◓ *review* on `m` · 153s — thinking (88s since last tool) · ⏸ deploy in progress — finishing this run before the bot restarts",
    );
    expect(f.title).toBe("❌ interrupted · *review* on `m` · 153s");
  });

  it("drops the drain notice even when the glyph token is missing entirely", () => {
    const f = interruptedCardFrame(
      "◐ *coding* on `m` · 323s · deploy in progress — finishing this run before the bot restarts",
    );
    expect(f.title).toBe("❌ interrupted · *coding* on `m` · 323s");
  });

  it("leaves a label alone that merely mentions a deploy mid-text", () => {
    const f = interruptedCardFrame('◓ *coding* · "fix the deploy in progress banner" · 42s');
    expect(f.title).toBe('❌ interrupted · *coding* · "fix the deploy in progress banner" · 42s');
  });
});

describe("catchUpMissedMentions — orphaned-card sweep", () => {
  // The requester's mention was 👀-acked (handled) and its thread was last
  // active 41 min ago: outside the 20 min mention window, inside the orphan one.
  const parent = mention({
    ts: ts(3000),
    reply_count: 1,
    latest_reply: ts(2500),
    reactions: [{ name: "eyes", users: [BOT], count: 1 }],
  });
  const frozen: SlackHistoryMessage = {
    type: "message",
    user: BOT,
    bot_id: "B1",
    text: "◓ *review* on `m` · 153s — thinking (88s since last tool)",
    ts: ts(2500),
    thread_ts: parent.ts,
  };

  it("fetches threads active inside the (wider) orphan window and closes the frozen card as interrupted; the mention is not re-run", async () => {
    const client = mockClient({ history: { C1: [parent] }, replies: { [`C1:${parent.ts}`]: [parent, frozen] } });
    const onMissed = vi.fn();
    const onOrphanedCard = vi.fn(async () => {});
    const log = vi.fn();
    const out = await catchUpMissedMentions({
      client,
      botUserId: BOT,
      now: NOW,
      alreadyHandled: () => false,
      onMissed,
      ownedHere: () => false,
      onOrphanedCard,
      log,
    });
    expect(out).toEqual({ channels: 1, missed: 0, orphans: 1, skippedChannels: 0 });
    expect(client.conversations.replies).toHaveBeenCalledTimes(1);
    expect(onMissed).not.toHaveBeenCalled();
    expect(onOrphanedCard).toHaveBeenCalledWith(
      { channel: "C1", ts: frozen.ts, text: frozen.text },
      expect.objectContaining({ title: "❌ interrupted · *review* on `m` · 153s" }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("1 of 1 orphaned status card(s) closed"));
  });

  it("without an onOrphanedCard hook the sweep is off: no wider fetch, no closes", async () => {
    const client = mockClient({ history: { C1: [parent] }, replies: { [`C1:${parent.ts}`]: [parent, frozen] } });
    const out = await catchUpMissedMentions({
      client,
      botUserId: BOT,
      now: NOW,
      alreadyHandled: () => false,
      onMissed: vi.fn(),
    });
    expect(out).toEqual({ channels: 1, missed: 0, orphans: 0, skippedChannels: 0 });
    expect(client.conversations.replies).not.toHaveBeenCalled();
  });

  it("a failing close is logged, does not stop the rest, and is not counted as closed", async () => {
    const other = mention({
      ts: ts(3000, "000002"),
      reply_count: 1,
      latest_reply: ts(2400),
      reactions: [{ name: "eyes", users: [BOT], count: 1 }],
    });
    const frozen2 = { ...frozen, ts: ts(2400), thread_ts: other.ts };
    const client = mockClient({
      history: { C1: [parent, other] },
      replies: { [`C1:${parent.ts}`]: [parent, frozen], [`C1:${other.ts}`]: [other, frozen2] },
    });
    const onOrphanedCard = vi
      .fn()
      .mockRejectedValueOnce(new Error("message_not_found"))
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();
    const out = await catchUpMissedMentions({
      client,
      botUserId: BOT,
      now: NOW,
      alreadyHandled: () => false,
      onMissed: vi.fn(),
      ownedHere: () => false,
      onOrphanedCard,
      log,
    });
    expect(onOrphanedCard).toHaveBeenCalledTimes(2);
    expect(out.orphans).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("message_not_found"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("1 of 2 orphaned status card(s) closed"));
  });
});

// #271 — the runner records its outcome so /healthz can show it.
describe("catchUpMissedMentions — outcome record", () => {
  it("records channels/missed and zero skipped after a clean scan", async () => {
    const client = mockClient({ channels: [{ id: "C1" }, { id: "C2" }], history: { C1: [mention()], C2: [] } });
    const record = vi.fn();
    const out = await catchUpMissedMentions({
      client,
      botUserId: BOT,
      now: NOW,
      alreadyHandled: () => false,
      onMissed: vi.fn(),
      record,
    });
    expect(out).toEqual({ channels: 2, missed: 1, orphans: 0, skippedChannels: 0 });
    expect(record).toHaveBeenCalledWith({ at: NOW, channels: 2, missed: 1, skippedChannels: 0 });
  });

  it("records the channel-listing failure as `error` (the 2026-08-30 missing_scope silence)", async () => {
    const client = mockClient();
    client.users.conversations.mockRejectedValue(new Error("An API error occurred: missing_scope"));
    const record = vi.fn();
    const out = await catchUpMissedMentions({
      client,
      botUserId: BOT,
      now: NOW,
      alreadyHandled: () => false,
      onMissed: vi.fn(),
      record,
    });
    expect(out).toEqual({ channels: 0, missed: 0, orphans: 0, skippedChannels: 0 });
    expect(record).toHaveBeenCalledWith({
      at: NOW,
      channels: 0,
      missed: 0,
      skippedChannels: 0,
      error: "An API error occurred: missing_scope",
    });
  });

  it("counts per-channel scan failures as skippedChannels, without an error", async () => {
    const client = mockClient({ channels: [{ id: "C1" }, { id: "C2" }], historyError: "not_in_channel" });
    const record = vi.fn();
    const out = await catchUpMissedMentions({
      client,
      botUserId: BOT,
      now: NOW,
      alreadyHandled: () => false,
      onMissed: vi.fn(),
      record,
    });
    expect(out.skippedChannels).toBe(2);
    expect(record).toHaveBeenCalledWith({ at: NOW, channels: 2, missed: 0, skippedChannels: 2 });
  });
});
