import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSlackNameCaches } from "./lookups.js";
import { SlackConversationReader, CLASSIFY_CACHE_MS, type ReferenceClient } from "./references.js";

// The Slack conversation reader (record 0037, the adapter contract): the URL
// grammar for this workspace only, a closed classifier over one fresh
// `conversations.info`, a text-only fetch that keeps the newest messages, and
// the requester's standing on the workspace. Every rule fails closed: what the
// reader cannot affirmatively place is `never`.

type Info = {
  id: string;
  name?: string;
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_shared?: boolean;
  is_ext_shared?: boolean;
  is_org_shared?: boolean;
  is_pending_ext_shared?: boolean;
  is_member?: boolean;
};

function fakeClient(input: {
  channels?: Record<string, Info>;
  replies?: Record<string, { user?: string; bot_id?: string; text?: string; ts?: string }[]>;
  users?: Record<string, { name?: string; real_name?: string; is_restricted?: boolean; is_ultra_restricted?: boolean }>;
  teamUrl?: string;
  infoDelayMs?: number;
}) {
  const calls = { info: 0, replies: 0, users: 0, auth: 0 };
  const client: ReferenceClient = {
    auth: {
      test: async () => {
        calls.auth++;
        return { url: input.teamUrl ?? "https://team.example/" };
      },
    },
    conversations: {
      info: async ({ channel }) => {
        calls.info++;
        if (input.infoDelayMs) await new Promise((r) => setTimeout(r, input.infoDelayMs));
        const c = input.channels?.[channel];
        if (!c) throw Object.assign(new Error("channel_not_found"), { data: { error: "channel_not_found" } });
        return { channel: c };
      },
      replies: async ({ channel, ts }) => {
        calls.replies++;
        return { messages: input.replies?.[`${channel}:${ts}`] ?? [] };
      },
    },
    users: {
      info: async ({ user }) => {
        calls.users++;
        const u = input.users?.[user];
        if (!u) throw new Error("user_not_found");
        return { user: u };
      },
    },
  };
  return { client, calls };
}

const PUBLIC: Info = { id: "C_PUB", name: "frontend", is_private: false, is_member: true };

describe("SlackConversationReader.parseConversationUrl — this workspace's grammar", () => {
  it("parses a thread permalink, a reply permalink (its thread ts) and a bare message permalink", async () => {
    const { client } = fakeClient({});
    const r = new SlackConversationReader(client);
    await r.ready();
    expect(r.parseConversationUrl("https://team.example/archives/C_PUB/p1789439332061189")).toEqual({
      channelId: "slack:C_PUB",
      threadKey: "slack:C_PUB:1789439332.061189",
      messageId: "1789439332.061189",
      url: "https://team.example/archives/C_PUB/p1789439332061189",
    });
    expect(
      r.parseConversationUrl(
        "https://team.example/archives/C_PUB/p1789485980441859?thread_ts=1789439332.061189&cid=C_PUB",
      ),
    ).toEqual({
      channelId: "slack:C_PUB",
      threadKey: "slack:C_PUB:1789439332.061189",
      url: "https://team.example/archives/C_PUB/p1789485980441859?thread_ts=1789439332.061189&cid=C_PUB",
    });
  });

  it("a link on another workspace's host, a non-archive path or a malformed ts is not a reference", async () => {
    const { client } = fakeClient({});
    const r = new SlackConversationReader(client);
    await r.ready();
    expect(r.parseConversationUrl("https://otherteam.example/archives/C_PUB/p1789439332061189")).toBeUndefined();
    expect(r.parseConversationUrl("https://team.example/files/U_ALICE/F1/x.png")).toBeUndefined();
    expect(r.parseConversationUrl("https://team.example/archives/C_PUB/pabc")).toBeUndefined();
    expect(r.parseConversationUrl("https://github.com/acme/api/pull/1")).toBeUndefined();
  });

  it("before the team URL is known, nothing parses — a guess about the host is never made", () => {
    const { client } = fakeClient({});
    const r = new SlackConversationReader(client);
    expect(r.parseConversationUrl("https://team.example/archives/C_PUB/p1789439332061189")).toBeUndefined();
  });
});

describe("SlackConversationReader.classifyConversation — closed and fresh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const ref = (channel: string) => ({
    channelId: `slack:${channel}`,
    threadKey: `slack:${channel}:1.0`,
    url: "https://x",
  });

  it("a public channel the bot is in is public with the fresh name; a private one is private; membership comes from is_member", async () => {
    const { client } = fakeClient({
      channels: {
        C_PUB: PUBLIC,
        C_PRIV: { id: "C_PRIV", name: "leads", is_private: true, is_member: true },
        C_OUT: { id: "C_OUT", name: "music", is_private: false, is_member: false },
      },
    });
    const r = new SlackConversationReader(client);
    expect(await r.classifyConversation(ref("C_PUB"))).toEqual({
      visibility: "public",
      botIsMember: true,
      channelName: "frontend",
    });
    expect(await r.classifyConversation(ref("C_PRIV"))).toEqual({
      visibility: "private",
      botIsMember: true,
      channelName: "leads",
    });
    expect(await r.classifyConversation(ref("C_OUT"))).toEqual({
      visibility: "public",
      botIsMember: false,
      channelName: "music",
    });
  });

  it("every shared flag alone is `never` even when is_private is false; so are a DM, a group DM and a missing channel", async () => {
    const flags = ["is_shared", "is_ext_shared", "is_org_shared", "is_pending_ext_shared", "is_im", "is_mpim"] as const;
    const channels: Record<string, Info> = {};
    for (const f of flags)
      channels[`C_${f}`] = { id: `C_${f}`, name: f, is_private: false, is_member: true, [f]: true };
    const { client } = fakeClient({ channels });
    const r = new SlackConversationReader(client);
    for (const f of flags) expect((await r.classifyConversation(ref(`C_${f}`))).visibility, f).toBe("never");
    expect(await r.classifyConversation(ref("C_GONE"))).toEqual({ visibility: "never", botIsMember: false });
  });

  it("serves a classification from its own cache for CLASSIFY_CACHE_MS and asks again after", async () => {
    const { client, calls } = fakeClient({ channels: { C_PUB: PUBLIC } });
    const r = new SlackConversationReader(client);
    await r.classifyConversation(ref("C_PUB"));
    await r.classifyConversation(ref("C_PUB"));
    expect(calls.info).toBe(1);
    vi.advanceTimersByTime(CLASSIFY_CACHE_MS + 1);
    await r.classifyConversation(ref("C_PUB"));
    expect(calls.info).toBe(2);
  });

  it("a failure is not cached: the next call asks Slack again", async () => {
    const { client, calls } = fakeClient({ channels: {} });
    const r = new SlackConversationReader(client);
    await r.classifyConversation(ref("C_GONE"));
    await r.classifyConversation(ref("C_GONE"));
    expect(calls.info).toBe(2);
  });
});

describe("SlackConversationReader.readConversation — text only, newest kept", () => {
  beforeEach(() => resetSlackNameCaches());

  const caps = { maxMessages: 50, maxBytes: 32 * 1024 };

  it("returns the thread's messages as author lines with the bot's status cards dropped and an app's message marked", async () => {
    const { client, calls } = fakeClient({
      channels: { C_PUB: PUBLIC },
      replies: {
        "C_PUB:1.0": [
          { user: "U_ALICE", text: "first <https://a.example|label>", ts: "1.0" },
          { bot_id: "B1", text: "⏳ working on it", ts: "2.0" },
          { bot_id: "B1", text: "the answer", ts: "3.0" },
          { user: "U_BOB", text: "thanks", ts: "4.0" },
        ],
      },
      users: { U_ALICE: { real_name: "Alice" }, U_BOB: { name: "bob" } },
    });
    const r = new SlackConversationReader(client);
    const out = await r.readConversation(
      { channelId: "slack:C_PUB", threadKey: "slack:C_PUB:1.0", url: "https://x" },
      caps,
    );
    expect(out.kind).toBe("reference");
    expect(out.permalink).toBe("https://x");
    expect(out.messages.map((m) => [m.author, m.text, m.at])).toEqual([
      ["Alice", "first label (https://a.example)", 1000],
      ["app", "the answer", 3000],
      ["bob", "thanks", 4000],
    ]);
    expect(calls.replies).toBe(1);
  });

  it("asks for up to 1000 replies in one call and keeps the parent plus the newest maxMessages - 1", async () => {
    const thread = Array.from({ length: 80 }, (_, i) => ({ user: "U_ALICE", text: `m${i}`, ts: `${i + 1}.0` }));
    const { client } = fakeClient({
      channels: { C_PUB: PUBLIC },
      replies: { "C_PUB:1.0": thread },
      users: { U_ALICE: { name: "a" } },
    });
    const r = new SlackConversationReader(client);
    const spy = vi.spyOn(client.conversations, "replies");
    const out = await r.readConversation(
      { channelId: "slack:C_PUB", threadKey: "slack:C_PUB:1.0", url: "https://x" },
      caps,
    );
    expect(spy).toHaveBeenCalledWith({ channel: "C_PUB", ts: "1.0", limit: 1000 });
    expect(out.messages).toHaveLength(50);
    expect(out.messages[0].text).toBe("m0");
    expect(out.messages[1].text).toBe("m31");
    expect(out.messages.at(-1)?.text).toBe("m79");
  });

  it("a bare message permalink reads that one message alone", async () => {
    const thread = [
      { user: "U_ALICE", text: "parent", ts: "1.0" },
      { user: "U_ALICE", text: "the one", ts: "2.0" },
      { user: "U_ALICE", text: "later", ts: "3.0" },
    ];
    const { client } = fakeClient({
      channels: { C_PUB: PUBLIC },
      replies: { "C_PUB:1.0": thread },
      users: { U_ALICE: { name: "a" } },
    });
    const r = new SlackConversationReader(client);
    const out = await r.readConversation(
      { channelId: "slack:C_PUB", threadKey: "slack:C_PUB:1.0", messageId: "2.0", url: "https://x" },
      caps,
    );
    expect(out.messages.map((m) => m.text)).toEqual(["the one"]);
  });

  it("a bare permalink to a message the mapping dropped, or to a ts the thread does not carry, quotes nothing — never the whole thread", async () => {
    const thread = [
      { user: "U_ALICE", text: "parent", ts: "1.0" },
      { bot_id: "B1", text: "⏳ working", ts: "2.0" },
      { user: "U_ALICE", text: "later", ts: "3.0" },
    ];
    const { client } = fakeClient({
      channels: { C_PUB: PUBLIC },
      replies: { "C_PUB:1.0": thread },
      users: { U_ALICE: { name: "a" } },
    });
    const r = new SlackConversationReader(client);
    const dropped = await r.readConversation(
      { channelId: "slack:C_PUB", threadKey: "slack:C_PUB:1.0", messageId: "2.0", url: "https://x" },
      caps,
    );
    expect(dropped.messages).toEqual([]);
    const missing = await r.readConversation(
      { channelId: "slack:C_PUB", threadKey: "slack:C_PUB:1.0", messageId: "9.0", url: "https://x" },
      caps,
    );
    expect(missing.messages).toEqual([]);
  });

  it("a user whose name cannot be resolved is named by id; the channel name comes from the classifier's answer, never a stale cache", async () => {
    const { client } = fakeClient({
      channels: { C_PUB: { ...PUBLIC, name: "renamed" } },
      replies: { "C_PUB:1.0": [{ user: "U_GONE", text: "hi", ts: "1.0" }] },
    });
    const r = new SlackConversationReader(client);
    const out = await r.readConversation(
      { channelId: "slack:C_PUB", threadKey: "slack:C_PUB:1.0", url: "https://x" },
      caps,
    );
    expect(out.messages[0].author).toBe("U_GONE");
    expect(out.channelName).toBe("renamed");
  });
});

describe("SlackConversationReader.requesterIsFullMember — the requester's standing", () => {
  it("a full member is true; a guest or a single-channel guest is false; a lookup failure is false", async () => {
    const { client } = fakeClient({
      users: {
        U_FULL: { name: "a", is_restricted: false, is_ultra_restricted: false },
        U_GUEST: { name: "g", is_restricted: true },
        U_SINGLE: { name: "s", is_ultra_restricted: true },
      },
    });
    const r = new SlackConversationReader(client);
    expect(await r.requesterIsFullMember("slack:U_FULL")).toBe(true);
    expect(await r.requesterIsFullMember("slack:U_GUEST")).toBe(false);
    expect(await r.requesterIsFullMember("slack:U_SINGLE")).toBe(false);
    expect(await r.requesterIsFullMember("slack:U_GONE")).toBe(false);
  });

  it("the platform is slack", () => {
    expect(new SlackConversationReader(fakeClient({}).client).platform).toBe("slack");
  });
});
