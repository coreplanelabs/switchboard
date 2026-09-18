import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseRelayFooter,
  rawTextOf,
  resetRelayParentCache,
  resolveSlackRequester,
  textOfBlocks,
  type RequesterClient,
} from "./requester.js";
import { RELAY_FOOTER_RE, type SlackThreadMessage } from "./threadTurns.js";

// Feature: docs/reference/specs/slack-channel.md item 13 — who asked. An app's
// post has no `user`; when the app is the configured relay (`slack.relayApps`)
// the requester is the person its footer names, outright or through the
// footer's thread; any other app — footer or not, in a person's thread or not —
// is the requester itself by name, never `unknown`.

// The footer exactly as Slack delivered it on a real relayed review request
// (channel and thread ids made up; `&amp;` is how Slack escapes `&` in text).
const RELAY =
  "<@U0BOT|switchboard> agent:review <https://github.com/acme/api/pull/42|github.com/acme/api/pull/42>\n" +
  "Sent by Claude in <#C0PROMPT|alice-prompting> · <https://acme.slack.com/archives/C0PROMPT/p1789504919942589?thread_ts=1789504919.942589&amp;cid=C0PROMPT|thread>";

function client(replies: (args: { channel: string; ts: string }) => SlackThreadMessage[] | Error): RequesterClient & {
  calls: { channel: string; ts: string }[];
} {
  const calls: { channel: string; ts: string }[] = [];
  return {
    calls,
    conversations: {
      replies: vi.fn(async (args: { channel: string; ts: string; limit?: number }) => {
        calls.push({ channel: args.channel, ts: args.ts });
        const r = replies(args);
        if (r instanceof Error) throw r;
        return { messages: r };
      }),
    },
  };
}

const base = { channel: "C0REVIEW", ts: "1789507058.075929", threadTs: "1789507058.075929" };

beforeEach(() => resetRelayParentCache());

describe("parseRelayFooter", () => {
  it("reads the source channel and the thread from the footer's permalink, unescaping Slack's &amp;", () => {
    expect(parseRelayFooter(RELAY)).toEqual({ channel: "C0PROMPT", threadTs: "1789504919.942589" });
  });

  it("the current footer names the person — on behalf of <@U…>, with or without a display name — and that is read alongside the thread", () => {
    expect(
      parseRelayFooter(
        "x\nSent by Claude in <#C0PROMPT|alice-prompting> on behalf of <@U0ALICE|alice> · <https://acme.slack.com/archives/C0PROMPT/p1789504919942589|thread>",
      ),
    ).toEqual({ channel: "C0PROMPT", threadTs: "1789504919.942589", onBehalfOf: "U0ALICE" });
    expect(parseRelayFooter(RELAY)).not.toHaveProperty("onBehalfOf");
  });

  it("a bare p<ts> permalink names the thread's parent itself", () => {
    const text =
      "hi\nSent by Claude in <#C0PROMPT> · <https://acme.slack.com/archives/C0PROMPT/p1789504919942589|thread>";
    expect(parseRelayFooter(text)).toEqual({ channel: "C0PROMPT", threadTs: "1789504919.942589" });
  });

  it("is a whole trailing footer or nothing: mid-text mentions of the phrase, a non-archives link, a bad ts and a malformed URL parse to nothing", () => {
    expect(
      parseRelayFooter("Sent by Claude in <#C1> · <https://x/archives/C1/p1|thread> and then more"),
    ).toBeUndefined();
    expect(
      parseRelayFooter("x\nSent by Claude in <#C1> · <https://acme.slack.com/files/C1/p1789504919942589|thread>"),
    ).toBeUndefined();
    expect(
      parseRelayFooter("x\nSent by Claude in <#C1> · <https://acme.slack.com/archives/C1/p12345|thread>"),
    ).toBeUndefined();
    expect(
      parseRelayFooter(
        "x\nSent by Claude in <#C1> · <https://acme.slack.com/archives/C1/p1789504919942589?thread_ts=nope|thread>",
      ),
    ).toBeUndefined();
    expect(parseRelayFooter("x\nSent by Claude in <#C1> · <notaurl|thread>")).toBeUndefined();
    expect(parseRelayFooter("please review the PR")).toBeUndefined();
  });

  it("the regex removes exactly the footer, leaving the request", () => {
    expect(RELAY.replace(RELAY_FOOTER_RE, "").trim()).toBe(
      "<@U0BOT|switchboard> agent:review <https://github.com/acme/api/pull/42|github.com/acme/api/pull/42>",
    );
  });
});

// The footer as Slack really delivers it (read off a live relayed request in
// September 2026): `text` holds the request alone; a `rich_text` block repeats it and
// a `context` block carries the footer, which names the person outright.
const LIVE_TEXT = "<@U0BOT> agent:review <https://github.com/acme/api/pull/42> — retry after the exec timeout";
const LIVE_BLOCKS = [
  {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          { type: "user", user_id: "U0BOT" },
          { type: "text", text: " agent:review " },
          { type: "link", url: "https://github.com/acme/api/pull/42", text: "github.com/acme/api/pull/42" },
          { type: "text", text: " — retry after the exec timeout" },
        ],
      },
    ],
  },
  {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "Sent by Claude in <#C0PROMPT> on behalf of <@U0B0RIS> · <https://acme.slack.com/archives/C0PROMPT/p1789506812453899?thread_ts=1789506812.453899&amp;cid=C0PROMPT|thread>",
      },
    ],
  },
];

describe("textOfBlocks / rawTextOf", () => {
  it("flattens section, context and rich_text blocks to their texts, one line per block, runs rendered as the message text carries them; unknown shapes add nothing", () => {
    expect(textOfBlocks(LIVE_BLOCKS)).toBe(
      "<@U0BOT> agent:review github.com/acme/api/pull/42 — retry after the exec timeout\n" +
        "Sent by Claude in <#C0PROMPT> on behalf of <@U0B0RIS> · <https://acme.slack.com/archives/C0PROMPT/p1789506812453899?thread_ts=1789506812.453899&amp;cid=C0PROMPT|thread>",
    );
    expect(textOfBlocks([{ type: "section", text: { type: "mrkdwn", text: "hi" } }, { type: "divider" }])).toBe("hi");
    expect(textOfBlocks(undefined)).toBe("");
    // A link run with no label is its URL, not nothing.
    expect(textOfBlocks([{ type: "rich_text", elements: [{ type: "link", url: "https://acme.example/x" }] }])).toBe(
      "https://acme.example/x",
    );
    // A context block's elements are fragments: joined with a space, so a footer's `Sent by` keeps its leading boundary.
    expect(
      textOfBlocks([
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: "*draft*" },
            {
              type: "mrkdwn",
              text: "Sent by Claude in <#C1> · <https://acme.slack.com/archives/C1/p1789504919942589|thread>",
            },
          ],
        },
      ]),
    ).toBe("*draft* Sent by Claude in <#C1> · <https://acme.slack.com/archives/C1/p1789504919942589|thread>");
  });

  it("the raw text is the message text plus only the block lines that say something the text does not — the footer — and never the request a second time", () => {
    const raw = rawTextOf(LIVE_TEXT, LIVE_BLOCKS);
    expect(raw.startsWith(LIVE_TEXT)).toBe(true);
    // Two lines: the text and the footer. The rich_text rendering of the request (a
    // link's label for its mrkdwn `<url>`) is the same words and is not repeated.
    expect(raw.split("\n")).toHaveLength(2);
    expect(raw).toContain("Sent by Claude in <#C0PROMPT> on behalf of <@U0B0RIS>");
    expect(rawTextOf("plain", undefined)).toBe("plain");
    expect(rawTextOf("hi", [{ type: "section", text: { text: "hi" } }])).toBe("hi");
    expect(
      rawTextOf("see <https://acme.example/x|the doc>", [
        {
          type: "rich_text",
          elements: [
            { type: "text", text: "see " },
            { type: "link", url: "https://acme.example/x", text: "the doc" },
          ],
        },
      ]),
    ).toBe("see <https://acme.example/x|the doc>");
    expect(parseRelayFooter(raw)).toEqual({
      channel: "C0PROMPT",
      threadTs: "1789506812.453899",
      onBehalfOf: "U0B0RIS",
    });
  });
});

// The relay app the operator configured (`slack.relayApps`): the one app whose
// footer is read for the person. Every other app is the requester itself.
const RELAY_APPS = ["B0CLAUDE"];

describe("resolveSlackRequester", () => {
  it("a footer that names the person resolves to them with no API call — the live shape, from the configured relay app", async () => {
    const c = client(() => new Error("never"));
    const r = await resolveSlackRequester(
      c,
      {
        ...base,
        text: rawTextOf(LIVE_TEXT, LIVE_BLOCKS),
        poster: { botId: "B0CLAUDE", name: "Claude [coming-soon interest grid]" },
      },
      RELAY_APPS,
    );
    expect(r).toEqual({
      userId: "slack:U0B0RIS",
      slackUserId: "U0B0RIS",
      relayedBy: "Claude [coming-soon interest grid]",
      postedBy: "slack:bot:B0CLAUDE",
      resolvedBy: "relay-footer",
    });
    expect(c.calls).toEqual([]);
  });

  it("a person's own message is the requester, with no API call and no relay — a reply in another person's thread included", async () => {
    const c = client(() => new Error("never"));
    const r = await resolveSlackRequester(c, { ...base, user: "U0ALICE", text: "hi", poster: { botId: "B1" } }, []);
    expect(r).toEqual({ userId: "slack:U0ALICE", slackUserId: "U0ALICE", resolvedBy: "message" });
    // A person replying inside a thread someone else started is still themselves:
    // the thread's parent is never read for a person's own words.
    const reply = await resolveSlackRequester(
      c,
      { ...base, ts: "1789507999.000001", threadTs: "1789500000.000001", user: "U0ALICE", text: "me too" },
      RELAY_APPS,
    );
    expect(reply).toEqual({ userId: "slack:U0ALICE", slackUserId: "U0ALICE", resolvedBy: "message" });
    expect(c.calls).toEqual([]);
  });

  it("the configured relay app's post with an older footer resolves to the person who started the footer's thread, relayed by the app's name", async () => {
    const c = client(({ channel, ts }) =>
      channel === "C0PROMPT" && ts === "1789504919.942589" ? [{ ts, user: "U0ALICE", text: "review my PR" }] : [],
    );
    const r = await resolveSlackRequester(
      c,
      { ...base, text: RELAY, poster: { botId: "B0CLAUDE", name: "Claude [fixing the build]" } },
      RELAY_APPS,
    );
    expect(r).toEqual({
      userId: "slack:U0ALICE",
      slackUserId: "U0ALICE",
      relayedBy: "Claude [fixing the build]",
      postedBy: "slack:bot:B0CLAUDE",
      resolvedBy: "relay-footer",
    });
    expect(c.calls).toEqual([{ channel: "C0PROMPT", ts: "1789504919.942589" }]);
    // The same session's next request reads nothing: the thread's parent is remembered.
    await resolveSlackRequester(
      c,
      { ...base, ts: "1789507999.000001", threadTs: "1789507999.000001", text: RELAY, poster: { botId: "B0CLAUDE" } },
      RELAY_APPS,
    );
    expect(c.calls).toHaveLength(1);
  });

  it("a footer whose thread cannot be read, or whose parent is itself an app's, falls through to the app by name — and the failure is not remembered", async () => {
    let fail = true;
    const c = client(() => (fail ? new Error("channel_not_found") : [{ ts: "1789504919.942589", user: "U0ALICE" }]));
    const ev = { ...base, text: RELAY, poster: { botId: "B0CLAUDE", name: "Claude [x]" } };
    expect(await resolveSlackRequester(c, ev, RELAY_APPS)).toEqual({
      userId: "slack:bot:B0CLAUDE",
      userName: "Claude [x]",
      resolvedBy: "bot",
    });
    fail = false;
    expect((await resolveSlackRequester(c, ev, RELAY_APPS)).userId).toBe("slack:U0ALICE");
    resetRelayParentCache();
    const botParent = client(() => [{ ts: "1789504919.942589", bot_id: "B9", user: "U0BOTUSER" }]);
    expect((await resolveSlackRequester(botParent, ev, RELAY_APPS)).resolvedBy).toBe("bot");
  });

  it("an app that is not the configured relay is the requester itself, footer or not — the footer's name is not read and no thread is read", async () => {
    const c = client(() => new Error("never"));
    const other = { botId: "B0OTHER", name: "Some other app" };
    // The live footer, naming a person outright.
    expect(
      await resolveSlackRequester(c, { ...base, text: rawTextOf(LIVE_TEXT, LIVE_BLOCKS), poster: other }, RELAY_APPS),
    ).toEqual({ userId: "slack:bot:B0OTHER", userName: "Some other app", resolvedBy: "bot" });
    // The older footer, naming a person's thread.
    expect(await resolveSlackRequester(c, { ...base, text: RELAY, poster: other }, RELAY_APPS)).toEqual({
      userId: "slack:bot:B0OTHER",
      userName: "Some other app",
      resolvedBy: "bot",
    });
    // A post with no poster facts at all is never the configured relay.
    expect(await resolveSlackRequester(c, { ...base, text: rawTextOf(LIVE_TEXT, LIVE_BLOCKS) }, RELAY_APPS)).toEqual({
      userId: "slack:bot:unknown",
      resolvedBy: "bot",
    });
    expect(c.calls).toEqual([]);
  });

  it("with no relay app configured, no footer is honoured — the posting app is the requester", async () => {
    const c = client(() => new Error("never"));
    const ev = { ...base, text: rawTextOf(LIVE_TEXT, LIVE_BLOCKS), poster: { botId: "B0CLAUDE", name: "Claude [x]" } };
    expect(await resolveSlackRequester(c, ev, [])).toEqual({
      userId: "slack:bot:B0CLAUDE",
      userName: "Claude [x]",
      resolvedBy: "bot",
    });
    expect(c.calls).toEqual([]);
  });

  it("an app's reply inside a thread a person started, with no footer, is the app's own request — configured relay or not, the parent is never read", async () => {
    const c = client(() => new Error("never"));
    const reply = {
      ...base,
      ts: "1789500001.000002",
      threadTs: "1789500000.000001",
      text: "<@U0BOT> re-review",
    };
    expect(
      await resolveSlackRequester(c, { ...reply, poster: { botId: "B0CLAUDE", name: "Claude [ci]" } }, RELAY_APPS),
    ).toEqual({ userId: "slack:bot:B0CLAUDE", userName: "Claude [ci]", resolvedBy: "bot" });
    expect(
      await resolveSlackRequester(c, { ...reply, poster: { botId: "B0OTHER", name: "Deploy bot" } }, RELAY_APPS),
    ).toEqual({ userId: "slack:bot:B0OTHER", userName: "Deploy bot", resolvedBy: "bot" });
    expect(c.calls).toEqual([]);
  });

  it("a top-level app post with no footer is the app itself by id and name — never `unknown`", async () => {
    const c = client(() => new Error("never"));
    expect(
      await resolveSlackRequester(
        c,
        { ...base, text: "<@U0BOT> hello", poster: { botId: "B0X", name: "Deploy bot" } },
        [],
      ),
    ).toEqual({ userId: "slack:bot:B0X", userName: "Deploy bot", resolvedBy: "bot" });
    // No poster facts at all: still a named shape, not a person.
    expect(await resolveSlackRequester(c, { ...base, text: "<@U0BOT> hello" }, [])).toEqual({
      userId: "slack:bot:unknown",
      resolvedBy: "bot",
    });
    expect(c.calls).toEqual([]);
  });
});
