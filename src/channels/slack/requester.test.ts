import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseRelayFooter, resetRelayParentCache, resolveSlackRequester, type RequesterClient } from "./requester.js";
import { RELAY_FOOTER_RE, type SlackThreadMessage } from "./threadTurns.js";

// Feature: docs/reference/specs/slack-channel.md item 13 — who asked. An app's
// post has no `user`; the requester is the person it relayed for, found through
// the relay footer's thread or the thread the bot replied in, else the app
// itself by name — never `unknown`.

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

describe("resolveSlackRequester", () => {
  it("a person's own message is the requester, with no API call and no relay", async () => {
    const c = client(() => new Error("never"));
    const r = await resolveSlackRequester(c, { ...base, user: "U0ALICE", text: "hi", poster: { botId: "B1" } });
    expect(r).toEqual({ userId: "slack:U0ALICE", slackUserId: "U0ALICE", resolvedBy: "message" });
    expect(c.calls).toEqual([]);
  });

  it("an app's post with a relay footer resolves to the person who started the footer's thread, relayed by the app's name", async () => {
    const c = client(({ channel, ts }) =>
      channel === "C0PROMPT" && ts === "1789504919.942589" ? [{ ts, user: "U0ALICE", text: "review my PR" }] : [],
    );
    const r = await resolveSlackRequester(c, {
      ...base,
      text: RELAY,
      poster: { botId: "B0CLAUDE", name: "Claude [fixing the build]" },
    });
    expect(r).toEqual({
      userId: "slack:U0ALICE",
      slackUserId: "U0ALICE",
      relayedBy: "Claude [fixing the build]",
      postedBy: "slack:bot:B0CLAUDE",
      resolvedBy: "relay-footer",
    });
    expect(c.calls).toEqual([{ channel: "C0PROMPT", ts: "1789504919.942589" }]);
    // The same session's next request reads nothing: the thread's parent is remembered.
    await resolveSlackRequester(c, { ...base, ts: "1789507999.000001", threadTs: "1789507999.000001", text: RELAY });
    expect(c.calls).toHaveLength(1);
  });

  it("a footer whose thread cannot be read, or whose parent is itself an app's, falls through to the app by name — and the failure is not remembered", async () => {
    let fail = true;
    const c = client(() => (fail ? new Error("channel_not_found") : [{ ts: "1789504919.942589", user: "U0ALICE" }]));
    const ev = { ...base, text: RELAY, poster: { botId: "B0CLAUDE", name: "Claude [x]" } };
    expect(await resolveSlackRequester(c, ev)).toEqual({
      userId: "slack:bot:B0CLAUDE",
      userName: "Claude [x]",
      resolvedBy: "bot",
    });
    fail = false;
    expect((await resolveSlackRequester(c, ev)).userId).toBe("slack:U0ALICE");
    resetRelayParentCache();
    const botParent = client(() => [{ ts: "1789504919.942589", bot_id: "B9", user: "U0BOTUSER" }]);
    expect((await resolveSlackRequester(botParent, ev)).resolvedBy).toBe("bot");
  });

  it("an app's reply inside a thread a person started is that person's request, from the prefetched page when there is one", async () => {
    const c = client(() => new Error("never"));
    const thread: SlackThreadMessage[] = [
      { ts: "1789500000.000001", user: "U0SAM", text: "please fix the build" },
      { ts: "1789500001.000002", bot_id: "B0CLAUDE", text: "re-review" },
    ];
    const r = await resolveSlackRequester(c, {
      ...base,
      ts: "1789500001.000002",
      threadTs: "1789500000.000001",
      text: "<@U0BOT> re-review",
      poster: { botId: "B0CLAUDE", name: "Claude [ci]" },
      thread,
    });
    expect(r).toEqual({
      userId: "slack:U0SAM",
      slackUserId: "U0SAM",
      relayedBy: "Claude [ci]",
      postedBy: "slack:bot:B0CLAUDE",
      resolvedBy: "thread-parent",
    });
    expect(c.calls).toEqual([]);
    // Without a prefetched page the parent is read once.
    resetRelayParentCache();
    const fetched = client(({ ts }) => [{ ts, user: "U0SAM" }]);
    const r2 = await resolveSlackRequester(fetched, {
      ...base,
      ts: "1789500001.000002",
      threadTs: "1789500000.000001",
      text: "<@U0BOT> re-review",
      poster: { botId: "B0CLAUDE" },
    });
    expect(r2).toMatchObject({
      userId: "slack:U0SAM",
      relayedBy: "an app",
      postedBy: "slack:bot:B0CLAUDE",
      resolvedBy: "thread-parent",
    });
    expect(fetched.calls).toEqual([{ channel: "C0REVIEW", ts: "1789500000.000001" }]);
  });

  it("a top-level app post with no footer is the app itself by id and name — never `unknown`", async () => {
    const c = client(() => new Error("never"));
    expect(
      await resolveSlackRequester(c, { ...base, text: "<@U0BOT> hello", poster: { botId: "B0X", name: "Deploy bot" } }),
    ).toEqual({ userId: "slack:bot:B0X", userName: "Deploy bot", resolvedBy: "bot" });
    // No poster facts at all: still a named shape, not a person.
    expect(await resolveSlackRequester(c, { ...base, text: "<@U0BOT> hello" })).toEqual({
      userId: "slack:bot:unknown",
      resolvedBy: "bot",
    });
    expect(c.calls).toEqual([]);
  });
});
