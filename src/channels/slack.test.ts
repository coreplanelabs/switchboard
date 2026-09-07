import { afterEach, describe, expect, it, vi } from "vitest";
import {
  catchUpDelayNote,
  dedupeDelivery,
  STALE_DELIVERY_MS,
  slackPermalink,
  classifyDocument,
  classifyMessage,
  fetchDocuments,
  fetchImages,
  render,
  resetSlackNameCaches,
  SlackIO,
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

// Feature: features/run-visibility.md item 2 — the status/progress card is a context
// headline (mrkdwn, escaped) over a rich_text body. The body must be rich_text,
// never a section: Slack folds a section's mrkdwn behind "Show more" at five
// rendered lines and re-renders a folded card expanded-then-collapsed on every
// edit, so a section-bodied card makes the whole thread jump on each heartbeat
// (measured live 2026-08-30; see the render() doc comment). rich_text `text`
// elements are also literal, so untrusted detail cannot smuggle a <!channel>.
describe("render (status card rich_text body)", () => {
  type ContextBlock = { type: string; elements: { text: string }[] };
  type RichText = {
    type: string;
    elements: { type: string; elements: { type: string; text?: string; url?: string }[] }[];
  };
  const body = (out: { blocks: object[] }) => out.blocks[1] as RichText;
  const bodyElements = (out: { blocks: object[] }) => body(out).elements[0].elements;

  it("renders the body as a rich_text block, never a foldable section", () => {
    const out = render({
      title: "run",
      link: { url: "https://b.example/r", label: "Live run" },
      detail: "✓ a\n✓ b\n✓ c\n✓ d\n✓ e\n✓ f",
    });
    expect(body(out).type).toBe("rich_text");
    expect(out.blocks.map((b) => (b as { type: string }).type)).not.toContain("section");
  });

  it("carries untrusted frame.detail verbatim in a literal text element (<!channel> cannot fire)", () => {
    const detail = "<!channel> ping <@U123> see <https://evil.test|click>";
    const out = render({ title: "run", detail });
    const [text] = bodyElements(out);
    expect(text).toEqual({ type: "text", text: detail });
  });

  it("escapes frame.title in both the context block and the top-level text fallback", () => {
    const out = render({ title: "coding <!channel> now" });
    const context = out.blocks[0] as ContextBlock;
    expect(context.elements[0].text).toContain("&lt;!channel&gt;");
    expect(context.elements[0].text).not.toContain("<!channel>");
    expect(out.text).toContain("&lt;!channel&gt;");
    expect(out.text).not.toContain("<!channel>");
  });

  it("preserves intentional *bold*/`code` markup in the title (escapeMrkdwn only touches &<>)", () => {
    const out = render({ title: "*coding* on `claude` · 42s" });
    expect(out.text).toBe("*coding* on `claude` · 42s");
  });

  it("renders frame.link as a typed link element whose URL adds no rendered width", () => {
    const url = "https://bot.example/runs/abc?t=" + "f".repeat(64);
    const out = render({ title: "run", link: { url, label: "Live run" }, detail: "✓ step" });
    expect(bodyElements(out)).toEqual([
      { type: "link", url, text: "Live run" },
      { type: "text", text: "\n✓ step" },
    ]);
    expect(out.blocks).toHaveLength(2);
  });

  it("renders a link-only frame (no detail) as just the link element", () => {
    const out = render({ title: "run", link: { url: "https://bot.example/runs/abc?t=x", label: "Live run" } });
    expect(bodyElements(out)).toEqual([{ type: "link", url: "https://bot.example/runs/abc?t=x", text: "Live run" }]);
  });

  it("keeps mrkdwn-sensitive characters in the link label/url verbatim (typed fields, no escaping)", () => {
    const out = render({ title: "run", link: { url: "https://bot.example/r?a=1&b=2", label: "a<b|c" } });
    expect(bodyElements(out)).toEqual([{ type: "link", url: "https://bot.example/r?a=1&b=2", text: "a<b|c" }]);
  });

  it("omits the body block entirely when the frame has no link and no detail", () => {
    const out = render({ title: "run" });
    expect(out.blocks).toHaveLength(1);
  });

  it("caps the detail so the blocks payload stays bounded for adversarial input", () => {
    const out = render({ title: "t", detail: "x".repeat(5000) });
    const [text] = bodyElements(out);
    expect(text.text!.length).toBeLessThanOrEqual(900);
  });

  it("never leaves a lone surrogate when the cap cuts an astral char in half", () => {
    // 899 ASCII chars then an emoji: the 900-char slice lands mid-pair.
    const out = render({ title: "t", detail: "x".repeat(899) + "🎉end" });
    const [text] = bodyElements(out);
    expect(text.text!.length).toBe(899);
    expect(text.text!).not.toMatch(/[\uD800-\uDBFF]$/u);
  });
});

describe("threadIncludesBot (participation, re-derived from history)", () => {
  it("true when the bot posted in the thread", () => {
    expect(
      threadIncludesBot(
        [
          { user: "U1", text: "q" },
          { user: BOT, text: "a" },
        ],
        BOT,
      ),
    ).toBe(true);
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
  // Regression (2026-08-29, live, raw event text): the plugin's footer arrives
  // on the SAME line as the command — `<@BOT> friction report *Sent using*
  // <@U0BJJMDUCKY>` — so a line-anchored regex never matched and `*Sent`
  // reached the parser (`Unknown option \`*Sent\``). `repo list` had masked
  // this for months because it ignores trailing text.
  it("drops a same-line trailing footer (the shape Slack actually delivers)", () => {
    expect(stripMention(`<@${BOT}> friction report *Sent using* <@U0BJJMDUCKY>`, BOT)).toBe("friction report");
    expect(
      stripMention(`<@${BOT}> repo onboard acme/api test="npm test" *Sent using* <@U0BJJMDUCKY|Claude>`, BOT),
    ).toBe('repo onboard acme/api test="npm test"');
    // Still anchored to the END: the phrase mid-text is the user's own words.
    expect(stripMention(`<@${BOT}> why does *Sent using* <@U0BJJMDUCKY> appear in my messages?`, BOT)).toBe(
      "why does *Sent using* <@U0BJJMDUCKY> appear in my messages?",
    );
  });

  it("drops the footer when a bracketed sender attribution follows the mention", () => {
    expect(
      stripMention(`<@${BOT}> friction report\n*Sent using* <@U0BJJMDUCKY|Claude> [justin <justin@coreplane.ai>]`, BOT),
    ).toBe("friction report");
    expect(stripMention(`<@${BOT}> repo list\nSent using <@U0BJJMDUCKY> [Justin Helmer]`, BOT)).toBe("repo list");
    // Attribution text is never treated as the footer on its own.
    expect(stripMention(`<@${BOT}> hello [justin <justin@coreplane.ai>]`, BOT)).toBe(
      "hello [justin <justin@coreplane.ai>]",
    );
  });

  it("drops a trailing '*Sent using* <@APP|Name>' footer line", () => {
    expect(
      stripMention(`<@${BOT}> repo onboard coreplanelabs/switchboard\n*Sent using* <@U0BJJMDUCKY|Claude>`, BOT),
    ).toBe("repo onboard coreplanelabs/switchboard");
  });

  it("accepts the unbolded and label-less forms and surrounding whitespace", () => {
    expect(stripMention(`<@${BOT}> repo list\n\nSent using <@U0BJJMDUCKY>  `, BOT)).toBe("repo list");
  });

  it("strips only the two real shapes: asymmetric bold is not a footer", () => {
    expect(stripMention(`<@${BOT}> repo list\n*Sent using <@U0BJJMDUCKY|Claude>`, BOT)).toBe(
      "repo list\n*Sent using <@U0BJJMDUCKY|Claude>",
    );
  });

  it("strips stacked footers (a forwarded app message can carry two)", () => {
    expect(
      stripMention(`<@${BOT}> repo list\n*Sent using* <@U0BJJMDUCKY|Claude>\n*Sent using* <@U0BJJMDUCKY|Claude>`, BOT),
    ).toBe("repo list");
  });

  it("a message that is only a mention plus the footer strips to empty", () => {
    expect(stripMention(`<@${BOT}> *Sent using* <@U0BJJMDUCKY|Claude>`, BOT)).toBe("");
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
              user: {
                name: "juser",
                real_name: "Justin Helmer",
                profile: { display_name: "justin", real_name: "Justin Helmer" },
              },
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

// Feature: features/slack-channel.md — a follow-up's thread page is fetched
// once (the bot-in-thread check hands it to history()), and a message's
// attachments download concurrently instead of one after another.
describe("SlackIO.history — thread reuse and concurrent attachment downloads", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ev = { channel: "C1", user: "U1", text: "hi", ts: "3.0", threadTs: "1.0", botUserId: "UBOT" };

  it("uses the thread the handler already fetched instead of calling conversations.replies again", async () => {
    const replies = vi.fn();
    const client = { conversations: { replies } } as unknown as ConstructorParameters<typeof SlackIO>[0];
    const thread = [
      { user: "U1", text: "<@UBOT> first ask", ts: "1.0" },
      { bot_id: "B1", text: "an answer", ts: "2.0" },
      { user: "U1", text: "hi", ts: "3.0" }, // the triggering message — skipped
    ];
    const items = await new SlackIO(client, { ...ev, thread }).history();
    expect(replies).not.toHaveBeenCalled();
    expect(items.map((i) => [i.role, i.text])).toEqual([
      ["user", "first ask"],
      ["assistant", "an answer"],
    ]);
  });

  it("fetches the thread itself when no prefetched page is given (mention path)", async () => {
    const replies = vi.fn(async () => ({ messages: [{ user: "U1", text: "earlier", ts: "1.0" }] }));
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
        throw "string failure";
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
    const { documents, skipped } = await fetchDocuments([textFile("main.ts", "application/octet-stream")], 10);
    expect(skipped).toEqual([]);
    expect(documents).toHaveLength(1);
    expect(documents[0].data).toBe("export const x = 1;\n");
  });

  it("skips images and unsupported types without fetching them", async () => {
    const fetchMock = stubFetch();
    const files = [
      { id: "img", name: "shot.png", mimetype: "image/png", size: 10, url_private_download: "https://x/i" },
      {
        id: "bin",
        name: "app.bin",
        mimetype: "application/octet-stream",
        size: 10,
        url_private_download: "https://x/b",
      },
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
    const files = [{ ...pdf("huge.pdf"), size: 11 * 1024 * 1024 }, pdf("one.pdf"), pdf("two.pdf")];
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
      ".env",
      ".env.local",
      ".env.production",
      "config.env",
      "prod.env",
      "credentials.json",
      "gcp-service-account.json",
      "app-key.json",
      "id_rsa",
      "id_rsa.pub",
      "foo.pem",
      "server.key",
      "cert.p12",
      "cert.pfx",
      ".npmrc",
      ".netrc",
      "db.cfg",
      "app.conf",
      "settings.ini",
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

describe("slackPermalink (the Request block's link back to the thread)", () => {
  it("builds Slack's own permalink shape from the team URL, channel and ts", () => {
    expect(slackPermalink("https://acme.slack.com/", "C0BQS7KPJHK", "1788045076.113369", "1788045076.113369")).toBe(
      "https://acme.slack.com/archives/C0BQS7KPJHK/p1788045076113369",
    );
  });
  it("adds the thread qualifier for a reply inside a thread", () => {
    expect(slackPermalink("https://acme.slack.com", "C1", "1788045099.000100", "1788045076.113369")).toBe(
      "https://acme.slack.com/archives/C1/p1788045099000100?thread_ts=1788045076.113369&cid=C1",
    );
  });
});

// Feature: features/slack-channel.md item 7 — a message the reconnect catch-up
// replays tells the thread how late the pickup was (2026-08-30: PR #300's
// re-review sat 7.5 min with no 👀 through a deploy drain; the caller could not
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

// Feature: features/slack-channel.md item 9 (#346) — Slack re-delivers an
// event whose original delivery was never acked (a deploy blackout), and the
// live path used to run it unconditionally. Live 2026-08-30: a mention posted
// at 20:25:51Z into a drain was answered by the reconnect catch-up at 20:28,
// then RE-delivered at 20:31:57Z (+6 min) and run again in full — a duplicate
// run and a duplicate LGTM review on the PR. Both deploy-window mentions that
// evening double-ran the same way.
describe("dedupeDelivery (redelivery guard, #346)", () => {
  /** In-memory handled-set standing in for the module's process-wide one. */
  function memState(seed: string[] = []) {
    const set = new Set(seed);
    return {
      was: (c: string, ts: string) => set.has(`${c}:${ts}`),
      mark: (c: string, ts: string) => void set.add(`${c}:${ts}`),
      set,
    };
  }
  /** A client whose conversations.replies answers one canned thread (or throws). */
  function repliesClient(thread: Array<{ ts: string; bot_id?: string; user?: string }> | Error) {
    const calls: Array<{ channel: string; ts: string }> = [];
    return {
      calls,
      conversations: {
        history: async () => ({}),
        replies: async (args: { channel: string; ts: string }) => {
          calls.push({ channel: args.channel, ts: args.ts });
          if (thread instanceof Error) throw thread;
          return { messages: thread };
        },
      },
    };
  }

  // The incident's own timestamps.
  const TS = "1788121551.504339"; // mention posted 2026-08-30T20:25:51Z
  const REDELIVERY_MS = Date.UTC(2026, 7, 30, 20, 31, 57, 633); // the ghost [run]
  const ev = { channel: "C0BQS7KPJHK", ts: TS, threadTs: TS, botUserId: BOT } as const;

  it("same-process redelivery (the incident: catch-up answered it at 20:28, Slack re-delivered at +6 min) → dropped without any API call", async () => {
    const state = memState([`C0BQS7KPJHK:${TS}`]); // catch-up's handle() claimed it
    const client = repliesClient(new Error("must not be called"));
    await expect(dedupeDelivery(client, ev, REDELIVERY_MS, state)).resolves.toBe(
      "already handled in this process (a Slack redelivery)",
    );
    expect(client.calls).toHaveLength(0);
  });

  it("cross-process redelivery (the first handling died with the old container): stale + bot already replied in the thread → dropped after one replies fetch", async () => {
    const state = memState(); // fresh process: nothing handled here
    const client = repliesClient([
      { ts: TS, user: "U1" }, // the mention
      { ts: "1788121677.778409", bot_id: "B1" }, // ⏱ late-pickup note
      { ts: "1788121678.289369", bot_id: "B1" }, // status card
      { ts: "1788121716.609039", bot_id: "B1" }, // the answer
    ]);
    const drop = await dedupeDelivery(client, ev, REDELIVERY_MS, state);
    expect(drop).toMatch(
      /^already answered in its thread \(delivered 36\ds after it was posted — a Slack redelivery\)$/,
    );
    expect(client.calls).toEqual([{ channel: "C0BQS7KPJHK", ts: TS }]);
    // The pair is claimed either way — a third delivery is dropped by check 1.
    expect(state.was("C0BQS7KPJHK", TS)).toBe(true);
  });

  it("stale but UNANSWERED (👀-then-killed, #317's shape) → runs; bot messages before it don't count", async () => {
    const state = memState();
    const client = repliesClient([
      { ts: "1788121000.000000", bot_id: "B1" }, // bot spoke earlier in the thread
      { ts: TS, user: "U1" },
    ]);
    await expect(dedupeDelivery(client, ev, REDELIVERY_MS, state)).resolves.toBeNull();
  });

  it("fresh delivery (younger than STALE_DELIVERY_MS) → runs with no fetch; the second delivery of the same ts is then dropped", async () => {
    const state = memState();
    const client = repliesClient(new Error("must not be called"));
    const freshNow = Number(TS) * 1000 + STALE_DELIVERY_MS - 1;
    await expect(dedupeDelivery(client, ev, freshNow, state)).resolves.toBeNull();
    await expect(dedupeDelivery(client, ev, freshNow, state)).resolves.toBe(
      "already handled in this process (a Slack redelivery)",
    );
    expect(client.calls).toHaveLength(0);
  });

  it("fail-open: an unfetchable thread runs the event (a lost request is worse than a duplicate)", async () => {
    const state = memState();
    const client = repliesClient(new Error("ratelimited"));
    await expect(dedupeDelivery(client, ev, REDELIVERY_MS, state)).resolves.toBeNull();
    expect(client.calls).toHaveLength(1);
  });

  it("no botUserId → no Slack check (cannot judge authorship); a malformed ts never fetches", async () => {
    const state = memState();
    const client = repliesClient(new Error("must not be called"));
    await expect(dedupeDelivery(client, { ...ev, botUserId: undefined }, REDELIVERY_MS, state)).resolves.toBeNull();
    await expect(
      dedupeDelivery(client, { ...ev, ts: "not-a-ts", threadTs: "not-a-ts" }, REDELIVERY_MS, state),
    ).resolves.toBeNull();
    expect(client.calls).toHaveLength(0);
  });

  it("a catch-up replay skips both checks — the scan already judged it against Slack state — but still claims the pair", async () => {
    const state = memState([`C0BQS7KPJHK:${TS}`]);
    const client = repliesClient(new Error("must not be called"));
    await expect(dedupeDelivery(client, { ...ev, caughtUp: true }, REDELIVERY_MS, state)).resolves.toBeNull();
    expect(client.calls).toHaveLength(0);
    expect(state.was("C0BQS7KPJHK", TS)).toBe(true);
  });
});

describe("SlackIO.attach (features/slack-channel.md item 10)", () => {
  const ev = { channel: "C1", user: "U1", text: "hi", ts: "3.0", threadTs: "1.0", botUserId: "UBOT" };
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
