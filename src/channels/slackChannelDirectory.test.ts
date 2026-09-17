import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_INFO_CACHE_MAX,
  CHANNEL_INFO_TTL_MS,
  SlackChannelDirectory,
  type SlackDirectoryClient,
} from "./slackChannelDirectory.js";

// Feature: docs/reference/specs/authorization.md item 7, docs/reference/specs/slack-channel.md
// item 6a — the Slack `ChannelDirectory`: `conversations.info` decides a
// `slack:C…`/`slack:G…` channel's visibility (is_im/is_mpim → dm, is_private →
// private, else public), cached per channel for a TTL and bounded in size; any
// failure is `unknown` (never public — fail-closed) and remembered for the TTL so Slack is
// asked and the failure logged once per channel per window. `slack:D…` and
// non-Slack ids never reach the API — the id alone says what they are.
// Membership: `users.conversations` lists a person's channels, paged,
// cached per person for the TTL, forgotten on the events the bot wires; `unknown`
// on any failure, and a non-Slack actor is the fallback's answer.

type Info = { is_im?: boolean; is_mpim?: boolean; is_private?: boolean };
/** A person's channels as `users.conversations` pages them: one inner array per page; an entry
 *  `C1!` is a private channel (the bot's own listing carries `is_private`). The key `"*"` is the
 *  bot's own list (a call without `user`). */
type Pages = string[][] | Error;

/** A `users` API that must never be asked. */
const NO_USERS: SlackDirectoryClient["users"] = {
  conversations: async ({ user }) => {
    throw new Error(`unexpected users.conversations for ${user}`);
  },
};

function fakeClient(answers: Record<string, Info | Error | null>, members: Record<string, Pages> = {}) {
  const info = vi.fn(async ({ channel }: { channel: string }) => {
    const a = answers[channel];
    if (a instanceof Error) throw a;
    if (a === null) return {};
    if (a === undefined) throw new Error(`unexpected lookup of ${channel}`);
    return { channel: a };
  });
  const conversations = vi.fn(async ({ user, cursor, limit }: { user?: string; cursor?: string; limit: number }) => {
    const pages = members[user ?? "*"];
    if (pages instanceof Error) throw pages;
    if (pages === undefined) throw new Error(`unexpected users.conversations for ${user ?? "the bot"}`);
    const at = cursor ? Number(cursor) : 0;
    const page = pages[at] ?? [];
    expect(page.length).toBeLessThanOrEqual(limit);
    const next = at + 1 < pages.length ? String(at + 1) : "";
    return {
      channels: page.map((entry) => ({ id: entry.replace(/!$/, ""), is_private: entry.endsWith("!") })),
      response_metadata: { next_cursor: next },
    };
  });
  const client: SlackDirectoryClient = { conversations: { info }, users: { conversations } };
  return { client, info, conversations };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("SlackChannelDirectory.info — visibility from conversations.info", () => {
  it("maps a public channel to public, a private channel to private, a DM and a group DM to dm", async () => {
    const { client } = fakeClient({
      CPUB: { is_private: false },
      CPRIV: { is_private: true },
      GMPIM: { is_mpim: true, is_private: true },
      CIM: { is_im: true },
    });
    const dir = new SlackChannelDirectory(client, { now: clock().now });
    expect(await dir.info("slack:CPUB")).toEqual({ visibility: "public" });
    expect(await dir.info("slack:CPRIV")).toEqual({ visibility: "private" });
    expect(await dir.info("slack:GMPIM")).toEqual({ visibility: "dm" });
    expect(await dir.info("slack:CIM")).toEqual({ visibility: "dm" });
  });

  it("a Slack DM (slack:D…) is dm from the id alone — no API call, so no im:read scope is needed", async () => {
    const { client, info } = fakeClient({});
    const dir = new SlackChannelDirectory(client, { now: clock().now });
    expect(await dir.info("slack:D0AB")).toEqual({ visibility: "dm" });
    expect(info).not.toHaveBeenCalled();
  });

  it("non-Slack ids are the static directory's answer, never a Slack call: http:/mcp: → machine, anything else → unknown", async () => {
    const { client, info } = fakeClient({});
    const dir = new SlackChannelDirectory(client, { now: clock().now });
    expect(await dir.info("http:ops")).toEqual({ visibility: "machine" });
    expect(await dir.info("mcp:ops")).toEqual({ visibility: "machine" });
    expect(await dir.info("cli:local")).toEqual({ visibility: "unknown" });
    expect(info).not.toHaveBeenCalled();
  });

  it("caches per channel for the TTL: a second lookup inside the window makes no API call; after the TTL Slack is asked again", async () => {
    const { client, info } = fakeClient({ C1: { is_private: false } });
    const c = clock();
    const dir = new SlackChannelDirectory(client, { now: c.now });
    expect(await dir.info("slack:C1")).toEqual({ visibility: "public" });
    c.advance(CHANNEL_INFO_TTL_MS - 1);
    expect(await dir.info("slack:C1")).toEqual({ visibility: "public" });
    expect(info).toHaveBeenCalledTimes(1);
    c.advance(2);
    expect(await dir.info("slack:C1")).toEqual({ visibility: "public" });
    expect(info).toHaveBeenCalledTimes(2);
  });

  it("the TTL is injectable and defaults to ten minutes", async () => {
    expect(CHANNEL_INFO_TTL_MS).toBe(10 * 60_000);
    const { client, info } = fakeClient({ C1: { is_private: true } });
    const c = clock();
    const dir = new SlackChannelDirectory(client, { now: c.now, ttlMs: 50 });
    await dir.info("slack:C1");
    c.advance(51);
    await dir.info("slack:C1");
    expect(info).toHaveBeenCalledTimes(2);
  });

  it("the cache is bounded: past the maximum the oldest entry is dropped and re-fetched on its next lookup", async () => {
    const answers: Record<string, Info> = {};
    for (let i = 0; i < 4; i++) answers[`C${i}`] = { is_private: false };
    const { client, info } = fakeClient(answers);
    const dir = new SlackChannelDirectory(client, { now: clock().now, maxEntries: 3 });
    for (let i = 0; i < 4; i++) await dir.info(`slack:C${i}`);
    expect(info).toHaveBeenCalledTimes(4);
    await dir.info("slack:C3"); // still cached
    expect(info).toHaveBeenCalledTimes(4);
    await dir.info("slack:C0"); // evicted as the oldest → fetched again
    expect(info).toHaveBeenCalledTimes(5);
    expect(CHANNEL_INFO_CACHE_MAX).toBe(1000);
  });

  it("fail-closed: an API error, a missing scope, or a reply without a channel is `unknown` — never public — and is logged once per channel per TTL", async () => {
    const { client, info } = fakeClient({ CERR: new Error("missing_scope"), CNONE: null });
    const warnings: string[] = [];
    const c = clock();
    const dir = new SlackChannelDirectory(client, { now: c.now, warn: (m) => warnings.push(m) });
    expect(await dir.info("slack:CERR")).toEqual({ visibility: "unknown" });
    expect(await dir.info("slack:CERR")).toEqual({ visibility: "unknown" });
    expect(await dir.info("slack:CNONE")).toEqual({ visibility: "unknown" });
    expect(info).toHaveBeenCalledTimes(2); // the failure is remembered for the TTL — Slack is not hammered
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("slack:CERR");
    expect(warnings[0]).toContain("missing_scope");
    expect(warnings[0]).toContain("unknown");
    expect(warnings[1]).toContain("slack:CNONE");
    c.advance(CHANNEL_INFO_TTL_MS + 1);
    expect(await dir.info("slack:CERR")).toEqual({ visibility: "unknown" });
    expect(info).toHaveBeenCalledTimes(3);
    expect(warnings).toHaveLength(3);
  });

  it("concurrent first lookups of one channel share a single API call", async () => {
    let release!: (v: { channel: Info }) => void;
    const info = vi.fn(() => new Promise<{ channel: Info }>((resolve) => (release = resolve)));
    const dir = new SlackChannelDirectory({ conversations: { info }, users: NO_USERS }, { now: clock().now });
    const a = dir.info("slack:C1");
    const b = dir.info("slack:C1");
    release({ channel: { is_private: false } });
    expect(await a).toEqual({ visibility: "public" });
    expect(await b).toEqual({ visibility: "public" });
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe("SlackChannelDirectory.channelsOf — a person's channels from users.conversations", () => {
  it("lists every public and private channel the person is in as slack: ids, paged by cursor; asked once per person per TTL and again after it", async () => {
    const { client, conversations, info } = fakeClient({}, { UA: [["C1", "C2"], ["G3"]], UB: [[]] });
    const c = clock();
    const dir = new SlackChannelDirectory(client, { now: c.now, ttlMs: 1000 });
    expect(await dir.channelsOf("slack:UA")).toEqual(new Set(["slack:C1", "slack:C2", "slack:G3"]));
    expect(conversations).toHaveBeenCalledTimes(2); // two pages, one ask
    expect(conversations.mock.calls[0]?.[0]).toMatchObject({
      user: "UA",
      types: "public_channel,private_channel",
      exclude_archived: true,
    });
    expect(conversations.mock.calls[1]?.[0]).toMatchObject({ user: "UA", cursor: "1" });
    expect(await dir.channelsOf("slack:UA")).toEqual(new Set(["slack:C1", "slack:C2", "slack:G3"]));
    expect(conversations).toHaveBeenCalledTimes(2); // cached
    expect(await dir.channelsOf("slack:UB")).toEqual(new Set()); // in no channel the bot can see: an empty set, not unknown
    c.advance(1001);
    expect(await dir.channelsOf("slack:UA")).toEqual(new Set(["slack:C1", "slack:C2", "slack:G3"]));
    expect(conversations).toHaveBeenCalledTimes(5); // the TTL passed: two pages again
    expect(info).not.toHaveBeenCalled(); // membership never asks conversations.info
  });

  it("concurrent first asks for one person share a single API call", async () => {
    let release!: (v: { channels: { id: string }[] }) => void;
    const conversations = vi.fn(() => new Promise<{ channels: { id: string }[] }>((resolve) => (release = resolve)));
    const dir = new SlackChannelDirectory(
      { conversations: { info: async () => ({}) }, users: { conversations } },
      { now: clock().now },
    );
    const a = dir.channelsOf("slack:UA");
    const b = dir.channelsOf("slack:UA");
    release({ channels: [{ id: "C1" }] });
    expect(await a).toEqual(new Set(["slack:C1"]));
    expect(await b).toEqual(new Set(["slack:C1"]));
    expect(conversations).toHaveBeenCalledTimes(1);
  });

  it("fail-closed: an API failure is unknown for the TTL and logged once per person per window; a non-Slack actor, a bot or an app id never reaches the API", async () => {
    const { client, conversations } = fakeClient({}, { UERR: new Error("missing_scope") });
    const warnings: string[] = [];
    const c = clock();
    const dir = new SlackChannelDirectory(client, { now: c.now, ttlMs: 1000, warn: (m) => warnings.push(m) });
    expect(await dir.channelsOf("slack:UERR")).toBe("unknown");
    expect(await dir.channelsOf("slack:UERR")).toBe("unknown");
    expect(conversations).toHaveBeenCalledTimes(1); // remembered for the TTL
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("slack:UERR");
    expect(warnings[0]).toContain("missing_scope");
    c.advance(1001);
    expect(await dir.channelsOf("slack:UERR")).toBe("unknown");
    expect(conversations).toHaveBeenCalledTimes(2);
    expect(await dir.channelsOf("http:ops")).toBe("unknown");
    expect(await dir.channelsOf("access:a1")).toBe("unknown");
    expect(await dir.channelsOf("slack:B0BOT")).toBe("unknown");
    expect(conversations).toHaveBeenCalledTimes(2);
  });

  it("forgetMember makes the next ask for that person go to Slack and leaves everyone else cached; forgetAll forgets everyone", async () => {
    const { client, conversations } = fakeClient({}, { UA: [["C1"]], UB: [["C2"]] });
    const dir = new SlackChannelDirectory(client, { now: clock().now });
    await dir.channelsOf("slack:UA");
    await dir.channelsOf("slack:UB");
    expect(conversations).toHaveBeenCalledTimes(2);
    dir.forgetMember("slack:UA");
    dir.forgetMember("slack:UNOBODY"); // nothing cached: a no-op
    await dir.channelsOf("slack:UA");
    await dir.channelsOf("slack:UB");
    expect(conversations).toHaveBeenCalledTimes(3);
    dir.forgetAll();
    await dir.channelsOf("slack:UA");
    await dir.channelsOf("slack:UB");
    expect(conversations).toHaveBeenCalledTimes(5);
  });

  it("more pages than the cap is unknown — never a partial set presented as the whole — and the bounded cache evicts the oldest person", async () => {
    const endless = Array.from({ length: 11 }, (_, i) => [`C${i}`]);
    const people: Record<string, Pages> = { ULONG: endless };
    for (let i = 0; i < 5; i++) people[`UP${i}`] = [[`C${i}`]];
    const { client, conversations } = fakeClient({}, people);
    const warnings: string[] = [];
    const dir = new SlackChannelDirectory(client, { now: clock().now, maxEntries: 4, warn: (m) => warnings.push(m) });
    expect(await dir.channelsOf("slack:ULONG")).toBe("unknown");
    expect(conversations).toHaveBeenCalledTimes(10);
    expect(warnings[0]).toContain("slack:ULONG");
    expect(warnings[0]).toContain("pages");
    conversations.mockClear();
    for (let i = 0; i < 4; i++) await dir.channelsOf(`slack:UP${i}`);
    expect(conversations).toHaveBeenCalledTimes(4);
    await dir.channelsOf("slack:UP1"); // still cached (ULONG was the oldest and went at UP3)
    expect(conversations).toHaveBeenCalledTimes(4);
    await dir.channelsOf("slack:UP4"); // evicts UP0
    await dir.channelsOf("slack:UP0");
    expect(conversations).toHaveBeenCalledTimes(6);
  });
});

describe("SlackChannelDirectory.channels — the bot's own channels, with their visibility", () => {
  it("lists every channel the bot is in as slack: ids with public or private from the listing, paged by cursor; cached for the TTL and again after; forgetAll forgets it", async () => {
    const { client, conversations } = fakeClient({}, { "*": [["CPUB1", "CPRIV1!"], ["GPRIV2!"]] });
    const c = clock();
    const dir = new SlackChannelDirectory(client, { now: c.now, ttlMs: 1000 });
    expect(await dir.channels()).toEqual([
      { id: "slack:CPUB1", visibility: "public" },
      { id: "slack:CPRIV1", visibility: "private" },
      { id: "slack:GPRIV2", visibility: "private" },
    ]);
    expect(conversations).toHaveBeenCalledTimes(2);
    expect(conversations.mock.calls[0]?.[0]).not.toHaveProperty("user"); // the bot's own list
    await dir.channels();
    expect(conversations).toHaveBeenCalledTimes(2); // cached
    dir.forgetAll();
    await dir.channels();
    expect(conversations).toHaveBeenCalledTimes(4); // forgotten: listed again
    c.advance(1001);
    await dir.channels();
    expect(conversations).toHaveBeenCalledTimes(6); // the TTL passed
  });

  it("concurrent first asks share one listing; a failure is unknown for the TTL with one warning; past the page cap is unknown", async () => {
    let release!: (v: { channels: { id: string }[] }) => void;
    const slow = vi.fn(() => new Promise<{ channels: { id: string }[] }>((resolve) => (release = resolve)));
    const shared = new SlackChannelDirectory(
      { conversations: { info: async () => ({}) }, users: { conversations: slow } },
      { now: clock().now },
    );
    const a = shared.channels();
    const b = shared.channels();
    release({ channels: [{ id: "C1" }] });
    expect(await a).toEqual([{ id: "slack:C1", visibility: "public" }]);
    expect(await b).toEqual([{ id: "slack:C1", visibility: "public" }]);
    expect(slow).toHaveBeenCalledTimes(1);

    const warnings: string[] = [];
    const { client, conversations } = fakeClient({}, { "*": new Error("missing_scope") });
    const failing = new SlackChannelDirectory(client, { now: clock().now, warn: (m) => warnings.push(m) });
    expect(await failing.channels()).toBe("unknown");
    expect(await failing.channels()).toBe("unknown");
    expect(conversations).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("missing_scope");

    const endless = Array.from({ length: 11 }, (_, i) => [`C${i}`]);
    const capped = new SlackChannelDirectory(fakeClient({}, { "*": endless }).client, {
      now: clock().now,
      warn: () => {},
    });
    expect(await capped.channels()).toBe("unknown");
  });
});

describe("SlackChannelDirectory — a forget during a lookup wins", () => {
  it("a forgetAll or forgetMember while a listing is in flight lets the flight answer its caller but caches nothing, so the next ask goes to Slack", async () => {
    let releaseOwn!: (v: { channels: { id: string }[] }) => void;
    let releaseMember!: (v: { channels: { id: string }[] }) => void;
    const conversations = vi.fn(
      ({ user }: { user?: string }) =>
        new Promise<{ channels: { id: string }[] }>((resolve) => {
          if (user === undefined) releaseOwn = resolve;
          else releaseMember = resolve;
        }),
    );
    const dir = new SlackChannelDirectory(
      { conversations: { info: async () => ({}) }, users: { conversations } },
      { now: clock().now },
    );
    const own = dir.channels();
    const member = dir.channelsOf("slack:UFLY");
    dir.forgetAll(); // the bot's reach moved while both listings were in flight
    releaseOwn({ channels: [{ id: "COLD" }] });
    releaseMember({ channels: [{ id: "COLD" }] });
    expect(await own).toEqual([{ id: "slack:COLD", visibility: "public" }]); // the caller still gets an answer
    expect(await member).toEqual(new Set(["slack:COLD"]));
    expect(conversations).toHaveBeenCalledTimes(2);
    void dir.channels(); // not cached: Slack is asked again
    void dir.channelsOf("slack:UFLY");
    expect(conversations).toHaveBeenCalledTimes(4);
  });
});

describe("SlackChannelDirectory.isMember — the person's own channel set", () => {
  it("is true for a channel in the set, false for one outside it, unknown when the set is unknown, and the fallback's unknown for a non-Slack actor", async () => {
    const { client, conversations } = fakeClient({}, { UA: [["C1"]], UERR: new Error("down") });
    const dir = new SlackChannelDirectory(client, { now: clock().now });
    expect(await dir.isMember("slack:UA", "slack:C1")).toBe(true);
    expect(await dir.isMember("slack:UA", "slack:C9")).toBe(false);
    expect(await dir.isMember("slack:UERR", "slack:C1")).toBe("unknown");
    expect(await dir.isMember("http:ops", "http:ops")).toBe("unknown");
    expect(conversations).toHaveBeenCalledTimes(2); // one per person, shared with channelsOf
  });
});
