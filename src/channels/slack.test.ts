import { afterEach, describe, expect, it, vi } from "vitest";
import { Secret } from "../secrets.js";
import {
  actOnMissedMessage,
  catchUpDelayNote,
  classifyMessage,
  CLICK_FAILED_LINE,
  clickSlackIO,
  createStatusClient,
  handleConfirmClick,
  receiveSlackMessage,
  resumeSlackIO,
  SlackIO,
  stripMention,
  threadIncludesBot,
  wireIntakeGate,
  type SlackIntakeGate,
} from "./slack.js";
import { decideIntake, degradedIntakeLine, type IntakeDecision, type IntakeInput } from "../core/intake.js";
import { catchUpMissedMentions, type CatchUpClient, type MissedMessage } from "./slackCatchUp.js";
import type { IntakeReceipt } from "../core/runLedger/types.js";
import type { Span } from "../core/trace/types.js";
import type { RunView } from "../core/runsService.js";
import { fetchImages } from "./slack/attachments.js";
import { createStatusBudget, type StatusBudget } from "../core/statusBudget.js";
import { dispatchClick, type CoreDeps } from "../core/dispatcher.js";
import {
  OFFER_CANCELLED_LINE,
  OFFER_EXPIRED_LINE,
  OFFER_FOREIGN_LINE,
  OFFER_USED_LINE,
} from "../core/dispatch/confirm.js";
import { NO_GRANTS } from "../core/authz/index.js";
import { guardOutbound, installOutboundGuard } from "./testing/outboundGuard.js";

installOutboundGuard();

// Feature: docs/reference/specs/slack-channel.md — trigger gating (which events start a
// run) and the channel IO over the Slack Web API.

// Only the click's entry into the core is mocked (item 14): the consume, the
// requester check and the command run are the dispatcher's tests; the
// adapter's claim ends at the hand-off and starts again at the reply.
vi.mock("../core/dispatcher.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../core/dispatcher.js")>();
  return { ...mod, dispatchClick: vi.fn(async () => ({ status: "completed" })) };
});
const dispatchClickMock = vi.mocked(dispatchClick);

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

  // slack-channel.md item 13: the relay footer a Claude Code session's post
  // carries is read for the requester, then removed like the app footer.
  it("drops the trailing 'Sent by Claude in <#C…> · <permalink|thread>' relay footer, and only as a whole trailing footer", () => {
    const footer =
      "Sent by Claude in <#C0PROMPT|alice-prompting> · <https://acme.slack.com/archives/C0PROMPT/p1789504919942589?thread_ts=1789504919.942589&amp;cid=C0PROMPT|thread>";
    expect(stripMention(`<@${BOT}> agent:review <https://github.com/acme/api/pull/42>\n${footer}`, BOT)).toBe(
      "agent:review <https://github.com/acme/api/pull/42>",
    );
    expect(stripMention(`<@${BOT}> ${footer} — what does this footer mean?`, BOT)).toBe(
      `${footer} — what does this footer mean?`,
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
    const client = guardOutbound({ conversations: { replies } } as unknown as ConstructorParameters<typeof SlackIO>[0]);
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
    // Each turn carries its time in epoch ms off Slack's `ts` (session-log
    // item 9: a follow-up cuts the thread at the previous run's end by it).
    expect(items.map((i) => i.at)).toEqual([1_000, 2_000]);
  });

  it("a message whose ts does not parse carries no time; the item is kept", async () => {
    const client = guardOutbound({ conversations: { replies: vi.fn() } } as unknown as ConstructorParameters<
      typeof SlackIO
    >[0]);
    const thread = [
      { user: "UA", text: "no clock", ts: "not-a-ts" },
      { user: "UA", text: "hi", ts: "3.0" },
    ];
    const items = await new SlackIO(client, { ...ev, thread }).history();
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("no clock");
    expect("at" in items[0]).toBe(false);
  });

  it("a user turn carries its author's platform-namespaced id; a bot's turn carries none (session-log item 12)", async () => {
    const client = guardOutbound({ conversations: { replies: vi.fn() } } as unknown as ConstructorParameters<
      typeof SlackIO
    >[0]);
    const thread = [
      { user: "UALICE", text: "first ask", ts: "1.0" },
      { bot_id: "B1", text: "an answer", ts: "2.0" },
      { user: "UBOB", text: "another ask", ts: "2.5" },
      { user: "UA", text: "hi", ts: "3.0" }, // the triggering message — skipped
    ];
    const items = await new SlackIO(client, { ...ev, thread }).history();
    expect(items.map((i) => i.user)).toEqual(["slack:UALICE", undefined, "slack:UBOB"]);
  });

  it("fetches the thread itself when no prefetched page is given (mention path)", async () => {
    const replies = vi.fn(async () => ({ messages: [{ user: "UA", text: "earlier", ts: "1.0" }] }));
    const client = guardOutbound({ conversations: { replies } } as unknown as ConstructorParameters<typeof SlackIO>[0]);
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
    const c = guardOutbound({
      chat: { update, postMessage },
      assistant: { threads: { setStatus } },
    } as unknown as ConstructorParameters<typeof SlackIO>[0]);
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
    const c = guardOutbound({ chat: { postMessage }, auth: { test } } as unknown as ConstructorParameters<
      typeof SlackIO
    >[0]);
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
    const c = guardOutbound({ chat: { postMessage }, auth: { test } } as unknown as ConstructorParameters<
      typeof SlackIO
    >[0]);
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
    const client = guardOutbound({ files: { uploadV2 }, chat: { postMessage } } as unknown as ConstructorParameters<
      typeof SlackIO
    >[0]);
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
    const client = guardOutbound({ files: { uploadV2 }, chat: { postMessage } } as unknown as ConstructorParameters<
      typeof SlackIO
    >[0]);
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

describe("SlackIO.attachFile (docs/reference/specs/slack-channel.md item 10)", () => {
  const ev = { channel: "C1", user: "UA", text: "hi", ts: "3.0", threadTs: "1.0", botUserId: "UBOT" };
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("uploads the bytes as the file in the thread, titled by name, with the lead (in mrkdwn) as the comment — no chunked messages", async () => {
    const uploadV2 = vi.fn(async (_opts: Record<string, unknown>) => ({ ok: true }));
    const postMessage = vi.fn(async (_opts: Record<string, unknown>) => ({ ok: true }));
    const client = guardOutbound({ files: { uploadV2 }, chat: { postMessage } } as unknown as ConstructorParameters<
      typeof SlackIO
    >[0]);
    await new SlackIO(client, ev).attachFile({ name: "verdict-dark.png", bytes, lead: "**PR verdict mock** — dark" });
    expect(uploadV2).toHaveBeenCalledTimes(1);
    const call = uploadV2.mock.calls[0]![0];
    expect(call).toMatchObject({
      channel_id: "C1",
      thread_ts: "1.0",
      filename: "verdict-dark.png",
      title: "verdict-dark.png",
    });
    expect(Buffer.isBuffer(call.file)).toBe(true);
    expect((call.file as Buffer).equals(Buffer.from(bytes))).toBe(true);
    expect(call.content).toBeUndefined();
    expect(String(call.initial_comment)).toBe("*PR verdict mock* — dark");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("a failed upload propagates — bytes have no text fallback, so the caller reports it instead of a silent chunked reply", async () => {
    const uploadV2 = vi.fn(async (_opts: Record<string, unknown>) => {
      throw new Error("An API error occurred: missing_scope");
    });
    const postMessage = vi.fn(async (_opts: Record<string, unknown>) => ({ ok: true }));
    const client = guardOutbound({ files: { uploadV2 }, chat: { postMessage } } as unknown as ConstructorParameters<
      typeof SlackIO
    >[0]);
    await expect(new SlackIO(client, ev).attachFile({ name: "a.png", bytes, lead: "a" })).rejects.toThrow(
      /missing_scope/,
    );
    expect(postMessage).not.toHaveBeenCalled();
  });
});

// Feature: docs/reference/specs/slack-channel.md item 10 (record 0033) — the external
// upload: the bot mints a one-shot URL for exactly the ticketed size, the run's
// container POSTs the file, and `complete` shares it into the thread. The bot
// never touches the bytes.
describe("SlackIO.uploadTicket", () => {
  const ev = { channel: "C1", user: "UA", text: "hi", ts: "3.0", threadTs: "1.0", botUserId: "UBOT" };
  type Client = ConstructorParameters<typeof SlackIO>[0];

  it("mints through files.getUploadURLExternal with the name and size, and `complete` shares the file id into the thread with the lead in mrkdwn", async () => {
    const getUploadURLExternal = vi.fn(async (_o: Record<string, unknown>) => ({
      ok: true,
      upload_url: "https://files.slack.com/upload/v1/CwABAAAAB?x=y",
      file_id: "F0AAA",
    }));
    const completeUploadExternal = vi.fn(async (_o: Record<string, unknown>) => ({ ok: true }));
    const client = guardOutbound({ files: { getUploadURLExternal, completeUploadExternal } } as unknown as Client);
    const ticket = await new SlackIO(client, ev).uploadTicket({ name: "clip.mp4", size: 314_572_800 });
    expect(getUploadURLExternal).toHaveBeenCalledWith({ filename: "clip.mp4", length: 314_572_800 });
    expect(ticket.url).toBe("https://files.slack.com/upload/v1/CwABAAAAB?x=y");
    expect(completeUploadExternal).not.toHaveBeenCalled(); // nothing is shared until the POST succeeded
    await ticket.complete("**the clip** — 5 minutes");
    expect(completeUploadExternal).toHaveBeenCalledWith({
      files: [{ id: "F0AAA", title: "clip.mp4" }],
      channel_id: "C1",
      thread_ts: "1.0",
      initial_comment: "*the clip* — 5 minutes",
    });
  });

  it("a ticket Slack answers without a URL or an id is refused by name; a refused mint propagates the platform's words", async () => {
    const bare = guardOutbound({
      files: { getUploadURLExternal: vi.fn(async () => ({ ok: true })) },
    } as unknown as Client);
    await expect(new SlackIO(bare, ev).uploadTicket({ name: "a.png", size: 1 })).rejects.toThrow(
      /files\.getUploadURLExternal answered without an upload_url and file_id for a\.png/,
    );
    const refused = guardOutbound({
      files: {
        getUploadURLExternal: vi.fn(async () => {
          throw new Error("An API error occurred: missing_scope");
        }),
      },
    } as unknown as Client);
    await expect(new SlackIO(refused, ev).uploadTicket({ name: "a.png", size: 1 })).rejects.toThrow(/missing_scope/);
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
    const client = guardOutbound({
      chat: { update: main.update, postMessage: main.postMessage },
      assistant: { threads: { setStatus: main.setStatus } },
    } as unknown as Client);
    const statusClient = guardOutbound({
      chat: { update: status.update },
      assistant: { threads: { setStatus: status.setStatus } },
    } as unknown as Client);
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

// Feature: docs/reference/specs/slack-channel.md item 3 — the card lifecycle with two
// runs in one thread (a plan runner's children): the thread's inline shimmer is
// one Slack-side status, so the newest run to start owns it. A finished run's
// markers are never skipped because a sibling started: its card closes to its
// done state, and its shimmer clear lands at once when the shimmer is its own
// — while a sibling that started during the finish keeps its own "working"
// status unwiped and speaks with its own phrase from its first frame.
describe("SlackIO.status — two runs in one thread (slack-channel.md item 3)", () => {
  const event = (ts: string) => ({ channel: "C9", user: "UA", text: "", ts, threadTs: "9.0", botUserId: "UBOT" });
  type Client = ConstructorParameters<typeof SlackIO>[0];
  const openBudget = () => createStatusBudget({ perMinute: 600, channelSpacingMs: 0, now: () => 0 });
  function fixture() {
    let cards = 0;
    const main = {
      update: vi.fn(async (_o: Record<string, unknown>) => ({ ok: true })),
      postMessage: vi.fn(async (_o: Record<string, unknown>) => ({ ok: true, ts: `card.${++cards}` })),
    };
    const status = {
      update: vi.fn(async (_o: Record<string, unknown>) => ({ ok: true })),
      setStatus: vi.fn(async (_o: Record<string, unknown>) => ({ ok: true })),
    };
    const client = guardOutbound({ chat: main } as unknown as Client);
    const statusClient = guardOutbound({
      chat: { update: status.update },
      assistant: { threads: { setStatus: status.setStatus } },
    } as unknown as Client);
    const io = (ts: string) => new SlackIO(client, event(ts), { statusClient, statusBudget: openBudget() });
    const shimmerStates = () => status.setStatus.mock.calls.map((c) => (c[0] as { status: string }).status);
    return { io, status, shimmerStates };
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("finish then start: the finished run clears the thread's shimmer at once, and the sibling that starts right after sets its own within its first frame", async () => {
    const { io, status, shimmerStates } = fixture();
    const a = await io("1.1").status({ title: "👀 coding" });
    await a.done({ title: "✅ coding · done" });
    // The finished run's markers land before any sibling exists: the done frame
    // on its own card and the shimmer clear — the thread stops saying working.
    expect(status.update.mock.calls.at(-1)![0]).toMatchObject({ ts: "card.1", text: "✅ coding · done" });
    expect(shimmerStates()).toEqual([expect.stringContaining("…"), ""]);
    await io("2.1").status({ title: "👀 review" });
    // The sibling's own shimmer is set with its first frame, not left to a re-up.
    expect(shimmerStates()).toHaveLength(3);
    expect(shimmerStates().at(-1)).not.toBe("");
  });

  it("start during the other's finish: the finished run's card still closes to its done state, and its close never wipes the live sibling's shimmer", async () => {
    vi.useFakeTimers();
    const { io, status, shimmerStates } = fixture();
    const a = await io("1.1").status({ title: "👀 coding" });
    const b = await io("2.1").status({ title: "👀 review" }); // the sibling starts while A is finishing
    // A is still running while B owns the thread's shimmer: A's live 75s re-up
    // is silenced by the ownership guard on its timer — only B's speaks.
    await vi.advanceTimersByTimeAsync(75_000);
    expect(shimmerStates()).toHaveLength(3);
    expect(shimmerStates().at(-1)).not.toBe("");
    await a.done({ title: "✅ coding · done" });
    // A's done marker is not skipped because a sibling started: the terminal
    // frame is painted on A's own card.
    expect(status.update.mock.calls.at(-1)![0]).toMatchObject({ ts: "card.1", text: "✅ coding · done" });
    // …but the thread's shimmer is the live sibling's now: no clear was sent.
    expect(shimmerStates()).toHaveLength(3);
    expect(shimmerStates().at(-1)).not.toBe("");
    // The sibling still owns its shimmer: its own done clears the thread.
    await b.done({ title: "✅ review · done" });
    expect(shimmerStates().at(-1)).toBe("");
  });
});

// Feature: docs/reference/specs/slack-channel.md item 14 (record 0044) — a routed
// write the door offers as a confirmation is two buttons in the thread. The
// offer shows the exact line to run; the click enters the core through
// `dispatchClick` and its reply completes the offer message.
describe("SlackIO.offer (docs/reference/specs/slack-channel.md item 14)", () => {
  const ev = { channel: "C1", user: "UA", text: "use opus here", ts: "3.0", threadTs: "1.0", botUserId: "UBOT" };
  type Client = ConstructorParameters<typeof SlackIO>[0];
  const LINE = "config set channel --models.coding anthropic/claude-opus-5";
  const RISK = "changes the scope's settings for everyone in it until reset";
  const client = () => {
    const postMessage = vi.fn(async (_o: Record<string, unknown>) => ({ ok: true, ts: "4.0" }));
    return { c: guardOutbound({ chat: { postMessage } } as unknown as Client), postMessage };
  };
  type Block = { type: string; text?: { type: string; text: string }; elements?: Array<Record<string, unknown>> };
  const blocksOf = (call: Record<string, unknown>) => call.blocks as Block[];

  it("posts one message in the thread: the line as a code span, the risk as context, Run (primary) and Cancel carrying the id, and a text fallback that carries the line", async () => {
    const { c, postMessage } = client();
    await new SlackIO(c, ev).offer({ id: "c-1", line: LINE, risk: RISK, expiresAt: 600_000 });
    expect(postMessage).toHaveBeenCalledTimes(1);
    const call = postMessage.mock.calls[0]![0];
    expect(call).toMatchObject({ channel: "C1", thread_ts: "1.0" });
    expect(String(call.text)).toContain(LINE);
    const blocks = blocksOf(call);
    expect(blocks.map((b) => b.type)).toEqual(["section", "context", "actions"]);
    expect(blocks[0]!.text).toEqual({ type: "mrkdwn", text: `\`${LINE}\`` });
    expect(blocks[1]!.elements).toEqual([{ type: "mrkdwn", text: RISK }]);
    expect(blocks[2]!.elements).toEqual([
      {
        type: "button",
        action_id: "confirm.run",
        text: { type: "plain_text", text: "Run" },
        style: "primary",
        value: "c-1",
      },
      { type: "button", action_id: "confirm.cancel", text: { type: "plain_text", text: "Cancel" }, value: "c-1" },
    ]);
  });

  it("a command that declares no risk gets the line and the buttons alone — no context block, no footer (routing-and-config item 28); a line with a backtick rides as a fenced block; `&`, `<` and `>` are escaped for Slack, in the span and in the fallback", async () => {
    const { c, postMessage } = client();
    await new SlackIO(c, ev).offer({ id: "c-2", line: LINE, risk: "", expiresAt: 600_000 });
    expect(blocksOf(postMessage.mock.calls[0]![0]).map((b) => b.type)).toEqual(["section", "actions"]);
    const tricky = 'config instructions channel "use `npm` & <nothing> else"';
    await new SlackIO(c, ev).offer({ id: "c-3", line: tricky, risk: RISK, expiresAt: 600_000 });
    const call = postMessage.mock.calls[1]![0];
    expect(blocksOf(call)[0]!.text!.text).toBe(
      '```\nconfig instructions channel "use `npm` &amp; &lt;nothing&gt; else"\n```',
    );
    expect(String(call.text)).toContain('"use `npm` &amp; &lt;nothing&gt; else"');
    // The buttons still carry the id whatever the line looks like.
    expect(blocksOf(call)[2]!.elements!.map((e) => e.value)).toEqual(["c-3", "c-3"]);
  });

  it("a question's offer (record 0054) posts the refusal's sentence, `Did you mean:` over the line as code, the evidence as context, and Yes (primary) and No carrying the id", async () => {
    const { c, postMessage } = client();
    await new SlackIO(c, ev).offer({
      id: "q-1",
      line: "agent:ship repo:acme/api fix it",
      risk: "",
      expiresAt: 600_000,
      question: {
        text: "acme/api is not onboarded here.",
        evidence: "acme/api is one edit away from acme/apj, which is onboarded",
      },
    });
    const call = postMessage.mock.calls[0]![0];
    expect(call).toMatchObject({ channel: "C1", thread_ts: "1.0" });
    // The fallback still carries the line to type, as the record's channel-without-blocks shape does.
    expect(String(call.text)).toContain("agent:ship repo:acme/api fix it");
    expect(String(call.text)).toContain("Did you mean:");
    const blocks = blocksOf(call);
    expect(blocks.map((b) => b.type)).toEqual(["section", "section", "context", "actions"]);
    expect(blocks[0]!.text).toEqual({ type: "mrkdwn", text: "acme/api is not onboarded here." });
    expect(blocks[1]!.text).toEqual({ type: "mrkdwn", text: "Did you mean:\n`agent:ship repo:acme/api fix it`" });
    expect(blocks[2]!.elements).toEqual([
      { type: "mrkdwn", text: "acme/api is one edit away from acme/apj, which is onboarded" },
    ]);
    expect(blocks[3]!.elements).toEqual([
      {
        type: "button",
        action_id: "confirm.run",
        text: { type: "plain_text", text: "Yes" },
        style: "primary",
        value: "q-1",
      },
      { type: "button", action_id: "confirm.cancel", text: { type: "plain_text", text: "No" }, value: "q-1" },
    ]);
  });
});

describe("handleConfirmClick — the action intake (docs/reference/specs/slack-channel.md item 14)", () => {
  type Client = ConstructorParameters<typeof SlackIO>[0];
  const LINE_SPAN = "`config set channel --models.coding anthropic/claude-opus-5`";
  const FALLBACK =
    "config set channel --models.coding anthropic/claude-opus-5\nchanges the scope's settings\nconfirmation required by the built-in default";
  /** The offer message as Slack hands it back on the click: its blocks with the ids Slack stamped. */
  const offerBlocks = [
    { type: "section", block_id: "b1", text: { type: "mrkdwn", text: LINE_SPAN } },
    {
      type: "context",
      block_id: "b2",
      elements: [
        { type: "mrkdwn", text: "changes the scope's settings" },
        { type: "mrkdwn", text: "confirmation required by the built-in default" },
      ],
    },
    {
      type: "actions",
      block_id: "b3",
      elements: [
        { type: "button", action_id: "confirm.run", value: "c-1", text: { type: "plain_text", text: "Run" } },
        { type: "button", action_id: "confirm.cancel", value: "c-1", text: { type: "plain_text", text: "Cancel" } },
      ],
    },
  ];
  /** A scripted Web API that records the order of every call beside the ack. */
  function scripted() {
    const calls: string[] = [];
    const update = vi.fn(async (_o: Record<string, unknown>) => {
      calls.push("chat.update");
      return { ok: true };
    });
    const postMessage = vi.fn(async (_o: Record<string, unknown>) => {
      calls.push("chat.postMessage");
      return { ok: true, ts: "5.0" };
    });
    const replies = vi.fn(async () => {
      calls.push("conversations.replies");
      return { ok: true, messages: [] };
    });
    const ack = vi.fn(async () => {
      calls.push("ack");
    });
    const grantsFor = vi.fn(() => NO_GRANTS);
    const deps = { config: { config: {}, grantsFor } } as unknown as CoreDeps;
    const c = guardOutbound({ chat: { update, postMessage }, conversations: { replies } } as unknown as Client);
    return { calls, update, postMessage, replies, ack, grantsFor, deps, clients: { client: c, statusClient: c } };
  }
  /** A `block_actions` payload for one of the offer's buttons, as Bolt hands it to the listener. */
  function payload(
    actionId: string,
    opts: { user?: string; value?: string | undefined; message?: object; label?: string } = {},
  ) {
    const value = "value" in opts ? opts.value : "c-1";
    const action = {
      type: "button" as const,
      block_id: "b3",
      action_id: actionId,
      action_ts: "4.5",
      // The pressed button's own label rides the payload; the taken-offer note
      // reads it, so a question's Yes reads "Yes clicked by …".
      text: { type: "plain_text" as const, text: opts.label ?? (actionId === "confirm.cancel" ? "Cancel" : "Run") },
      ...(value !== undefined ? { value } : {}),
    };
    const message =
      "message" in opts
        ? opts.message
        : { type: "message", ts: "4.0", thread_ts: "1.0", text: FALLBACK, blocks: offerBlocks };
    const body = {
      type: "block_actions" as const,
      user: { id: opts.user ?? "UA", username: "a" },
      channel: { id: "C1", name: "general" },
      ...(message !== undefined ? { message } : {}),
      container: { type: "message", message_ts: "4.0", channel_id: "C1", thread_ts: "1.0", is_ephemeral: false },
      actions: [action],
      team: null,
      token: "",
      response_url: "",
      trigger_id: "",
      api_app_id: "",
    };
    return { body, action } as unknown as Pick<Parameters<typeof handleConfirmClick>[2], "body" | "action">;
  }
  /** The core's side of the hand-off: it answers through the handle it was given. */
  const coreReplies = (text: string) =>
    dispatchClickMock.mockImplementationOnce(async (_deps, click) => {
      await click.io.reply(text);
      return { status: "completed" };
    });
  type Block = { type: string; text?: { type: string; text: string } };
  const blocksOf = (call: Record<string, unknown>) => call.blocks as Block[];

  afterEach(() => {
    dispatchClickMock.mockReset();
    dispatchClickMock.mockResolvedValue({ status: "completed" });
    vi.restoreAllMocks();
  });

  it("acknowledges first, resolves the clicker as the requester, builds the handle for the payload's channel and thread, and hands dispatchClick the id, kind confirm and the actor; the reply completes the offer message — line and context kept, buttons gone, the reply under them", async () => {
    const s = scripted();
    coreReplies("routed: config set channel --models.coding anthropic/claude-opus-5\n✅ set for this channel");
    await handleConfirmClick(s.deps, s.clients, { ack: s.ack, ...payload("confirm.run") }, "UBOT");
    // The ack is the first thing that happens — before any Web API call and before the core.
    expect(s.calls[0]).toBe("ack");
    expect(s.ack).toHaveBeenCalledTimes(1);
    expect(dispatchClickMock).toHaveBeenCalledTimes(1);
    const [, click] = dispatchClickMock.mock.calls[0]!;
    expect(click).toMatchObject({ kind: "confirm", id: "c-1" });
    // The clicker is resolved as a message's requester is: the person, namespaced, with the thread as origin.
    expect(click.actor).toMatchObject({
      kind: "user",
      id: "slack:UA",
      origin: { channelId: "slack:C1", threadKey: "slack:C1:1.0" },
    });
    expect(s.grantsFor).toHaveBeenCalledWith("slack:UA");
    expect(click.io).toBeInstanceOf(SlackIO);
    // Two edits of the offer message and no new post: the take right after the
    // ack (buttons gone, the note), then the reply completing it.
    expect(s.update).toHaveBeenCalledTimes(2);
    expect(s.postMessage).not.toHaveBeenCalled();
    expect(s.calls.slice(0, 2)).toEqual(["ack", "chat.update"]);
    const taken = s.update.mock.calls[0]![0];
    expect(taken).toMatchObject({ channel: "C1", ts: "4.0" });
    expect(blocksOf(taken).some((b) => b.type === "actions")).toBe(false);
    expect(JSON.stringify(taken.blocks)).toContain("*Run* clicked by <@UA> · running…");
    const call = s.update.mock.calls[1]![0];
    expect(call).toMatchObject({ channel: "C1", ts: "4.0" });
    const blocks = blocksOf(call);
    expect(blocks.map((b) => b.type)).toEqual(["section", "context", "section"]);
    expect(blocks[0]).toEqual(offerBlocks[0]);
    expect(blocks[1]).toEqual(offerBlocks[1]);
    expect(blocks[2]!.text!.text).toContain("✅ set for this channel");
    expect(String(call.text)).toContain("config set channel --models.coding anthropic/claude-opus-5");
    expect(String(call.text)).toContain("✅ set for this channel");
  });

  it("a later reply on the same handle — a deferred command's settle follow-up — posts in the offer's thread; the offer message is completed once", async () => {
    const s = scripted();
    coreReplies("routed: repo onboard acme/api\n⏳ onboarding started");
    await handleConfirmClick(s.deps, s.clients, { ack: s.ack, ...payload("confirm.run") });
    const io = dispatchClickMock.mock.calls[0]![1].io;
    await io.reply("✅ acme/api onboarded");
    expect(s.update).toHaveBeenCalledTimes(2);
    expect(s.postMessage).toHaveBeenCalledTimes(1);
    expect(s.postMessage.mock.calls[0]![0]).toMatchObject({
      channel: "C1",
      thread_ts: "1.0",
      text: "✅ acme/api onboarded",
    });
  });

  it("a question's Yes rides the same intake and the taken note reads the pressed button's own label: `Yes clicked by …` (record 0054)", async () => {
    const s = scripted();
    coreReplies("working on it");
    await handleConfirmClick(s.deps, s.clients, { ack: s.ack, ...payload("confirm.run", { label: "Yes" }) });
    expect(dispatchClickMock.mock.calls[0]![1]).toMatchObject({ kind: "confirm", id: "c-1" });
    expect(JSON.stringify(s.update.mock.calls[0]![0].blocks)).toContain("*Yes* clicked by <@UA> · running…");
    expect(String(s.update.mock.calls[0]![0].text)).toContain("Yes clicked · running…");
    const noS = scripted();
    coreReplies(OFFER_CANCELLED_LINE);
    await handleConfirmClick(noS.deps, noS.clients, { ack: noS.ack, ...payload("confirm.cancel", { label: "No" }) });
    expect(dispatchClickMock.mock.calls[1]![1]).toMatchObject({ kind: "cancel", id: "c-1" });
    expect(JSON.stringify(noS.update.mock.calls[0]![0].blocks)).toContain("*No* clicked by <@UA> · cancelling…");
  });

  it("Cancel hands dispatchClick kind cancel with the same id, and the message reads `Cancelled; nothing ran` under the line", async () => {
    const s = scripted();
    coreReplies(OFFER_CANCELLED_LINE);
    await handleConfirmClick(s.deps, s.clients, { ack: s.ack, ...payload("confirm.cancel") });
    expect(dispatchClickMock.mock.calls[0]![1]).toMatchObject({ kind: "cancel", id: "c-1" });
    expect(JSON.stringify(s.update.mock.calls[0]![0].blocks)).toContain("*Cancel* clicked by <@UA> · cancelling…");
    const call = s.update.mock.calls[1]![0];
    const blocks = blocksOf(call);
    expect(blocks[0]).toEqual(offerBlocks[0]);
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
    expect(blocks.at(-1)!.text!.text).toBe(OFFER_CANCELLED_LINE);
  });

  it.each([OFFER_EXPIRED_LINE, OFFER_FOREIGN_LINE, OFFER_USED_LINE])(
    "a refusal reads its named line under the line, buttons gone: %s",
    async (line) => {
      const s = scripted();
      coreReplies(line);
      await handleConfirmClick(s.deps, s.clients, { ack: s.ack, ...payload("confirm.run") });
      expect(s.update).toHaveBeenCalledTimes(2);
      const blocks = blocksOf(s.update.mock.calls[1]![0]);
      expect(blocks[0]).toEqual(offerBlocks[0]);
      expect(blocks.some((b) => b.type === "actions")).toBe(false);
      expect(blocks.at(-1)!.text!.text).toBe(line);
    },
  );

  it("the buttons are gone before the core runs: the edit right after the ack drops the actions block and notes who pressed which, so a second press has nothing to press; the completion then replaces the note with the answer", async () => {
    const s = scripted();
    dispatchClickMock.mockImplementationOnce(async (_deps, click) => {
      s.calls.push("dispatchClick");
      await click.io.reply("routed: costs snapshot\nCosts snapshot taken");
      return { status: "completed" };
    });
    await handleConfirmClick(s.deps, s.clients, { ack: s.ack, ...payload("confirm.run") });
    // The take is the first Web API call after the ack and lands before the core is asked.
    expect(s.calls.indexOf("chat.update")).toBe(1);
    expect(s.calls.indexOf("chat.update")).toBeLessThan(s.calls.indexOf("dispatchClick"));
    const taken = blocksOf(s.update.mock.calls[0]![0]);
    expect(taken.map((b) => b.type)).toEqual(["section", "context", "context"]);
    expect(taken[0]).toEqual(offerBlocks[0]);
    expect(taken[1]).toEqual(offerBlocks[1]);
    expect(JSON.stringify(taken[2])).toContain("*Run* clicked by <@UA> · running…");
    expect(String(s.update.mock.calls[0]![0].text)).toContain("Run clicked · running…");
    // The completion is built from the offer as posted: the note is gone, the answer is under the line.
    const done = blocksOf(s.update.mock.calls[1]![0]);
    expect(done.map((b) => b.type)).toEqual(["section", "context", "section"]);
    expect(done.at(-1)!.text!.text).toContain("Costs snapshot taken");
    expect(JSON.stringify(done)).not.toContain("running…");
  });

  it("a take that fails is logged and the click still reaches the core and completes the message", async () => {
    const s = scripted();
    s.update.mockRejectedValueOnce(new Error("message_not_found"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    coreReplies(OFFER_CANCELLED_LINE);
    await handleConfirmClick(s.deps, s.clients, { ack: s.ack, ...payload("confirm.cancel") });
    expect(error.mock.calls.map((c) => String(c[0])).join("\n")).toContain("could not be taken down");
    expect(dispatchClickMock).toHaveBeenCalledTimes(1);
    expect(s.update).toHaveBeenCalledTimes(2);
    expect(blocksOf(s.update.mock.calls[1]![0]).at(-1)!.text!.text).toBe(OFFER_CANCELLED_LINE);
  });

  it("a click by someone who is not the requester reaches dispatchClick as that actor — the core decides `foreign`, the adapter decides nothing", async () => {
    const s = scripted();
    coreReplies(OFFER_FOREIGN_LINE);
    await handleConfirmClick(s.deps, s.clients, { ack: s.ack, ...payload("confirm.run", { user: "UOTHER" }) });
    expect(dispatchClickMock).toHaveBeenCalledTimes(1);
    expect(dispatchClickMock.mock.calls[0]![1].actor).toMatchObject({ kind: "user", id: "slack:UOTHER" });
    expect(s.grantsFor).toHaveBeenCalledWith("slack:UOTHER");
    expect(JSON.stringify(s.update.mock.calls[0]![0].blocks)).toContain("clicked by <@UOTHER>");
    expect(blocksOf(s.update.mock.calls[1]![0]).at(-1)!.text!.text).toBe(OFFER_FOREIGN_LINE);
  });

  it("a throw out of the core is caught: logged, the offer message completed with the failure line, and the handler resolves", async () => {
    const s = scripted();
    dispatchClickMock.mockRejectedValueOnce(new Error("the store fell over"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      handleConfirmClick(s.deps, s.clients, { ack: s.ack, ...payload("confirm.run") }),
    ).resolves.toBeUndefined();
    expect(s.ack).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.map((c) => String(c[0])).join("\n")).toContain("the store fell over");
    expect(s.update).toHaveBeenCalledTimes(2);
    const blocks = blocksOf(s.update.mock.calls[1]![0]);
    expect(blocks[0]).toEqual(offerBlocks[0]);
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
    expect(blocks.at(-1)!.text!.text).toBe(CLICK_FAILED_LINE);
  });

  it("a failure to complete the message after a throw is logged too and never escapes the handler", async () => {
    const s = scripted();
    dispatchClickMock.mockRejectedValueOnce(new Error("the store fell over"));
    s.update.mockRejectedValue(new Error("message_not_found"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      handleConfirmClick(s.deps, s.clients, { ack: s.ack, ...payload("confirm.run") }),
    ).resolves.toBeUndefined();
    expect(error.mock.calls.map((c) => String(c[0])).join("\n")).toContain("message_not_found");
  });

  it("an action without a value, a `confirm.*` id the adapter does not know, or a payload without its message is acknowledged and ignored — nothing reaches the core, nothing is updated", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const click of [
      payload("confirm.run", { value: undefined }),
      payload("confirm.other"),
      payload("confirm.run", { message: undefined }),
    ]) {
      const s = scripted();
      await handleConfirmClick(s.deps, s.clients, { ack: s.ack, ...click });
      expect(s.ack).toHaveBeenCalledTimes(1);
      expect(s.update).not.toHaveBeenCalled();
      expect(s.postMessage).not.toHaveBeenCalled();
    }
    expect(dispatchClickMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(3);
  });

  it("clickSlackIO: a reply longer than a section carries completes the message with its first part and posts the rest in the thread", async () => {
    const s = scripted();
    const io = clickSlackIO(
      s.clients.client,
      { channel: "C1", threadTs: "1.0", user: "UA", offer: { ts: "4.0", text: FALLBACK, blocks: offerBlocks } },
      { statusClient: s.clients.statusClient },
    );
    await io.reply(`${"x".repeat(3100)}\ntail`);
    expect(s.update).toHaveBeenCalledTimes(1);
    expect(blocksOf(s.update.mock.calls[0]![0]).at(-1)!.text!.text).toBe("x".repeat(3000));
    expect(s.postMessage).toHaveBeenCalledTimes(1);
    expect(s.postMessage.mock.calls[0]![0]).toMatchObject({
      channel: "C1",
      thread_ts: "1.0",
      text: `${"x".repeat(100)}\ntail`,
    });
  });
});

// Feature: docs/reference/specs/slack-channel.md item 15 (record 0058) — the
// intake gate before the 👀: an unmentioned reply in a bot thread gets its
// verdict after the redelivery guard and before anything visible (the ack, the
// downloads); `silent` produces nothing; `addressed` proceeds exactly as today
// with the thread's runs page handed on; `always` never reaches intake.
describe("receiveSlackMessage — the intake gate (docs/reference/specs/slack-channel.md item 15)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const NOW = 160_000;
  const POLICY = { staging: false, maxBytesPerMessage: 1_000_000 };
  let seq = 0;
  /** A fresh ts per event: unique (the module-level handled-set claims each) and
   *  recent (an old ts would make the redelivery guard pay its thread fetch). */
  const nextTs = () => (Date.now() / 1000 + ++seq).toFixed(6);
  const png = { id: "f1", name: "a.png", mimetype: "image/png", size: 4, url_private_download: "https://f.test/a" };

  /** A scripted Web API recording the order of the calls the golden pins.
   *  `replyPages` scripts successive `conversations.replies` answers; a page
   *  with `next` hands a cursor onward, the last page repeats. */
  function gateClient(replyPages: Array<{ messages: Array<Record<string, unknown>>; next?: string }> = []) {
    const calls: string[] = [];
    const add = vi.fn(async () => {
      calls.push("reactions.add");
      return { ok: true };
    });
    const postMessage = vi.fn(async () => {
      calls.push("chat.postMessage");
      return { ok: true, ts: "n.1" };
    });
    let nthReply = 0;
    const replies = vi.fn(async (_o: Record<string, unknown>) => {
      calls.push("conversations.replies");
      const page = replyPages[Math.min(nthReply++, replyPages.length - 1)] ?? { messages: [] };
      return {
        ok: true,
        messages: page.messages,
        ...(page.next !== undefined ? { response_metadata: { next_cursor: page.next } } : {}),
      };
    });
    const info = vi.fn(async () => ({ ok: true, channel: { name: "general" } }));
    const usersInfo = vi.fn(async () => ({ ok: true, user: { real_name: "Ada" } }));
    const test = vi.fn(async () => ({ ok: true }));
    const client = guardOutbound({
      reactions: { add },
      chat: { postMessage },
      conversations: { replies, info },
      users: { info: usersInfo },
      auth: { test },
    } as unknown as Parameters<typeof receiveSlackMessage>[0]);
    return { calls, add, postMessage, replies, client };
  }

  /** Downloads recorded in the same order array as the Web API calls. */
  function stubDownloads(calls: string[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls.push("download");
        return new Response(new Uint8Array(4).fill(7), { status: 200, headers: { "content-type": "image/png" } });
      }),
    );
  }

  function spanStub() {
    const attrs: Record<string, unknown> = {};
    return { attrs, span: { setAttrs: (a: Record<string, unknown>) => Object.assign(attrs, a) } as unknown as Span };
  }

  const parentTs = "100.000000";
  /** The page threadIfBotInIt fetched: the bot's own post as the parent, the asker's reply. */
  const shortThread = [
    { user: BOT, text: "report ready", ts: parentTs },
    { user: "UASKER", text: "thanks", ts: "110.000000" },
  ];

  function followUp(over: Record<string, unknown> = {}) {
    return {
      channel: "CGATE",
      user: "UASKER",
      text: "and the tests?",
      ts: nextTs(),
      threadTs: parentTs,
      botUserId: BOT,
      trigger: "thread-follow-up" as const,
      thread: shortThread,
      files: [png],
      ...over,
    };
  }

  const decided = (verdict: "addressed" | "silent", receipt: IntakeDecision["receipt"] = "inserted") =>
    vi.fn(async (): Promise<IntakeDecision> => ({ verdict, reason: "r", source: "model", receipt }));

  /** A gate over fakes: the mode, a scripted verdict seam, no ledger. */
  function gateOf(over: Partial<SlackIntakeGate> & { mode?: "mention" | "classify" | "always" } = {}) {
    const decide = over.decideIntake ?? decided("addressed");
    const gate: SlackIntakeGate = {
      intakeModeFor: () => over.mode ?? "classify",
      decideIntake: decide as unknown as typeof decideIntake,
      deps: { model: async () => "unused", ledger: null, now: () => NOW },
      modelRef: "anthropic/fast-model",
      gen: 7,
      ...(over.runs !== undefined ? { runs: over.runs } : {}),
      ...(over.confirmations !== undefined ? { confirmations: over.confirmations } : {}),
    };
    return { decide: decide as ReturnType<typeof decided>, gate };
  }

  /** An in-memory receipt ledger with the store's insert-if-absent contract. */
  function fakeLedger(seedKey?: string, seed?: Partial<IntakeReceipt>) {
    const rows = new Map<string, IntakeReceipt>();
    if (seedKey)
      rows.set(seedKey, {
        verdict: "addressed",
        reason: "another caller's row",
        source: "model",
        mode: "classify",
        model: "anthropic/fast-model",
        gen: 99,
        threadKey: "slack:CGATE:100.000000",
        decidedAt: 1,
        ...seed,
      });
    return {
      rows,
      readIntake: async (key: string) => rows.get(key),
      recordIntake: async (key: string, receipt: IntakeReceipt) => {
        const existing = rows.get(key);
        if (existing) return { inserted: false, stored: existing };
        rows.set(key, receipt);
        return { inserted: true, stored: receipt };
      },
    };
  }

  it("the always golden: a thread follow-up under always is byte-identical to the gate-less path — dedupe, 👀, downloads, the message — and intake is never asked", async () => {
    const bare = gateClient();
    stubDownloads(bare.calls);
    const a = await receiveSlackMessage(bare.client, followUp(), spanStub().span, POLICY, []);
    expect(a?.message.text).toBe("and the tests?");
    const gated = gateClient();
    stubDownloads(gated.calls);
    const { gate, decide } = gateOf({ mode: "always" });
    const b = await receiveSlackMessage(gated.client, followUp(), spanStub().span, POLICY, [], gate);
    expect(b?.message.text).toBe("and the tests?");
    expect(decide).not.toHaveBeenCalled();
    expect(gated.calls).toEqual(bare.calls);
    expect(gated.calls[0]).toBe("reactions.add");
    expect(gated.calls).toContain("download");
  });

  it("an accepted PNG keeps its zero-based Slack staging source when the artifact path is configured", async () => {
    const s = gateClient();
    stubDownloads(s.calls);
    const ev = followUp();
    const out = await receiveSlackMessage(
      s.client,
      ev,
      spanStub().span,
      { staging: true, maxBytesPerMessage: 1_000_000 },
      [],
    );
    expect(out?.message.images).toEqual([
      {
        mediaType: "image/png",
        data: "BwcHBw==",
        name: "a.png",
        staged: {
          name: "a.png",
          size: 4,
          type: "image/png",
          url: "https://f.test/a",
          messageId: ev.ts,
          workspaceIndex: 0,
        },
      },
    ]);
    // The triggering turn still uses the inline image. Only a coordinator fold
    // promotes its source into IncomingMessage.staged for a later child.
    expect(out?.message.staged).toBeUndefined();
  });

  it("a caught-up message under always keeps its golden too: 👀, the ⏱ delay note, then the downloads", async () => {
    const s = gateClient();
    stubDownloads(s.calls);
    const { gate, decide } = gateOf({ mode: "always" });
    const out = await receiveSlackMessage(
      s.client,
      followUp({ ts: (Date.now() / 1000 - 120).toFixed(6), caughtUp: true }),
      spanStub().span,
      POLICY,
      [],
      gate,
    );
    expect(out).toBeDefined();
    expect(decide).not.toHaveBeenCalled();
    expect(s.calls.slice(0, 2)).toEqual(["reactions.add", "chat.postMessage"]);
    expect(s.calls).toContain("download");
  });

  it("a mention and a DM never reach the gate in any mode (a top-level post never reaches handle at all): the sequence is the golden", async () => {
    for (const trigger of ["mention", "dm"] as const) {
      const s = gateClient();
      stubDownloads(s.calls);
      const { gate, decide } = gateOf({ mode: "classify" });
      const out = await receiveSlackMessage(s.client, followUp({ trigger }), spanStub().span, POLICY, [], gate);
      expect(out).toBeDefined();
      expect(decide).not.toHaveBeenCalled();
      expect(s.calls[0]).toBe("reactions.add");
    }
    // A top-level channel post is skipped by trigger gating before handle().
    expect(classifyMessage({ channel_type: "channel", text: "hello" }, BOT)).toBe("skip");
  });

  it("a message a stored receipt already decided (intakeDecided) is never decided twice", async () => {
    const s = gateClient();
    stubDownloads(s.calls);
    const { gate, decide } = gateOf({ mode: "classify" });
    const out = await receiveSlackMessage(
      s.client,
      followUp({ intakeDecided: true }),
      spanStub().span,
      POLICY,
      [],
      gate,
    );
    expect(out).toBeDefined();
    expect(decide).not.toHaveBeenCalled();
    expect(s.calls[0]).toBe("reactions.add");
  });

  it("the caught-up bypass is lifted: a caught-up reply with intakeDecided proceeds without a second verdict, and one without it is gated like a live reply", async () => {
    // The catch-up's act decided it (a stored receipt or its own verdict) — no second decision.
    const s = gateClient();
    stubDownloads(s.calls);
    const { gate, decide } = gateOf({ mode: "classify" });
    const out = await receiveSlackMessage(
      s.client,
      followUp({ ts: (Date.now() / 1000 - 120).toFixed(6), caughtUp: true, intakeDecided: true }),
      spanStub().span,
      POLICY,
      [],
      gate,
    );
    expect(out).toBeDefined();
    expect(decide).not.toHaveBeenCalled();
    expect(s.calls[0]).toBe("reactions.add");
    // Undecided (a mode flip between the scan and the act): the gate decides it fresh.
    const s2 = gateClient();
    stubDownloads(s2.calls);
    const { gate: gate2, decide: decide2 } = gateOf({ mode: "classify" });
    const out2 = await receiveSlackMessage(
      s2.client,
      followUp({ ts: (Date.now() / 1000 - 121).toFixed(6), caughtUp: true }),
      spanStub().span,
      POLICY,
      [],
      gate2,
    );
    expect(decide2).toHaveBeenCalledTimes(1);
    expect(out2).toBeDefined();
  });

  it("a userless event resolves the intake mode with no user scope: intakeModeFor is handed undefined, never a made-up id", async () => {
    const s = gateClient();
    stubDownloads(s.calls);
    const { gate } = gateOf({ mode: "always" });
    const modeFor = vi.fn(() => "always" as const);
    gate.intakeModeFor = modeFor;
    await receiveSlackMessage(s.client, followUp({ user: undefined }), spanStub().span, POLICY, [], gate);
    expect(modeFor).toHaveBeenCalledWith("slack:CGATE:100.000000", undefined, "slack:CGATE");
  });

  it("silent: no 👀, no download, no note, no message to dispatch — and the span carries the verdict, its source and the receipt", async () => {
    const s = gateClient();
    stubDownloads(s.calls);
    const { attrs, span } = spanStub();
    const { gate } = gateOf({ decideIntake: decided("silent") as unknown as typeof decideIntake });
    const out = await receiveSlackMessage(s.client, followUp(), span, POLICY, [], gate);
    expect(out).toBeUndefined();
    expect(s.calls).toEqual([]);
    expect(attrs).toMatchObject({ intake: "silent", intakeSource: "model", intakeReceipt: "inserted" });
  });

  it("addressed: the verdict and its receipt come first, the 👀 and the downloads after, and the runs page rides out as thread for dispatch", async () => {
    const s = gateClient();
    stubDownloads(s.calls);
    const page: RunView[] = [
      { id: "run-1", agent: "coding", userId: "slack:UASKER", startedAt: 100_000, finished: true } as RunView,
    ];
    const decide = vi.fn(async (): Promise<IntakeDecision> => {
      s.calls.push("decideIntake");
      return { verdict: "addressed", reason: "r", source: "model", receipt: "inserted" };
    });
    const { gate } = gateOf({
      decideIntake: decide as unknown as typeof decideIntake,
      runs: { listRuns: async () => ({ runs: page, total: 1 }) } as unknown as SlackIntakeGate["runs"],
    });
    const { attrs, span } = spanStub();
    const out = await receiveSlackMessage(s.client, followUp(), span, POLICY, [], gate);
    expect(out?.thread).toEqual(page);
    expect(s.calls.indexOf("decideIntake")).toBe(0);
    expect(s.calls.indexOf("decideIntake")).toBeLessThan(s.calls.indexOf("reactions.add"));
    expect(s.calls.indexOf("reactions.add")).toBeLessThan(s.calls.indexOf("download"));
    expect(attrs).toMatchObject({ intake: "addressed", intakeSource: "model", intakeReceipt: "inserted" });
  });

  it("mode mention: the model is never called, the verdict is silent by mode, and the receipt row is written", async () => {
    const s = gateClient();
    stubDownloads(s.calls);
    const ledger = fakeLedger();
    const model = vi.fn(async () => ({ tool: "intake", input: { answer: "addressed", reason: "no" } }));
    const { gate } = gateOf({ mode: "mention", decideIntake: decideIntake });
    gate.deps = { model, ledger, now: () => NOW };
    const ev = followUp();
    const { attrs, span } = spanStub();
    const out = await receiveSlackMessage(s.client, ev, span, POLICY, [], gate);
    expect(out).toBeUndefined();
    expect(model).not.toHaveBeenCalled();
    expect(s.calls).toEqual([]);
    expect(attrs).toMatchObject({ intake: "silent", intakeSource: "mode", intakeReceipt: "inserted" });
    expect(ledger.rows.get(`CGATE:${ev.ts}`)).toMatchObject({ verdict: "silent", mode: "mention", gen: 7 });
  });

  it("not the inserter: a receipt another caller stored — addressed or not — yields no action here (only the inserter acts)", async () => {
    const s = gateClient();
    stubDownloads(s.calls);
    const ev = followUp();
    const ledger = fakeLedger(`CGATE:${ev.ts}`);
    const { gate } = gateOf({ decideIntake: decideIntake });
    gate.deps = {
      model: async () => {
        throw new Error("must not be called: the receipt answers");
      },
      ledger,
      now: () => NOW,
    };
    const { attrs, span } = spanStub();
    const out = await receiveSlackMessage(s.client, ev, span, POLICY, [], gate);
    expect(out).toBeUndefined();
    expect(s.calls).toEqual([]);
    expect(attrs).toMatchObject({ intake: "addressed", intakeReceipt: "existing" });
  });

  it("degraded, never silent by accident: a throwing write still dispatches an addressed reply (receipt failed), a throwing read decides as if none (inserted), and the null ledger acts with receipt absent", async () => {
    const model = async () => ({ tool: "intake", input: { answer: "addressed", reason: "asked the bot" } });
    // write throws
    let s = gateClient();
    stubDownloads(s.calls);
    let { gate } = gateOf({ decideIntake: decideIntake });
    gate.deps = {
      model,
      ledger: {
        readIntake: async () => undefined,
        recordIntake: async () => {
          throw new Error("DO down");
        },
      },
      now: () => NOW,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let stub = spanStub();
    let out = await receiveSlackMessage(s.client, followUp(), stub.span, POLICY, [], gate);
    expect(out).toBeDefined();
    expect(s.calls[0]).toBe("reactions.add");
    expect(stub.attrs).toMatchObject({ intake: "addressed", intakeReceipt: "failed" });
    // read throws, write lands
    s = gateClient();
    stubDownloads(s.calls);
    const ledger = fakeLedger();
    ({ gate } = gateOf({ decideIntake: decideIntake }));
    gate.deps = {
      model,
      ledger: {
        readIntake: async () => {
          throw new Error("DO down");
        },
        recordIntake: ledger.recordIntake,
      },
      now: () => NOW,
    };
    stub = spanStub();
    out = await receiveSlackMessage(s.client, followUp(), stub.span, POLICY, [], gate);
    expect(out).toBeDefined();
    expect(stub.attrs).toMatchObject({ intake: "addressed", intakeReceipt: "inserted" });
    // null ledger
    s = gateClient();
    stubDownloads(s.calls);
    ({ gate } = gateOf({ decideIntake: decideIntake }));
    gate.deps = { model, ledger: null, now: () => NOW };
    stub = spanStub();
    out = await receiveSlackMessage(s.client, followUp(), stub.span, POLICY, [], gate);
    expect(out).toBeDefined();
    expect(stub.attrs).toMatchObject({ intake: "addressed", intakeReceipt: "absent" });
    warn.mockRestore();
  });

  it("a second live delivery of the same event is dropped by the redelivery guard with no second verdict", async () => {
    const s = gateClient();
    stubDownloads(s.calls);
    const decide = decided("addressed");
    const { gate } = gateOf({ decideIntake: decide as unknown as typeof decideIntake });
    const ev = followUp();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await receiveSlackMessage(s.client, ev, spanStub().span, POLICY, [], gate);
    expect(first).toBeDefined();
    expect(decide).toHaveBeenCalledTimes(1);
    const { attrs, span } = spanStub();
    const second = await receiveSlackMessage(s.client, ev, span, POLICY, [], gate);
    log.mockRestore();
    expect(second).toBeUndefined();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(attrs).toMatchObject({ dedupe: "duplicate" });
  });

  it("a thread past the prefetched page (50 messages) pages forward to the tail (replies come oldest-first): cursor followed, duplicates dropped, the newest turns kept; a short thread never fetches", async () => {
    const long = Array.from({ length: 50 }, (_, i) => ({
      user: i % 2 ? "UASKER" : BOT,
      text: `turn ${i}`,
      ts: `${100 + i}.000000`,
    }));
    const tail = Array.from({ length: 12 }, (_, i) => ({
      user: i % 2 ? BOT : "UASKER",
      text: `tail ${i}`,
      ts: `${200 + i}.000000`,
    }));
    const s = gateClient([
      // Slack re-sends the parent; the dedupe must drop it, and the cursor hands on.
      { messages: [{ user: BOT, text: "turn 0", ts: "100.000000" }, ...tail], next: "c2" },
      { messages: [{ user: "UASKER", text: "the newest turn", ts: "500.000000" }] },
    ]);
    stubDownloads(s.calls);
    let input: IntakeInput | undefined;
    const decide = vi.fn(async (i: IntakeInput): Promise<IntakeDecision> => {
      input = i;
      return { verdict: "silent", reason: "r", source: "model", receipt: "inserted" };
    });
    const { gate } = gateOf({ decideIntake: decide as unknown as typeof decideIntake });
    const ev = followUp({ thread: long });
    await receiveSlackMessage(s.client, ev, spanStub().span, POLICY, [], gate);
    expect(s.replies).toHaveBeenCalledTimes(2);
    expect(s.replies.mock.calls[0]![0]).toEqual({
      channel: "CGATE",
      ts: parentTs,
      oldest: "149.000000",
      inclusive: false,
      limit: 50,
    });
    expect(s.replies.mock.calls[1]![0]).toEqual({ channel: "CGATE", ts: parentTs, cursor: "c2", limit: 50 });
    // The verdict sees the thread's END — the last 12 turns — never its head.
    expect(input!.turns.map((t) => t.text)).toEqual([...tail.slice(1).map((t) => t.text), "the newest turn"]);
    const short = gateClient();
    stubDownloads(short.calls);
    const { gate: g2 } = gateOf({ decideIntake: decide as unknown as typeof decideIntake });
    await receiveSlackMessage(short.client, followUp(), spanStub().span, POLICY, [], g2);
    expect(short.replies).not.toHaveBeenCalled();
  });

  it("the labels and the adapter's facts: bot/requester/person by user id against the runs page, the live run, the pending confirmation, the other mention, the bot's last turn and the bot-started thread", async () => {
    const s = gateClient();
    stubDownloads(s.calls);
    const page: RunView[] = [
      { id: "live", agent: "coding", userId: "slack:UASKER", startedAt: 100_000, finished: false },
      { id: "prev", agent: "general", userId: "slack:UOTHER", startedAt: 50_000, finished: true },
    ] as RunView[];
    let input: IntakeInput | undefined;
    const decide = vi.fn(async (i: IntakeInput): Promise<IntakeDecision> => {
      input = i;
      return { verdict: "silent", reason: "r", source: "model", receipt: "inserted" };
    });
    const { gate } = gateOf({
      decideIntake: decide as unknown as typeof decideIntake,
      runs: { listRuns: async () => ({ runs: page, total: 2 }) } as unknown as SlackIntakeGate["runs"],
      confirmations: {
        pendingByThread: async () => ({ message: { userId: "slack:UWAITER" } }),
      } as unknown as SlackIntakeGate["confirmations"],
    });
    const thread = [
      { user: BOT, text: "report ready", ts: parentTs }, // the bot's own post starts the thread
      { user: "UASKER", text: "thanks", ts: "110.000000" },
      { user: "UOTHER", text: "looks fine", ts: "120.000000" },
      { user: BOT, text: "anything else?", ts: "130.000000" },
    ];
    const ev = followUp({ thread, rawText: "and <@UOTHER> should check too" });
    await receiveSlackMessage(s.client, ev, spanStub().span, POLICY, [], gate);
    expect(input!.turns).toEqual([
      { role: "bot", text: "report ready" },
      { role: "requester", text: "thanks" },
      { role: "person", text: "looks fine" },
      { role: "bot", text: "anything else?" },
    ]);
    expect(input!.facts).toEqual({
      liveRun: { agent: "coding", secondsInFlight: 60 },
      replierIsRequester: true,
      botLastSpokeSeconds: 30,
      mentionsOther: true,
      pendingConfirmation: "slack:UWAITER",
      threadStartedByBot: true,
    });
    expect(input!.mode).toBe("classify");
    expect(input!.model).toBe("anthropic/fast-model");
    expect(input!.gen).toBe(7);
    expect(input!.threadKey).toBe("slack:CGATE:100.000000");
    expect(input!.key).toBe(`CGATE:${ev.ts}`);
  });

  it("the operator's own pending question rides the facts (issue 2046): the newest run's on-mode question sets pendingQuestion, so the reply is addressed without a mention", async () => {
    const s = gateClient();
    stubDownloads(s.calls);
    const page: RunView[] = [
      {
        id: "door",
        agent: "door",
        userId: "slack:UASKER",
        startedAt: 100_000,
        finished: true,
        operator: { mode: "on", outcome: "question", reason: "ambiguous", proposal: "agent:explore acme/company" },
      },
    ] as RunView[];
    let input: IntakeInput | undefined;
    const decide = vi.fn(async (i: IntakeInput): Promise<IntakeDecision> => {
      input = i;
      return { verdict: "addressed", reason: "the bot asked", source: "question", receipt: "inserted" };
    });
    const { gate } = gateOf({
      decideIntake: decide as unknown as typeof decideIntake,
      runs: { listRuns: async () => ({ runs: page, total: 1 }) } as unknown as SlackIntakeGate["runs"],
    });
    const ev = followUp({ thread: [{ user: "UASKER", text: "in acme/company add the action", ts: parentTs }] });
    await receiveSlackMessage(s.client, ev, spanStub().span, POLICY, [], gate);
    expect(input!.facts.pendingQuestion).toBe(true);
  });

  it("wireIntakeGate prints the degraded startup line exactly once when the ledger is null, and never with one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      wireIntakeGate({
        intakeModeFor: () => "classify",
        deps: { model: async () => "x", ledger: null, now: () => 0 },
        modelRef: "anthropic/fast-model",
        gen: 1,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(degradedIntakeLine());
      wireIntakeGate({
        intakeModeFor: () => "classify",
        deps: { model: async () => "x", ledger: fakeLedger(), now: () => 0 },
        modelRef: "anthropic/fast-model",
        gen: 1,
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the catch-up reads the receipt — onMissed's act (docs/reference/specs/slack-channel.md item 7)", () => {
  const CATCH_NOW = 1_788_040_800_000; // 2026-08-29T22:00:00Z
  const cts = (secondsAgo: number, frac = "000100") => `${Math.floor(CATCH_NOW / 1000) - secondsAgo}.${frac}`;

  /** A per-test seen-set standing in for the module-level handled-set. */
  function seenSet() {
    const set = new Set<string>();
    return {
      was: (c: string, t: string) => set.has(`${c}:${t}`),
      mark: (c: string, t: string) => void set.add(`${c}:${t}`),
    };
  }

  /** An in-memory receipt ledger, seedable, with spied reads and writes. */
  function receiptLedger(rows: Record<string, "addressed" | "silent"> = {}) {
    const map = new Map<string, IntakeReceipt>(
      Object.entries(rows).map(([k, verdict]) => [
        k,
        {
          verdict,
          reason: "stored",
          source: "model",
          mode: "classify",
          model: "anthropic/fast-model",
          gen: 1,
          threadKey: "slack:CCU:100.000000",
          decidedAt: 1,
        },
      ]),
    );
    const readIntake = vi.fn(async (key: string) => map.get(key));
    const recordIntake = vi.fn(async (key: string, receipt: IntakeReceipt) => {
      const existing = map.get(key);
      if (existing) return { inserted: false, stored: existing };
      map.set(key, receipt);
      return { inserted: true, stored: receipt };
    });
    return { readIntake, recordIntake };
  }

  const verdictOf = (verdict: "addressed" | "silent") =>
    vi.fn(async (_input: IntakeInput): Promise<IntakeDecision> => ({
      verdict,
      reason: "r",
      source: "model",
      receipt: "inserted",
    }));

  function catchGate(over: {
    mode?: "mention" | "classify" | "always";
    ledger?: SlackIntakeGate["deps"]["ledger"];
    decide?: ReturnType<typeof verdictOf>;
  }) {
    const decide = over.decide ?? verdictOf("addressed");
    const gate: SlackIntakeGate = {
      intakeModeFor: () => over.mode ?? "classify",
      decideIntake: decide as unknown as typeof decideIntake,
      deps: { model: async () => "unused", ledger: over.ledger ?? null, now: () => CATCH_NOW },
      modelRef: "anthropic/fast-model",
      gen: 7,
    };
    return { gate, decide };
  }

  type Dispatched = { trigger: "mention" | "thread-follow-up"; intakeDecided?: true };
  const missedOf = (over: Partial<MissedMessage> = {}): MissedMessage => {
    const parent = { user: BOT, bot_id: "B1", text: "report ready", ts: "100.000000" };
    const reply = { user: "UASKER", text: "and the tests?", ts: "120.000100", thread_ts: "100.000000" };
    return {
      channel: "CCU",
      user: "UASKER",
      text: "and the tests?",
      ts: "120.000100",
      threadTs: "100.000000",
      files: undefined,
      thread: [parent, reply],
      ...over,
    };
  };

  it("the runner over a fixture: a silent receipt skips (counted silenced, marked seen), an addressed receipt dispatches with intakeDecided and no verdict, no receipt runs decideIntake over the paged tail", async () => {
    const parent = {
      user: BOT,
      bot_id: "B1",
      text: "report ready",
      ts: cts(3000),
      reply_count: 3,
      latest_reply: cts(40),
    };
    const r1 = { user: "UA", text: "for you, colleague", ts: cts(120), thread_ts: parent.ts };
    const r2 = { user: "UB", text: "re-run the suite", ts: cts(80), thread_ts: parent.ts };
    const r3 = { user: "UC", text: "and the tests?", ts: cts(40), thread_ts: parent.ts };
    const client = guardOutbound({
      users: { conversations: vi.fn(async () => ({ channels: [{ id: "CCU" }] })) },
      conversations: {
        history: vi.fn(async () => ({ messages: [parent] })),
        replies: vi.fn(async () => ({ messages: [parent, r1, r2, r3] })),
      },
    } as unknown as CatchUpClient);
    const ledger = receiptLedger({ [`CCU:${r1.ts}`]: "silent", [`CCU:${r2.ts}`]: "addressed" });
    const { gate, decide } = catchGate({ ledger });
    const seen = seenSet();
    const dispatched: Array<Dispatched & { ts: string }> = [];
    let silenced = 0;
    const out = await catchUpMissedMentions({
      client,
      botUserId: BOT,
      now: CATCH_NOW,
      alreadyHandled: seen.was,
      log: () => {},
      record: () => {},
      onMissed: async (m) => {
        const act = await actOnMissedMessage(m, {
          botUserId: BOT,
          intake: gate,
          seen,
          log: () => {},
          dispatch: (extra) => dispatched.push({ ts: m.ts, ...extra }),
        });
        if (act === "silenced") silenced++;
      },
    });
    expect(out.missed).toBe(3);
    expect(silenced).toBe(1);
    expect(dispatched).toEqual([
      { ts: r2.ts, trigger: "thread-follow-up", intakeDecided: true },
      { ts: r3.ts, trigger: "thread-follow-up", intakeDecided: true },
    ]);
    // The one verdict ran over the thread the scan paged: r3's key, the tail's turns.
    expect(decide).toHaveBeenCalledTimes(1);
    const input = decide.mock.calls[0]![0];
    expect(input.key).toBe(`CCU:${r3.ts}`);
    expect(input.turns.map((t) => t.text)).toEqual(["report ready", "for you, colleague", "re-run the suite"]);
    expect(input.turns[0]!.role).toBe("bot");
    expect(input.facts.threadStartedByBot).toBe(true);
    // The silent receipt marked the pair seen, so the next scan skips it too.
    expect(seen.was("CCU", r1.ts)).toBe(true);
  });

  it("a candidate whose receipt read throws is decided as receipt-less: decideIntake runs and its verdict proceeds", async () => {
    const ledger = {
      readIntake: vi.fn(async () => {
        throw new Error("D1 unreachable");
      }),
      recordIntake: vi.fn(async (_k: string, r: IntakeReceipt) => ({ inserted: true, stored: r })),
    };
    const { gate, decide } = catchGate({ ledger });
    const dispatched: Dispatched[] = [];
    const act = await actOnMissedMessage(missedOf(), {
      botUserId: BOT,
      intake: gate,
      seen: seenSet(),
      log: () => {},
      dispatch: (extra) => dispatched.push(extra),
    });
    expect(ledger.readIntake).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(act).toBe("dispatched");
    expect(dispatched).toEqual([{ trigger: "thread-follow-up", intakeDecided: true }]);
  });

  it("a userless candidate resolves the intake mode with no user scope: intakeModeFor is handed undefined, never a made-up id", async () => {
    const { gate } = catchGate({ ledger: receiptLedger() });
    const modeFor = vi.fn(() => "classify" as const);
    gate.intakeModeFor = modeFor;
    await actOnMissedMessage(missedOf({ user: undefined }), {
      botUserId: BOT,
      intake: gate,
      seen: seenSet(),
      log: () => {},
      dispatch: () => {},
    });
    expect(modeFor).toHaveBeenCalledWith("slack:CCU:100.000000", undefined, "slack:CCU");
  });

  it("a fresh silent verdict silences the candidate: no dispatch, the pair marked seen", async () => {
    const { gate, decide } = catchGate({ ledger: receiptLedger(), decide: verdictOf("silent") });
    const seen = seenSet();
    const dispatched: Dispatched[] = [];
    const act = await actOnMissedMessage(missedOf(), {
      botUserId: BOT,
      intake: gate,
      seen,
      log: () => {},
      dispatch: (extra) => dispatched.push(extra),
    });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(act).toBe("silenced");
    expect(dispatched).toEqual([]);
    expect(seen.was("CCU", "120.000100")).toBe(true);
  });

  it("an always thread is dispatched exactly as today: no receipt read, no verdict, no intakeDecided — and so is a replay when no gate is wired", async () => {
    const ledger = receiptLedger({ "CCU:120.000100": "silent" });
    const { gate, decide } = catchGate({ mode: "always", ledger });
    const dispatched: Dispatched[] = [];
    const act = await actOnMissedMessage(missedOf(), {
      botUserId: BOT,
      intake: gate,
      seen: seenSet(),
      log: () => {},
      dispatch: (extra) => dispatched.push(extra),
    });
    expect(act).toBe("dispatched");
    expect(ledger.readIntake).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(dispatched).toEqual([{ trigger: "thread-follow-up" }]);
    // No gate wired (degrade open): the same dispatch, byte for byte.
    const bare: Dispatched[] = [];
    const act2 = await actOnMissedMessage(missedOf(), {
      botUserId: BOT,
      seen: seenSet(),
      log: () => {},
      dispatch: (extra) => bare.push(extra),
    });
    expect(act2).toBe("dispatched");
    expect(bare).toEqual([{ trigger: "thread-follow-up" }]);
  });

  it("a live claim that landed between the scan and the act is skipped after the read", async () => {
    const order: string[] = [];
    const ledger = receiptLedger({ "CCU:120.000100": "addressed" });
    ledger.readIntake.mockImplementation(async (key: string) => {
      order.push("read");
      return key === "CCU:120.000100"
        ? ({
            verdict: "addressed",
            reason: "r",
            source: "model",
            mode: "classify",
            model: "m/f",
            gen: 1,
            threadKey: "t",
            decidedAt: 1,
          } as IntakeReceipt)
        : undefined;
    });
    const { gate } = catchGate({ ledger });
    const dispatched: Dispatched[] = [];
    const act = await actOnMissedMessage(missedOf(), {
      botUserId: BOT,
      intake: gate,
      seen: {
        was: (c, t) => {
          order.push("seen");
          return c === "CCU" && t === "120.000100";
        },
        mark: () => {},
      },
      log: () => {},
      dispatch: (extra) => dispatched.push(extra),
    });
    expect(act).toBe("skipped");
    expect(order).toEqual(["read", "seen"]);
    expect(dispatched).toEqual([]);
  });

  it("a thread of 60 replies hands the newest twelve turns to the verdict", async () => {
    const parentTs = "100.000000";
    const replies = Array.from({ length: 60 }, (_, i) => ({
      user: i % 2 ? "UASKER" : BOT,
      text: `turn ${i}`,
      ts: `${200 + i}.000000`,
      thread_ts: parentTs,
    }));
    const candidate = replies[59]!;
    const thread = [{ user: BOT, bot_id: "B1", text: "lead", ts: parentTs }, ...replies];
    const { gate, decide } = catchGate({ ledger: receiptLedger() });
    await actOnMissedMessage(missedOf({ ts: candidate.ts, text: candidate.text, thread }), {
      botUserId: BOT,
      intake: gate,
      seen: seenSet(),
      log: () => {},
      dispatch: () => {},
    });
    const input = decide.mock.calls[0]![0];
    expect(input.turns).toHaveLength(12);
    expect(input.turns.map((t) => t.text)).toEqual(Array.from({ length: 12 }, (_, i) => `turn ${47 + i}`));
  });

  it("an edited message now carrying a mention is a candidate through mentionsBot: dispatched as a mention, no receipt read, whatever a silent receipt says", async () => {
    const ledger = receiptLedger({ "CCU:120.000100": "silent" });
    const { gate, decide } = catchGate({ ledger });
    const dispatched: Dispatched[] = [];
    const act = await actOnMissedMessage(missedOf({ text: `<@${BOT}> now for you` }), {
      botUserId: BOT,
      intake: gate,
      seen: seenSet(),
      log: () => {},
      dispatch: (extra) => dispatched.push(extra),
    });
    expect(act).toBe("dispatched");
    expect(ledger.readIntake).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(dispatched).toEqual([{ trigger: "mention" }]);
  });
});
