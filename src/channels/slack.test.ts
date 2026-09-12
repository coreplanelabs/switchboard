import { afterEach, describe, expect, it, vi } from "vitest";
import { Secret } from "../secrets.js";
import {
  catchUpDelayNote,
  classifyMessage,
  createStatusClient,
  resumeSlackIO,
  SlackIO,
  stripMention,
  threadIncludesBot,
} from "./slack.js";
import { fetchImages } from "./slack/attachments.js";
import { createStatusBudget, type StatusBudget } from "../core/statusBudget.js";

// Feature: docs/reference/specs/slack-channel.md — trigger gating (which events start a
// run) and the channel IO over the Slack Web API.

const BOT = "U0BOT";

describe("classifyMessage (trigger gating)", () => {
  it("skips bot messages — no bot-loop", () => {
    expect(classifyMessage({ bot_id: "B1", channel_type: "channel", thread_ts: "1.0" }, BOT)).toBe("skip");
  });

  it("skips subtyped messages except file_share", () => {
    expect(classifyMessage({ subtype: "channel_join", channel_type: "im" }, BOT)).toBe("skip");
    expect(classifyMessage({ subtype: "message_changed", channel_type: "im" }, BOT)).toBe("skip");
    expect(classifyMessage({ subtype: "file_share", channel_type: "im" }, BOT)).toBe("handle");
  });

  it("handles DMs directly", () => {
    expect(classifyMessage({ channel_type: "im", text: "hi" }, BOT)).toBe("handle");
  });

  it("skips top-level channel posts — those require a mention (app_mention's job)", () => {
    expect(classifyMessage({ channel_type: "channel", text: "hello" }, BOT)).toBe("skip");
  });

  it("skips mentions in threads — the same message fires app_mention (no double-handling)", () => {
    expect(classifyMessage({ channel_type: "channel", thread_ts: "1.0", text: `hey <@${BOT}> do it` }, BOT)).toBe(
      "skip",
    );
  });

  it("thread follow-ups without a mention defer to the participation check", () => {
    expect(classifyMessage({ channel_type: "channel", thread_ts: "1.0", text: "continue" }, BOT)).toBe(
      "handle-if-bot-in-thread",
    );
  });
});

describe("threadIncludesBot (participation, re-derived from history)", () => {
  it("true when the bot posted in the thread", () => {
    expect(
      threadIncludesBot(
        [
          { user: "UA", text: "q" },
          { user: BOT, text: "a" },
        ],
        BOT,
      ),
    ).toBe(true);
  });

  it("true when the bot was mentioned anywhere in the thread", () => {
    expect(threadIncludesBot([{ user: "UA", text: `<@${BOT}> help` }], BOT)).toBe(true);
  });

  it("false otherwise, and false without a bot user id", () => {
    expect(threadIncludesBot([{ user: "UA", text: "just people talking" }], BOT)).toBe(false);
    expect(threadIncludesBot([{ user: BOT, text: "a" }], undefined)).toBe(false);
  });
});

describe("stripMention", () => {
  it("removes every mention of the known bot id", () => {
    expect(stripMention(`<@${BOT}> do a thing <@${BOT}> now`, BOT)).toBe("do a thing  now".trim());
  });

  it("removes only the first generic mention when the bot id is unknown", () => {
    expect(stripMention("<@UANY> hello <@UOTHER>", undefined)).toBe("hello <@UOTHER>");
  });
});

describe("stripMention — Slack app 'Sent using' footer", () => {
  // Messages posted through a Slack app on a user's behalf (e.g. the Claude
  // Slack plugin) carry a trailing "*Sent using* <@APP|Name>" line. It is
  // platform chrome, not user text: a `repo onboard owner/name` followed by it
  // must parse exactly like the bare command.
  // The raw event text carries the footer on the SAME line as the command —
  // `<@BOT> friction report *Sent using* <@APP>` — so a line-anchored regex
  // never matches and `*Sent` reaches the parser (`Unknown option \`*Sent\``).
  // `repo list` masks this because it ignores trailing text.
  it("drops a same-line trailing footer (the shape Slack actually delivers)", () => {
    expect(stripMention(`<@${BOT}> friction report *Sent using* <@UAPPFOOTER>`, BOT)).toBe("friction report");
    expect(stripMention(`<@${BOT}> repo onboard acme/api test="npm test" *Sent using* <@UAPPFOOTER|Claude>`, BOT)).toBe(
      'repo onboard acme/api test="npm test"',
    );
    // Still anchored to the END: the phrase mid-text is the user's own words.
    expect(stripMention(`<@${BOT}> why does *Sent using* <@UAPPFOOTER> appear in my messages?`, BOT)).toBe(
      "why does *Sent using* <@UAPPFOOTER> appear in my messages?",
    );
  });

  it("drops the footer when a bracketed sender attribution follows the mention", () => {
    expect(
      stripMention(`<@${BOT}> friction report\n*Sent using* <@UAPPFOOTER|Claude> [ada <ada@example.com>]`, BOT),
    ).toBe("friction report");
    expect(stripMention(`<@${BOT}> repo list\nSent using <@UAPPFOOTER> [Ada Lovelace]`, BOT)).toBe("repo list");
    // Attribution text is never treated as the footer on its own.
    expect(stripMention(`<@${BOT}> hello [ada <ada@example.com>]`, BOT)).toBe("hello [ada <ada@example.com>]");
  });

  it("drops a trailing '*Sent using* <@APP|Name>' footer line", () => {
    expect(stripMention(`<@${BOT}> repo onboard acme/api\n*Sent using* <@UAPPFOOTER|Claude>`, BOT)).toBe(
      "repo onboard acme/api",
    );
  });

  it("accepts the unbolded and label-less forms and surrounding whitespace", () => {
    expect(stripMention(`<@${BOT}> repo list\n\nSent using <@UAPPFOOTER>  `, BOT)).toBe("repo list");
  });

  it("strips only the two real shapes: asymmetric bold is not a footer", () => {
    expect(stripMention(`<@${BOT}> repo list\n*Sent using <@UAPPFOOTER|Claude>`, BOT)).toBe(
      "repo list\n*Sent using <@UAPPFOOTER|Claude>",
    );
  });

  it("strips stacked footers (a forwarded app message can carry two)", () => {
    expect(
      stripMention(`<@${BOT}> repo list\n*Sent using* <@UAPPFOOTER|Claude>\n*Sent using* <@UAPPFOOTER|Claude>`, BOT),
    ).toBe("repo list");
  });

  it("a message that is only a mention plus the footer strips to empty", () => {
    expect(stripMention(`<@${BOT}> *Sent using* <@UAPPFOOTER|Claude>`, BOT)).toBe("");
  });

  it("leaves 'Sent using' alone when it is part of the user's own text (not a trailing footer line)", () => {
    expect(stripMention(`<@${BOT}> what does "Sent using" mean here?`, BOT)).toBe('what does "Sent using" mean here?');
    expect(stripMention(`<@${BOT}> Sent using <@UAPPFOOTER> is the footer\nplease explain`, BOT)).toBe(
      "Sent using <@UAPPFOOTER> is the footer\nplease explain",
    );
  });
});

// Feature: docs/reference/specs/slack-channel.md — a follow-up's thread page is fetched
// once (the bot-in-thread check hands it to history()), and a message's
// attachments download concurrently instead of one after another.
describe("SlackIO.history — thread reuse and concurrent attachment downloads", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ev = { channel: "C1", user: "UA", text: "hi", ts: "3.0", threadTs: "1.0", botUserId: "UBOT" };

  it("uses the thread the handler already fetched instead of calling conversations.replies again", async () => {
    const replies = vi.fn();
    const client = { conversations: { replies } } as unknown as ConstructorParameters<typeof SlackIO>[0];
    const thread = [
      { user: "UA", text: "<@UBOT> first ask", ts: "1.0" },
      { bot_id: "B1", text: "an answer", ts: "2.0" },
      { user: "UA", text: "hi", ts: "3.0" }, // the triggering message — skipped
    ];
    const items = await new SlackIO(client, { ...ev, thread }).history();
    expect(replies).not.toHaveBeenCalled();
    expect(items.map((i) => [i.role, i.text])).toEqual([
      ["user", "first ask"],
      ["assistant", "an answer"],
    ]);
  });

  it("fetches the thread itself when no prefetched page is given (mention path)", async () => {
    const replies = vi.fn(async () => ({ messages: [{ user: "UA", text: "earlier", ts: "1.0" }] }));
    const client = { conversations: { replies } } as unknown as ConstructorParameters<typeof SlackIO>[0];
    const items = await new SlackIO(client, ev).history();
    expect(replies).toHaveBeenCalledWith({ channel: "C1", ts: "1.0", limit: 50 });
    expect(items.map((i) => i.text)).toEqual(["earlier"]);
  });

  it("downloads a message's images concurrently — every fetch starts before any finishes", async () => {
    let inFlight = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((r) => gates.push(r));
        inFlight--;
        return new Response(new Uint8Array(4).fill(7), { status: 200, headers: { "content-type": "image/png" } });
      }),
    );
    const png = (name: string) => ({
      id: name,
      name,
      mimetype: "image/png",
      size: 4,
      url_private_download: `https://files.slack.test/${name}`,
    });
    const p = fetchImages([png("a.png"), png("b.png"), png("c.png")], 10);
    await new Promise((r) => setTimeout(r, 0));
    expect(inFlight).toBe(3);
    gates.splice(0).forEach((r) => r());
    const { images, skipped, bytes } = await p;
    expect(peak).toBe(3);
    expect(images.map((i) => i.name)).toEqual(["a.png", "b.png", "c.png"]); // original order, not completion order
    expect(skipped).toEqual([]);
    expect(bytes).toBe(12);
  });
});

// Feature: docs/reference/specs/slack-channel.md item 7 — a message the reconnect catch-up
// replays tells the thread how late the pickup was (a mention can sit for
// minutes with no 👀 through a deploy drain; from the thread the caller cannot
// tell "ignored" from "bot restarting").
describe("catchUpDelayNote", () => {
  it("names the delay in whole minutes and says not to re-send", () => {
    const posted = 1788066592.040859; // 05:09:52Z
    const note = catchUpDelayNote(String(posted), (posted + 449) * 1000); // picked up 05:17:21Z
    expect(note).toContain("7 min after it was posted");
    expect(note).toMatch(/restarting/);
    expect(note).toMatch(/no need to re-send/i);
  });
  it("sub-minute and clock-skewed (negative) delays render as 'under a minute'", () => {
    expect(catchUpDelayNote("1000.5", 1000_500 + 20_000)).toContain("under a minute");
    expect(catchUpDelayNote("1000.5", 900_000)).toContain("under a minute");
  });
});

// Feature: docs/reference/specs/run-history.md item 38 — a resumed run keeps the card the
// previous generation posted: `status()` edits it instead of posting a second one.
describe("SlackIO.status on a resumed run (existing card)", () => {
  const ev = { channel: "C1", user: "UA", text: "", ts: "1.0", threadTs: "1.0", botUserId: "UBOT" };
  function client() {
    const update = vi.fn(async (_opts: Record<string, unknown>) => ({ ok: true }));
    const postMessage = vi.fn(async (_opts: Record<string, unknown>) => ({ ok: true, ts: "new.1" }));
    const setStatus = vi.fn(async (_opts: Record<string, unknown>) => ({ ok: true }));
    const c = {
      chat: { update, postMessage },
      assistant: { threads: { setStatus } },
    } as unknown as ConstructorParameters<typeof SlackIO>[0];
    return { c, update, postMessage, setStatus };
  }

  it("with an existing card, the first frame edits that message and no new card is posted; the handle names it; done() closes it", async () => {
    const { c, update, postMessage } = client();
    const io = new SlackIO(c, ev, { existingCard: { ts: "9.9" } });
    const handle = await io.status({ title: "👀 resuming" });
    expect(postMessage).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({ channel: "C1", ts: "9.9" });
    expect(handle.handle).toEqual({ channel: "C1", ts: "9.9" });
    await handle.done({ title: "✅ done" });
    expect(update.mock.calls.at(-1)![0]).toMatchObject({ channel: "C1", ts: "9.9" });
  });

  it("when the existing card cannot be edited (deleted since), a fresh card is posted and becomes the handle", async () => {
    const { c, update, postMessage } = client();
    update.mockImplementationOnce(async () => {
      throw new Error("message_not_found");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const handle = await new SlackIO(c, ev, { existingCard: { ts: "gone.1" } }).status({ title: "👀 resuming" });
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(handle.handle).toEqual({ channel: "C1", ts: "new.1" });
    } finally {
      warn.mockRestore();
    }
  });

  it("resumeSlackIO builds the thread IO from the ledger row's parts: replies land in the thread, the card is the existing one; without a card ts a fresh card is posted", async () => {
    const a = client();
    const withCard = resumeSlackIO(a.c, { channel: "C1", threadTs: "1.0", user: "UA", cardTs: "9.9" });
    await withCard.status({ title: "👀" });
    expect(a.postMessage).not.toHaveBeenCalled();
    await withCard.reply("hello again");
    expect(a.postMessage).toHaveBeenCalledTimes(1);
    expect(a.postMessage.mock.calls[0][0]).toMatchObject({ channel: "C1", thread_ts: "1.0" });
    const b = client();
    const noCard = resumeSlackIO(b.c, { channel: "C1", threadTs: "1.0", user: "UA" });
    const handle = await noCard.status({ title: "👀" });
    expect(b.postMessage).toHaveBeenCalledTimes(1);
    expect(handle.handle).toEqual({ channel: "C1", ts: "new.1" });
  });
});

// docs/reference/specs/slack-channel.md item 11: a child run's thread of its own —
// the lead posted top-level in the parent's channel, the thread IO built from
// the posted `ts` the way `resumeSlackIO` builds one from a row's parts.
describe("SlackIO.openThread (docs/reference/specs/slack-channel.md item 11)", () => {
  const ev = { channel: "C1", user: "UA", text: "spawn", ts: "1.5", threadTs: "1.0", botUserId: "UBOT" };
  function client(teamUrl?: string) {
    const postMessage = vi.fn(async (_opts: Record<string, unknown>) => ({ ok: true, ts: "77.1" }));
    const test = vi.fn(async () => ({ ok: true, ...(teamUrl ? { url: teamUrl } : {}) }));
    const c = { chat: { postMessage }, auth: { test } } as unknown as ConstructorParameters<typeof SlackIO>[0];
    return { c, postMessage };
  }

  it("posts the lead top-level in the parent's channel (no thread_ts, mrkdwn), keys the thread by the posted ts, and the returned IO replies under that ts", async () => {
    const { c, postMessage } = client();
    const opened = await new SlackIO(c, ev).openThread("↳ *research* child");
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toEqual({ channel: "C1", text: "↳ *research* child" });
    expect(opened.thread.threadKey).toBe("slack:C1:77.1");
    // No team URL known (and none cached yet in this process): no sourceUrl key.
    expect("sourceUrl" in opened.thread).toBe(false);
    await opened.io.reply("child answer");
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1][0]).toMatchObject({ channel: "C1", thread_ts: "77.1", text: "child answer" });
  });

  it("carries the lead's permalink as the thread's sourceUrl when the team URL is known", async () => {
    const known = client("https://acme.slack.com/");
    const opened = await new SlackIO(known.c, ev).openThread("lead");
    expect(opened.thread.sourceUrl).toBe("https://acme.slack.com/archives/C1/p771");
  });

  it("a chat.postMessage answer without a ts is refused by name — never a thread keyed on `undefined`", async () => {
    const postMessage = vi.fn(async (_opts: Record<string, unknown>) => ({ ok: true }));
    const test = vi.fn(async () => ({ ok: true }));
    const c = { chat: { postMessage }, auth: { test } } as unknown as ConstructorParameters<typeof SlackIO>[0];
    await expect(new SlackIO(c, ev).openThread("lead")).rejects.toThrow(/chat\.postMessage answered without a ts/);
  });
});

describe("SlackIO.attach (docs/reference/specs/slack-channel.md item 10)", () => {
  const ev = { channel: "C1", user: "UA", text: "hi", ts: "3.0", threadTs: "1.0", botUserId: "UBOT" };
  const file = {
    name: "mcp-show.txt",
    text: "Tools (100):\n" + "  - `tool` — long\n".repeat(400),
    lead: "• `vanta` (user) ✅ connected\n_(full output attached — 8,000 chars)_",
  };

  it("uploads the text as a snippet in the thread with the lead (in mrkdwn) as the comment — one call, no chunked messages", async () => {
    const uploadV2 = vi.fn(async (_opts: Record<string, unknown>) => ({ ok: true }));
    const postMessage = vi.fn(async (_opts: Record<string, unknown>) => ({ ok: true }));
    const client = { files: { uploadV2 }, chat: { postMessage } } as unknown as ConstructorParameters<
      typeof SlackIO
    >[0];
    await new SlackIO(client, ev).attach(file);
    expect(uploadV2).toHaveBeenCalledTimes(1);
    expect(uploadV2.mock.calls[0][0]).toMatchObject({
      channel_id: "C1",
      thread_ts: "1.0",
      filename: "mcp-show.txt",
      title: "mcp-show.txt",
      content: file.text,
    });
    expect(String(uploadV2.mock.calls[0][0].initial_comment)).toContain("_(full output attached — 8,000 chars)_");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("a failed upload (missing files:write, an API error) falls back to the chunked text reply carrying lead + text — the output always arrives", async () => {
    const uploadV2 = vi.fn(async (_opts: Record<string, unknown>) => {
      throw new Error("An API error occurred: missing_scope");
    });
    const postMessage = vi.fn(async (_opts: Record<string, unknown>) => ({ ok: true }));
    const client = { files: { uploadV2 }, chat: { postMessage } } as unknown as ConstructorParameters<
      typeof SlackIO
    >[0];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await new SlackIO(client, ev).attach(file);
    } finally {
      warn.mockRestore();
    }
    expect(postMessage.mock.calls.length).toBeGreaterThan(1);
    const texts = postMessage.mock.calls.map((c) => String(c[0].text));
    expect(texts[0]).toContain("`vanta` (user)");
    expect(texts.join("")).toContain("Tools (100):");
    for (const c of postMessage.mock.calls) expect(c[0]).toMatchObject({ channel: "C1", thread_ts: "1.0" });
  });
});

// Feature: docs/reference/specs/run-visibility.md item 8 — card edits ride a status client of
// their own and draw from one process-wide budget; the terminal frame never
// waits behind a rate limit and never blocks the reply.
describe("SlackIO.status — status budget", () => {
  const ev = { channel: "C1", user: "UA", text: "", ts: "1.0", threadTs: "1.0", botUserId: "UBOT" };
  const RATE_LIMITED = { code: "slack_webapi_rate_limited_error", retryAfter: 2 };
  function clients() {
    const main = {
      update: vi.fn(async (_o: Record<string, unknown>) => ({ ok: true })),
      postMessage: vi.fn(async (_o: Record<string, unknown>) => ({ ok: true, ts: "card.1" })),
      setStatus: vi.fn(async (_o: Record<string, unknown>) => ({ ok: true })),
    };
    const status = {
      update: vi.fn(async (_o: Record<string, unknown>) => ({ ok: true })),
      setStatus: vi.fn(async (_o: Record<string, unknown>) => ({ ok: true })),
    };
    type Client = ConstructorParameters<typeof SlackIO>[0];
    const client = {
      chat: { update: main.update, postMessage: main.postMessage },
      assistant: { threads: { setStatus: main.setStatus } },
    } as unknown as Client;
    const statusClient = {
      chat: { update: status.update },
      assistant: { threads: { setStatus: status.setStatus } },
    } as unknown as Client;
    return { client, statusClient, main, status };
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A budget that never binds: the tests below are about the adapter, the budget's rules are its module's tests. */
  const openBudget = () => createStatusBudget({ perMinute: 600, channelSpacingMs: 0, now: () => 0 });

  it("the card is posted on the main client; every edit, the shimmer and the close go through the status client", async () => {
    const { client, statusClient, main, status } = clients();
    const budget = openBudget();
    const handle = await new SlackIO(client, ev, { statusClient, statusBudget: budget }).status({ title: "👀" });
    handle.update({ title: "⚡ 5s" });
    await handle.done({ title: "✅ 6s" });
    expect(main.postMessage).toHaveBeenCalledTimes(1);
    expect(main.update).not.toHaveBeenCalled();
    expect(status.update.mock.calls.map((c) => (c[0] as { text: string }).text)).toEqual(["⚡ 5s", "✅ 6s"]);
    expect(status.setStatus).toHaveBeenCalledTimes(2); // the shimmer on, then cleared by done
    expect(main.setStatus).not.toHaveBeenCalled();
  });

  it("progress frames the budget refuses are dropped and counted; the terminal frame still goes out", async () => {
    const { client, statusClient, status } = clients();
    // A scripted budget: three progress tokens, then refusals (the budget's own rules are its module's tests).
    let progress = 3;
    const budget: StatusBudget = {
      open: () => {},
      close: () => {},
      tryProgress: () => progress-- > 0,
      takeTerminal: () => 0,
      tokens: () => progress,
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const handle = await new SlackIO(client, ev, { statusClient, statusBudget: budget }).status({ title: "👀" });
    for (let i = 1; i <= 5; i++) handle.update({ title: `⚡ ${i}` });
    await handle.done({ title: "✅" });
    expect(status.update.mock.calls.map((c) => (c[0] as { text: string }).text)).toEqual([
      "⚡ 1",
      "⚡ 2",
      "⚡ 3",
      "✅",
    ]);
    expect(log.mock.calls.map((c) => String(c[0]))).toContain(
      "[slack] card C1:card.1: 2 progress frames dropped by the status budget",
    );
  });

  it("a rate-limited terminal frame is re-sent after Retry-After, again and again, without holding done(); a rate-limited progress frame is not", async () => {
    vi.useFakeTimers();
    const { client, statusClient, status } = clients();
    const handle = await new SlackIO(client, ev, { statusClient, statusBudget: openBudget() }).status({ title: "👀" });
    status.update.mockRejectedValueOnce(RATE_LIMITED);
    handle.update({ title: "⚡ 1" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(status.update).toHaveBeenCalledTimes(1); // no re-send for a progress frame
    status.update.mockRejectedValueOnce(RATE_LIMITED).mockRejectedValueOnce(RATE_LIMITED);
    await handle.done({ title: "✅" }); // resolves at once
    expect(status.update).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(status.update).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(status.update).toHaveBeenCalledTimes(3); // refused again → one more Retry-After
    await vi.advanceTimersByTimeAsync(2_000);
    expect(status.update).toHaveBeenCalledTimes(4);
    expect((status.update.mock.calls[3]![0] as { text: string }).text).toBe("✅");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(status.update).toHaveBeenCalledTimes(4); // accepted: no more sends
  });

  it("a terminal frame refused past the re-send cap is given up with a warning", async () => {
    vi.useFakeTimers();
    const { client, statusClient, status } = clients();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = await new SlackIO(client, ev, { statusClient, statusBudget: openBudget() }).status({ title: "👀" });
    status.update.mockRejectedValue(RATE_LIMITED);
    await handle.done({ title: "✅" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(status.update).toHaveBeenCalledTimes(11); // the first send + 10 re-sends
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      "[slack] card C1:card.1: terminal frame not painted (slack_webapi_rate_limited_error) after 11 attempts",
    );
  });

  it("a terminal frame the budget cannot fund now is sent when the budget says, and done() does not wait for it", async () => {
    vi.useFakeTimers();
    const { client, statusClient, status } = clients();
    let t = 0;
    const budget = createStatusBudget({ perMinute: 60, reserve: 0, channelSpacingMs: 0, now: () => t }); // one token a second
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = await new SlackIO(client, ev, { statusClient, statusBudget: budget }).status({ title: "👀" });
    for (let i = 0; i < 60; i++) budget.tryProgress(`other${i}`, `C${i}`); // the fleet spent the bucket
    expect(budget.tokens()).toBe(0);
    await handle.done({ title: "✅" });
    expect(status.update).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      "[slack] card C1:card.1: terminal frame waits 1000 ms for the status budget",
    );
    t = 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(status.update).toHaveBeenCalledTimes(1);
    expect((status.update.mock.calls[0]![0] as { text: string }).text).toBe("✅");
  });

  it("a terminal frame refused for any other reason is dropped, not re-sent", async () => {
    vi.useFakeTimers();
    const { client, statusClient, status } = clients();
    const handle = await new SlackIO(client, ev, { statusClient, statusBudget: openBudget() }).status({ title: "👀" });
    status.update.mockRejectedValueOnce(new Error("message_not_found"));
    await handle.done({ title: "✅" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(status.update).toHaveBeenCalledTimes(1);
  });

  it("createStatusClient builds a WebClient that rejects rate-limited calls instead of pausing and retrying", () => {
    const c = createStatusClient(new Secret("xoxb-test", "SLACK_BOT_TOKEN")) as unknown as {
      rejectRateLimitedCalls: boolean;
      retryConfig: { retries: number };
    };
    expect(c.rejectRateLimitedCalls).toBe(true);
    expect(c.retryConfig.retries).toBe(1);
  });

  it("a resumed run's IO edits its card through the status client too", async () => {
    const { client, statusClient, main, status } = clients();
    const io = resumeSlackIO(
      client,
      { channel: "C1", threadTs: "1.0", user: "UA", cardTs: "9.9" },
      { statusClient, statusBudget: openBudget() },
    );
    const handle = await io.status({ title: "👀 resuming" });
    expect(main.update).toHaveBeenCalledTimes(1); // the resumed card's first edit must land: main client
    handle.update({ title: "⚡" });
    expect(status.update).toHaveBeenCalledTimes(1);
    expect(status.update.mock.calls[0]![0]).toMatchObject({ channel: "C1", ts: "9.9" });
  });
});
