import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PERSON_LINK_TTL_MS,
  resetSlackNameCaches,
  resolveChannelName,
  resolvePersonByEmail,
  resolveUserName,
  slackPermalink,
} from "./lookups.js";

// Feature: docs/reference/specs/slack-channel.md — the adapter resolves human display names
// for the channel + user (feeding IncomingMessage.channelName/userName for the
// live-view run label). Best-effort and cached: one API call per new id, any
// error falls back to undefined, and a failure is never cached.
describe("resolveChannelName / resolveUserName (best-effort, cached)", () => {
  afterEach(() => resetSlackNameCaches());

  type ChannelInfo = () => Promise<{ channel?: { name?: string } }>;
  type UserInfo = () => Promise<{
    user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };
  }>;

  function fakeClient(over: { channelInfo?: ChannelInfo; userInfo?: UserInfo } = {}) {
    return {
      conversations: {
        info: vi.fn(over.channelInfo ?? (async () => ({ channel: { name: "eng-prompting" } }))),
      },
      users: {
        info: vi.fn(
          over.userInfo ??
            (async () => ({
              user: {
                name: "alovelace",
                real_name: "Ada Lovelace",
                profile: { display_name: "ada", real_name: "Ada Lovelace" },
              },
            })),
        ),
      },
    };
  }

  it("resolves a channel name and a user display name", async () => {
    const c = fakeClient();
    expect(await resolveChannelName(c, "C1")).toBe("eng-prompting");
    expect(await resolveUserName(c, "UA")).toBe("ada");
  });

  it("prefers profile.display_name, then real_name, then name", async () => {
    const realNameOnly = fakeClient({
      userInfo: async () => ({ user: { name: "alovelace", real_name: "Ada Lovelace", profile: { display_name: "" } } }),
    });
    expect(await resolveUserName(realNameOnly, "UB")).toBe("Ada Lovelace");
    resetSlackNameCaches();
    const handleOnly = fakeClient({ userInfo: async () => ({ user: { name: "alovelace", profile: {} } }) });
    expect(await resolveUserName(handleOnly, "UC")).toBe("alovelace");
  });

  it("caches: a second lookup for the same id does NOT re-call the API", async () => {
    const c = fakeClient();
    expect(await resolveChannelName(c, "C1")).toBe("eng-prompting");
    expect(await resolveChannelName(c, "C1")).toBe("eng-prompting");
    expect(c.conversations.info).toHaveBeenCalledTimes(1);
    expect(await resolveUserName(c, "UA")).toBe("ada");
    expect(await resolveUserName(c, "UA")).toBe("ada");
    expect(c.users.info).toHaveBeenCalledTimes(1);
  });

  it("an API error falls back to undefined without throwing", async () => {
    const boom = fakeClient({
      channelInfo: async () => {
        throw new Error("channel_not_found");
      },
      userInfo: async () => {
        throw new Error("user_not_found");
      },
    });
    await expect(resolveChannelName(boom, "CX")).resolves.toBeUndefined();
    await expect(resolveUserName(boom, "UX")).resolves.toBeUndefined();
  });

  it("does not cache a failed lookup — a later success still resolves", async () => {
    let n = 0;
    const flaky = fakeClient({
      channelInfo: async () => {
        n++;
        if (n === 1) throw new Error("rate_limited");
        return { channel: { name: "general" } };
      },
    });
    expect(await resolveChannelName(flaky, "CF")).toBeUndefined();
    expect(await resolveChannelName(flaky, "CF")).toBe("general");
    expect(flaky.conversations.info).toHaveBeenCalledTimes(2);
  });
});

describe("slackPermalink (the Request block's link back to the thread)", () => {
  it("builds Slack's own permalink shape from the team URL, channel and ts", () => {
    expect(slackPermalink("https://acme.slack.com/", "C1234567890", "1788045076.113369", "1788045076.113369")).toBe(
      "https://acme.slack.com/archives/C1234567890/p1788045076113369",
    );
  });
  it("adds the thread qualifier for a reply inside a thread", () => {
    expect(slackPermalink("https://acme.slack.com", "C1", "1788045099.000100", "1788045076.113369")).toBe(
      "https://acme.slack.com/archives/C1/p1788045099000100?thread_ts=1788045076.113369&cid=C1",
    );
  });
});

// Feature: docs/decisions/0042 — the reverse lookup behind the dashboard link: exact
// lower-cased match, active humans only, cached hits AND misses for the TTL,
// single-flighted, bounded by a timeout, never throwing.
describe("resolvePersonByEmail (the dashboard link, record 0042)", () => {
  afterEach(() => resetSlackNameCaches());

  const person = (over: Record<string, unknown> = {}) => ({
    user: { id: "U123", name: "alovelace", profile: { display_name: "ada", email: "ada@example.test" }, ...over },
  });
  const client = (lookup: (args: { email: string }) => Promise<unknown>) => ({
    conversations: { info: vi.fn(async () => ({})) },
    users: { info: vi.fn(async () => ({})), lookupByEmail: vi.fn(lookup) },
  });

  it("names the person for an email, lower-cased and trimmed, with the display name; a second ask is a cache hit", async () => {
    const c = client(async () => person());
    expect(await resolvePersonByEmail(c as never, " Ada@Example.test ")).toEqual({ id: "slack:U123", name: "ada" });
    expect(await resolvePersonByEmail(c as never, "ada@example.test")).toEqual({ id: "slack:U123", name: "ada" });
    expect(c.users.lookupByEmail).toHaveBeenCalledTimes(1);
    expect(c.users.lookupByEmail).toHaveBeenCalledWith({ email: "ada@example.test" });
  });

  it("a deleted user, a bot, an app user, no user and an API error all resolve to nobody; the miss is cached for the TTL", async () => {
    for (const answer of [
      async () => person({ deleted: true }),
      async () => person({ is_bot: true }),
      async () => person({ is_app_user: true }),
      async () => ({}),
      async () => {
        throw new Error("users_not_found");
      },
    ]) {
      resetSlackNameCaches();
      const c = client(answer);
      expect(await resolvePersonByEmail(c as never, "x@example.test")).toBeUndefined();
      expect(await resolvePersonByEmail(c as never, "x@example.test")).toBeUndefined();
      expect(c.users.lookupByEmail).toHaveBeenCalledTimes(1);
    }
  });

  it("the cache expires after the TTL, so Slack is asked again", async () => {
    let now = 1_000_000;
    const c = client(async () => person());
    await resolvePersonByEmail(c as never, "ada@example.test", { now: () => now });
    now += PERSON_LINK_TTL_MS - 1;
    await resolvePersonByEmail(c as never, "ada@example.test", { now: () => now });
    expect(c.users.lookupByEmail).toHaveBeenCalledTimes(1);
    now += 2;
    await resolvePersonByEmail(c as never, "ada@example.test", { now: () => now });
    expect(c.users.lookupByEmail).toHaveBeenCalledTimes(2);
  });

  it("concurrent asks for one email share one lookup", async () => {
    let release: (v: unknown) => void = () => {};
    const c = client(() => new Promise((r) => (release = r)));
    const a = resolvePersonByEmail(c as never, "ada@example.test");
    const b = resolvePersonByEmail(c as never, "ada@example.test");
    release(person());
    expect(await Promise.all([a, b])).toEqual([
      { id: "slack:U123", name: "ada" },
      { id: "slack:U123", name: "ada" },
    ]);
    expect(c.users.lookupByEmail).toHaveBeenCalledTimes(1);
  });

  it("a lookup slower than the timeout is nobody for that request and is NOT cached; a client without lookupByEmail or a non-email never asks", async () => {
    const c = client(() => new Promise(() => {}));
    expect(await resolvePersonByEmail(c as never, "ada@example.test", { timeoutMs: 5 })).toBeUndefined();
    expect(await resolvePersonByEmail(c as never, "ada@example.test", { timeoutMs: 5 })).toBeUndefined();
    expect(c.users.lookupByEmail).toHaveBeenCalledTimes(2);
    const bare = { conversations: { info: vi.fn() }, users: { info: vi.fn() } };
    expect(await resolvePersonByEmail(bare as never, "ada@example.test")).toBeUndefined();
    const c2 = client(async () => person());
    expect(await resolvePersonByEmail(c2 as never, "not-an-email")).toBeUndefined();
    expect(c2.users.lookupByEmail).not.toHaveBeenCalled();
  });
});
