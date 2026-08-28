import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyDocument,
  classifyMessage,
  fetchDocuments,
  fetchImages,
  render,
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

// Feature: features/channel-formatter.md — the status/progress card is Block Kit
// mrkdwn built from untrusted content (frame.detail carries tool-output summaries
// and the agent's free-text update_status; frame.title carries the run label), so
// both are escaped before they land in mrkdwn text fields — otherwise a value like
// <!channel> would trigger a live @channel broadcast from a status card.
describe("render (status card mrkdwn escaping)", () => {
  type Section = { type: string; text?: { type: string; text: string }; elements?: { text: string }[] };

  it("neutralizes injection (<!channel>, <@U…>, <url|label>) in frame.detail", () => {
    const out = render({
      title: "run",
      detail: "<!channel> ping <@U123> see <https://evil.test|click>",
    });
    const section = out.blocks[1] as Section;
    const text = section.text!.text;
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).toContain("&lt;@U123&gt;");
    expect(text).toContain("&lt;https://evil.test|click&gt;");
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<@U123>");
  });

  it("escapes frame.title in both the context block and the top-level text fallback", () => {
    const out = render({ title: "coding <!channel> now" });
    const context = out.blocks[0] as Section;
    expect(context.elements![0].text).toContain("&lt;!channel&gt;");
    expect(context.elements![0].text).not.toContain("<!channel>");
    expect(out.text).toContain("&lt;!channel&gt;");
    expect(out.text).not.toContain("<!channel>");
  });

  it("preserves intentional *bold*/`code` markup in the title (escapeMrkdwn only touches &<>)", () => {
    const out = render({ title: "*coding* on `claude` · 42s" });
    expect(out.text).toBe("*coding* on `claude` · 42s");
  });

  it("keeps the escaped detail under Slack's ~3000-char section cap even for adversarial input", () => {
    const out = render({ title: "t", detail: "&".repeat(5000) });
    const section = out.blocks[1] as Section;
    expect(section.text!.text.length).toBeLessThanOrEqual(2900);
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

describe("stripMention — Slack app 'Sent using' footer", () => {
  // Messages posted through a Slack app on a user's behalf (e.g. the Claude
  // Slack plugin) carry a trailing "*Sent using* <@APP|Name>" line. It is
  // platform chrome, not user text: a `repo onboard owner/name` followed by it
  // must parse exactly like the bare command.
  it("drops a trailing '*Sent using* <@APP|Name>' footer line", () => {
    expect(stripMention(`<@${BOT}> repo onboard coreplanelabs/switchboard\n*Sent using* <@U0BJJMDUCKY|Claude>`, BOT)).toBe(
      "repo onboard coreplanelabs/switchboard",
    );
  });

  it("accepts the unbolded and label-less forms and surrounding whitespace", () => {
    expect(stripMention(`<@${BOT}> repo list\n\nSent using <@U0BJJMDUCKY>  `, BOT)).toBe("repo list");
  });

  it("leaves 'Sent using' alone when it is part of the user's own text (not a trailing footer line)", () => {
    expect(stripMention(`<@${BOT}> what does "Sent using" mean here?`, BOT)).toBe('what does "Sent using" mean here?');
    expect(stripMention(`<@${BOT}> Sent using <@U0BJJMDUCKY> is the footer\nplease explain`, BOT)).toBe(
      "Sent using <@U0BJJMDUCKY> is the footer\nplease explain",
    );
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

describe("fetchDocuments (PDF + text/code ingestion within budgets)", () => {
  const pdf = (name: string, size = 100) => ({
    id: name,
    name,
    mimetype: "application/pdf",
    size,
    url_private_download: `https://files.slack.test/${name}`,
  });
  const textFile = (name: string, mimetype: string, size = 100) => ({
    id: name,
    name,
    mimetype,
    size,
    url_private_download: `https://files.slack.test/${name}`,
  });

  /** Body defaults to bytes for PDFs; pass a string to simulate a text download. */
  function stubFetch(body: BodyInit = new Uint8Array(8).fill(7), contentType = "application/pdf", status = 200) {
    const fetchMock = vi.fn(async () => {
      return new Response(body, { status, headers: { "content-type": contentType } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => vi.unstubAllGlobals());

  it("downloads a PDF and returns a base64 payload with the application/pdf media type", async () => {
    stubFetch(new Uint8Array(8).fill(7), "application/pdf");
    const { documents, skipped } = await fetchDocuments([pdf("report.pdf")], 10);
    expect(skipped).toEqual([]);
    expect(documents).toHaveLength(1);
    expect(documents[0].mediaType).toBe("application/pdf");
    expect(documents[0].name).toBe("report.pdf");
    expect(Buffer.from(documents[0].data, "base64")).toHaveLength(8);
  });

  it("decodes a text/code/csv file to UTF-8 text (not base64)", async () => {
    stubFetch("hello,world\n1,2\n", "text/csv");
    const { documents, skipped } = await fetchDocuments([textFile("data.csv", "text/csv")], 10);
    expect(skipped).toEqual([]);
    expect(documents).toHaveLength(1);
    expect(documents[0].mediaType).toBe("text/csv");
    expect(documents[0].data).toBe("hello,world\n1,2\n");
  });

  it("accepts code files by extension when the mimetype is generic", async () => {
    stubFetch("export const x = 1;\n", "application/octet-stream");
    const { documents, skipped } = await fetchDocuments(
      [textFile("main.ts", "application/octet-stream")],
      10,
    );
    expect(skipped).toEqual([]);
    expect(documents).toHaveLength(1);
    expect(documents[0].data).toBe("export const x = 1;\n");
  });

  it("skips images and unsupported types without fetching them", async () => {
    const fetchMock = stubFetch();
    const files = [
      { id: "img", name: "shot.png", mimetype: "image/png", size: 10, url_private_download: "https://x/i" },
      { id: "bin", name: "app.bin", mimetype: "application/octet-stream", size: 10, url_private_download: "https://x/b" },
      pdf("ok.pdf"),
    ];
    const { documents, skipped } = await fetchDocuments(files, 10);
    expect(documents).toHaveLength(1);
    expect(documents[0].name).toBe("ok.pdf");
    expect(skipped).toEqual(["shot.png (image/png)", "app.bin (application/octet-stream)"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips oversize files and over-count files without fetching them", async () => {
    const fetchMock = stubFetch();
    const files = [
      { ...pdf("huge.pdf"), size: 11 * 1024 * 1024 },
      pdf("one.pdf"),
      pdf("two.pdf"),
    ];
    const { documents, skipped } = await fetchDocuments(files, 1);
    expect(documents).toHaveLength(1);
    expect(skipped).toEqual([
      "huge.pdf (application/pdf)",
      "two.pdf (application/pdf)", // over the per-message count budget
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats Slack's HTML login page as a failed PDF download", async () => {
    stubFetch("<html>login</html>", "text/html; charset=utf-8");
    const { documents, skipped } = await fetchDocuments([pdf("report.pdf")], 10);
    expect(documents).toEqual([]);
    expect(skipped).toEqual(["report.pdf (application/pdf)"]);
  });

  it("accepts a real .html text file (its own text/html type is not the login page)", async () => {
    stubFetch("<h1>Doc</h1>", "text/html; charset=utf-8");
    const { documents, skipped } = await fetchDocuments([textFile("page.html", "text/html")], 10);
    expect(skipped).toEqual([]);
    expect(documents).toHaveLength(1);
    expect(documents[0].data).toBe("<h1>Doc</h1>");
  });

  it("skips downloads that would blow the total byte budget and reports bytes spent", async () => {
    stubFetch(new Uint8Array(10).fill(7), "application/pdf");
    const { documents, skipped, bytes } = await fetchDocuments([pdf("a.pdf"), pdf("b.pdf")], 10, 15);
    expect(documents).toHaveLength(1); // second download would exceed 15 bytes total
    expect(skipped).toEqual(["b.pdf (application/pdf)"]);
    expect(bytes).toBe(10);
  });

  it("survives a failed fetch and names the skipped file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const { documents, skipped } = await fetchDocuments([pdf("a.pdf")], 10);
    expect(documents).toEqual([]);
    expect(skipped).toEqual(["a.pdf (application/pdf)"]);
  });
});

// Feature: features/slack-channel.md — secret-file denylist. A file whose name
// looks like credentials/keys/private config is never inlined into the model
// prompt, even when its mimetype or extension would otherwise mark it text.
describe("classifyDocument (secret-file denylist overrides text classification)", () => {
  it("denies every secret-shaped filename even with a text-ish mimetype", () => {
    for (const name of [
      ".env", ".env.local", ".env.production", "config.env", "prod.env",
      "credentials.json", "gcp-service-account.json", "app-key.json",
      "id_rsa", "id_rsa.pub", "foo.pem", "server.key", "cert.p12", "cert.pfx",
      ".npmrc", ".netrc", "db.cfg", "app.conf", "settings.ini",
    ]) {
      expect(classifyDocument("text/plain", name), name).toBeNull();
    }
  });

  it("denies credentials.json even when Slack reports application/json", () => {
    expect(classifyDocument("application/json", "credentials.json")).toBeNull();
  });

  it("matches case-insensitively", () => {
    expect(classifyDocument("text/plain", "CONFIG.ENV")).toBeNull();
    expect(classifyDocument("text/plain", "ID_RSA")).toBeNull();
    expect(classifyDocument("application/json", "Credentials.JSON")).toBeNull();
  });

  it("no longer treats plain .json / config files as inlinable text (conservative gating)", () => {
    expect(classifyDocument("application/json", "data.json")).toBeNull();
    expect(classifyDocument("application/octet-stream", "data.json")).toBeNull();
    expect(classifyDocument("application/octet-stream", "settings.ini")).toBeNull();
  });

  it("keeps genuinely-safe pdf / text / code / log files working", () => {
    expect(classifyDocument("application/pdf", "report.pdf")).toBe("pdf");
    expect(classifyDocument("text/plain", "notes.txt")).toBe("text");
    expect(classifyDocument("text/csv", "data.csv")).toBe("text");
    expect(classifyDocument("application/octet-stream", "main.ts")).toBe("text");
    expect(classifyDocument("text/plain", "app.log")).toBe("text");
  });
});

describe("fetchDocuments (secret files skipped-with-note, never decoded)", () => {
  const secretFile = (name: string, mimetype: string, size = 100) => ({
    id: name,
    name,
    mimetype,
    size,
    url_private_download: `https://files.slack.test/${name}`,
  });
  function stubFetch(body: BodyInit = "SECRET=hunter2\n", contentType = "text/plain") {
    const fetchMock = vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": contentType } }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  afterEach(() => vi.unstubAllGlobals());

  // The reviewer's PoC files, carrying the text-ish mimetypes Slack actually
  // reports for them — so this proves the denylist OVERRIDES text classification.
  const poc = [
    secretFile("config.env", "text/plain"),
    secretFile("credentials.json", "application/json"),
    secretFile("prod.env", "text/plain"),
    secretFile("db.cfg", "text/plain"),
    secretFile("app.conf", "text/plain"),
    secretFile(".env.local", "text/plain"),
    secretFile("id_rsa", "text/plain"),
    secretFile("foo.pem", "text/plain"),
  ];

  it("skips every PoC secret file, returns none as a document, and never fetches them", async () => {
    const fetchMock = stubFetch();
    const { documents, skipped } = await fetchDocuments(poc, 10);
    expect(documents).toEqual([]);
    expect(skipped).toEqual([
      "config.env (text/plain)",
      "credentials.json (application/json)",
      "prod.env (text/plain)",
      "db.cfg (text/plain)",
      "app.conf (text/plain)",
      ".env.local (text/plain)",
      "id_rsa (text/plain)",
      "foo.pem (text/plain)",
    ]);
    // Never decoded into the prompt: a denied file is skipped before any download.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still ingests genuinely-safe files alongside a secret one", async () => {
    const fetchMock = stubFetch("hello\n", "text/plain");
    const files = [
      secretFile("config.env", "text/plain"),
      { id: "n", name: "notes.txt", mimetype: "text/plain", size: 10, url_private_download: "https://x/n" },
      { id: "d", name: "data.csv", mimetype: "text/csv", size: 10, url_private_download: "https://x/d" },
      { id: "m", name: "main.ts", mimetype: "application/octet-stream", size: 10, url_private_download: "https://x/m" },
    ];
    const { documents, skipped } = await fetchDocuments(files, 10);
    expect(documents.map((d) => d.name)).toEqual(["notes.txt", "data.csv", "main.ts"]);
    expect(skipped).toEqual(["config.env (text/plain)"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
