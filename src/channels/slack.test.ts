import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyMessage,
  fetchImages,
  resetSlackNameCaches,
  resolveChannelName,
  resolveUserName,
  stripMention,
  threadIncludesBot,
} from "./slack.js";

// Feature: features/slack-channel.md — trigger gating (which events start a
// run) and image-attachment ingestion within budgets.

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
    expect(threadIncludesBot([{ user: "U1", text: "q" }, { user: BOT, text: "a" }], BOT)).toBe(true);
  });

  it("true when the bot was mentioned anywhere in the thread", () => {
    expect(threadIncludesBot([{ user: "U1", text: `<@${BOT}> help` }], BOT)).toBe(true);
  });

  it("false otherwise, and false without a bot user id", () => {
    expect(threadIncludesBot([{ user: "U1", text: "just people talking" }], BOT)).toBe(false);
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

// Feature: features/slack-channel.md — the adapter resolves human display names
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
        info: vi.fn(over.channelInfo ?? (async () => ({ channel: { name: "switchboard-prompting" } }))),
      },
      users: {
        info: vi.fn(
          over.userInfo ??
            (async () => ({
              user: { name: "juser", real_name: "Justin Helmer", profile: { display_name: "justin", real_name: "Justin Helmer" } },
            })),
        ),
      },
    };
  }

  it("resolves a channel name and a user display name", async () => {
    const c = fakeClient();
    expect(await resolveChannelName(c, "C1")).toBe("switchboard-prompting");
    expect(await resolveUserName(c, "U1")).toBe("justin");
  });

  it("prefers profile.display_name, then real_name, then name", async () => {
    const realNameOnly = fakeClient({
      userInfo: async () => ({ user: { name: "juser", real_name: "Justin Helmer", profile: { display_name: "" } } }),
    });
    expect(await resolveUserName(realNameOnly, "U2")).toBe("Justin Helmer");
    resetSlackNameCaches();
    const handleOnly = fakeClient({ userInfo: async () => ({ user: { name: "juser", profile: {} } }) });
    expect(await resolveUserName(handleOnly, "U3")).toBe("juser");
  });

  it("caches: a second lookup for the same id does NOT re-call the API", async () => {
    const c = fakeClient();
    expect(await resolveChannelName(c, "C1")).toBe("switchboard-prompting");
    expect(await resolveChannelName(c, "C1")).toBe("switchboard-prompting");
    expect(c.conversations.info).toHaveBeenCalledTimes(1);
    expect(await resolveUserName(c, "U1")).toBe("justin");
    expect(await resolveUserName(c, "U1")).toBe("justin");
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

describe("fetchImages (attachment ingestion within budgets)", () => {
  const png = (name: string, size = 100) => ({
    id: name,
    name,
    mimetype: "image/png",
    size,
    url_private_download: `https://files.slack.test/${name}`,
  });

  function stubFetch(bytes = 8, contentType = "image/png", status = 200) {
    const fetchMock = vi.fn(async () => {
      return new Response(new Uint8Array(bytes).fill(7), {
        status,
        headers: { "content-type": contentType },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => vi.unstubAllGlobals());

  it("downloads accepted images and returns base64 payloads", async () => {
    stubFetch();
    const { images, skipped } = await fetchImages([png("a.png")], 10);
    expect(skipped).toEqual([]);
    expect(images).toHaveLength(1);
    expect(images[0].mediaType).toBe("image/png");
    expect(Buffer.from(images[0].data, "base64")).toHaveLength(8);
  });

  it("skips non-image types, oversize files, and over-count files without fetching them", async () => {
    const fetchMock = stubFetch();
    const files = [
      { id: "doc", name: "notes.pdf", mimetype: "application/pdf", size: 10, url_private_download: "https://x/d" },
      { ...png("huge.png"), size: 6 * 1024 * 1024 },
      png("ok1.png"),
      png("ok2.png"),
    ];
    const { images, skipped } = await fetchImages(files, 1);
    expect(images).toHaveLength(1);
    expect(skipped).toEqual([
      "notes.pdf (application/pdf)",
      "huge.png (image/png)",
      "ok2.png (image/png)", // over the per-message count budget
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats Slack's HTML login page (HTTP 200) as a failed download", async () => {
    stubFetch(8, "text/html; charset=utf-8");
    const { images, skipped } = await fetchImages([png("a.png")], 10);
    expect(images).toEqual([]);
    expect(skipped).toEqual(["a.png (image/png)"]);
  });

  it("skips downloads that would blow the total byte budget and reports bytes spent", async () => {
    stubFetch(10);
    const { images, skipped, bytes } = await fetchImages([png("a.png"), png("b.png")], 10, 15);
    expect(images).toHaveLength(1); // second download would exceed 15 bytes total
    expect(skipped).toEqual(["b.png (image/png)"]);
    expect(bytes).toBe(10);
  });

  it("survives a failed fetch and names the skipped file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const { images, skipped } = await fetchImages([png("a.png")], 10);
    expect(images).toEqual([]);
    expect(skipped).toEqual(["a.png (image/png)"]);
  });

  it("survives a thrown non-Error too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw "string failure"; // eslint-disable-line no-throw-literal
      }),
    );
    const { images, skipped } = await fetchImages([png("a.png")], 10);
    expect(images).toEqual([]);
    expect(skipped).toEqual(["a.png (image/png)"]);
  });
});
