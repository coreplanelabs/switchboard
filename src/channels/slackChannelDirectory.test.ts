import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_INFO_CACHE_MAX,
  CHANNEL_INFO_TTL_MS,
  SlackChannelDirectory,
  type ConversationInfoClient,
} from "./slackChannelDirectory.js";

// Feature: features/authorization.md item 7, features/slack-channel.md
// item 6a — the Slack `ChannelDirectory`: `conversations.info` decides a
// `slack:C…`/`slack:G…` channel's visibility (is_im/is_mpim → dm, is_private →
// private, else public), cached per channel for a TTL and bounded in size; any
// failure is `unknown` (never public — fail-closed) and remembered for the TTL so Slack is
// asked and the failure logged once per channel per window. `slack:D…` and
// non-Slack ids never reach the API — the id alone says what they are.

type Info = { is_im?: boolean; is_mpim?: boolean; is_private?: boolean };

function fakeClient(answers: Record<string, Info | Error | null>) {
  const info = vi.fn(async ({ channel }: { channel: string }) => {
    const a = answers[channel];
    if (a instanceof Error) throw a;
    if (a === null) return {};
    if (a === undefined) throw new Error(`unexpected lookup of ${channel}`);
    return { channel: a };
  });
  const client: ConversationInfoClient = { conversations: { info } };
  return { client, info };
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
    const dir = new SlackChannelDirectory({ conversations: { info } }, { now: clock().now });
    const a = dir.info("slack:C1");
    const b = dir.info("slack:C1");
    release({ channel: { is_private: false } });
    expect(await a).toEqual({ visibility: "public" });
    expect(await b).toEqual({ visibility: "public" });
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe("SlackChannelDirectory.isMember — the membership seam (not enumerated yet)", () => {
  it("answers `unknown` for every actor and channel — not a member (fail-closed) — until conversations.members lands behind this seam", async () => {
    const { client, info } = fakeClient({});
    const dir = new SlackChannelDirectory(client, { now: clock().now });
    expect(await dir.isMember("slack:UA", "slack:C1")).toBe("unknown");
    expect(await dir.isMember("http:ops", "http:ops")).toBe("unknown");
    expect(info).not.toHaveBeenCalled();
  });
});
