import { afterEach, describe, expect, it } from "vitest";
import { ROUTED_CARD_FOOTER } from "../../core/dispatch/route.js";
import {
  closeReclaimedCards,
  isLiveCard,
  markForeignLiveCards,
  ownsLiveCard,
  refreshForeignLiveCards,
  render,
  setForeignLiveCardsSource,
} from "./statusCard.js";

// Feature: docs/reference/specs/run-history.md item 36 — the orphan sweep's question is
// "live anywhere we know of", not "driven here": a card the ledger says another
// generation still holds is not an orphan.
describe("live cards", () => {
  afterEach(() => markForeignLiveCards([]));

  it("a card marked live on the ledger elsewhere is live to the sweep though this process does not drive it; re-marking replaces the set", () => {
    expect(ownsLiveCard("C1", "1.1")).toBe(false);
    expect(isLiveCard("C1", "1.1")).toBe(false);
    markForeignLiveCards([{ channel: "C1", ts: "1.1" }]);
    expect(ownsLiveCard("C1", "1.1")).toBe(false); // not ours
    expect(isLiveCard("C1", "1.1")).toBe(true); // but live
    expect(isLiveCard("C1", "1.2")).toBe(false);
    markForeignLiveCards([{ channel: "C2", ts: "9.9" }]);
    expect(isLiveCard("C1", "1.1")).toBe(false); // the boot's list replaces, never accumulates
    expect(isLiveCard("C2", "9.9")).toBe(true);
  });

  it("the refresh asks the source (the ledger's live rows) each time, so a generation that died since loses its hold; a failed refresh keeps the previous set and warns", async () => {
    let rows = [{ channel: "C1", ts: "1.1" }];
    let fail = false;
    setForeignLiveCardsSource(async () => {
      if (fail) throw new Error("HTTP 503");
      return rows;
    });
    const warnings: string[] = [];
    await refreshForeignLiveCards((w) => warnings.push(w));
    expect(isLiveCard("C1", "1.1")).toBe(true);
    rows = []; // the other generation's lease expired
    await refreshForeignLiveCards((w) => warnings.push(w));
    expect(isLiveCard("C1", "1.1")).toBe(false);
    rows = [{ channel: "C3", ts: "3.3" }];
    await refreshForeignLiveCards((w) => warnings.push(w));
    fail = true;
    await refreshForeignLiveCards((w) => warnings.push(w));
    expect(isLiveCard("C3", "3.3")).toBe(true); // kept: a blip never widens the sweep
    expect(warnings).toEqual(["[slack] foreign live cards not refreshed: HTTP 503"]);
    setForeignLiveCardsSource(undefined);
    await refreshForeignLiveCards((w) => warnings.push(w)); // no source: a no-op
    expect(isLiveCard("C3", "3.3")).toBe(true);
  });

  it("closeReclaimedCards closes the cards of runs that had replied with how they ended and an interrupted run's card with its closure note, skips runs without a card, and isolates a failed edit", async () => {
    const updates: { channel: string; ts: string; text: string }[] = [];
    const client = {
      chat: {
        update: async (args: { channel: string; ts: string; text: string; blocks: object[] }) => {
          if (args.ts === "fail.1") throw new Error("message_not_found");
          updates.push({ channel: args.channel, ts: args.ts, text: args.text });
          return {};
        },
      },
    };
    const warnings: string[] = [];
    const closed = await closeReclaimedCards(
      client,
      [
        { status: "completed", agent: "review", card: { channel: "C1", ts: "a.1" } },
        { status: "stopped_soft", agent: "coding", card: { channel: "C1", ts: "b.1" } },
        {
          status: "interrupted",
          agent: "ship",
          card: { channel: "C1", ts: "c.1" },
          note: "⚠️ re-issue with the PR URL",
        },
        { status: "completed", agent: "general", card: null },
        { status: "failed", card: { channel: "C1", ts: "fail.1" } },
      ],
      (w) => warnings.push(w),
    );
    expect(closed).toBe(3);
    expect(updates.map((u) => [u.ts, u.text])).toEqual([
      ["a.1", "✅ review · completed"],
      ["b.1", "⏹ coding · stopped soft"],
      ["c.1", "❌ ship · interrupted"],
    ]);
    expect(warnings).toEqual(["[slack] reclaimed card C1:fail.1 not closed: message_not_found"]);
  });

  it("a routed run's reclaimed close — interrupted or replied — ends its detail with the override footer, exactly as the run's own close would (routing-and-config item 21); an unrouted one does not", async () => {
    const blocks: Record<string, string> = {};
    const client = {
      chat: {
        update: async (args: { channel: string; ts: string; text: string; blocks: object[] }) => {
          blocks[args.ts] = JSON.stringify(args.blocks);
          return {};
        },
      },
    };
    await closeReclaimedCards(client, [
      { status: "interrupted", agent: "coding", card: { channel: "C1", ts: "r.1" }, routed: true },
      { status: "completed", agent: "review", card: { channel: "C1", ts: "r.2" }, routed: true },
      { status: "interrupted", agent: "coding", card: { channel: "C1", ts: "u.1" } },
    ]);
    expect(blocks["r.1"]).toContain(`could not be resumed.\\n${ROUTED_CARD_FOOTER}`);
    expect(blocks["r.2"]).toContain(`its record is complete.\\n${ROUTED_CARD_FOOTER}`);
    expect(blocks["u.1"]).not.toContain(ROUTED_CARD_FOOTER);
  });
});

// Feature: docs/reference/specs/run-visibility.md item 2 — the status/progress card is a context
// headline (mrkdwn, escaped) over a rich_text body. The body must be rich_text,
// never a section: Slack folds a section's mrkdwn behind "Show more" at five
// rendered lines and re-renders a folded card expanded-then-collapsed on every
// edit, so a section-bodied card makes the whole thread jump on each heartbeat
// (measured against the live client; see the render() doc comment). rich_text `text`
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

  // run-visibility item 2: the activity is typed, so a command draws as a code
  // block — a rich_text_preformatted element beside the section, never a
  // command re-parsed out of the detail text.
  describe("activity", () => {
    const command = "cd /workspace/app && python3 - <<'EOF'\np='docs/x.md'\ns=open(p).read()\nEOF";

    it("a command activity draws as a caption in the section and the command verbatim in a rich_text_preformatted element", () => {
      const out = render({
        title: "run",
        link: { url: "https://bot.example/runs/abc?t=x", label: "Live run" },
        detail: "✓ a\n✱ b",
        activity: { kind: "command", tool: "bash", command },
      });
      expect(body(out).elements).toEqual([
        {
          type: "rich_text_section",
          elements: [
            { type: "link", url: "https://bot.example/runs/abc?t=x", text: "Live run" },
            { type: "text", text: "\n✓ a\n✱ b" },
            { type: "text", text: "\n→ bash" },
          ],
        },
        { type: "rich_text_preformatted", elements: [{ type: "text", text: command }] },
      ]);
    });

    it("a line activity is appended to the section text like any detail line", () => {
      const out = render({ title: "run", detail: "✓ a", activity: { kind: "line", text: "✓ bash: ok" } });
      expect(body(out).elements).toEqual([
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: "✓ a" },
            { type: "text", text: "\n✓ bash: ok" },
          ],
        },
      ]);
    });

    it("a command activity alone (no link, no detail) still gets its caption and code block", () => {
      const out = render({ title: "run", activity: { kind: "command", tool: "bash", command: "ls" } });
      expect(body(out).elements).toEqual([
        { type: "rich_text_section", elements: [{ type: "text", text: "→ bash" }] },
        { type: "rich_text_preformatted", elements: [{ type: "text", text: "ls" }] },
      ]);
    });

    it("a long script is cut by structure — the first lines kept, the rest counted — so a heredoc never balloons the card", () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      const out = render({ title: "run", activity: { kind: "command", tool: "bash", command: lines.join("\n") } });
      const pre = body(out).elements[1]!;
      expect(pre.type).toBe("rich_text_preformatted");
      expect(pre.elements[0]!.text).toBe([...lines.slice(0, 6), "… +14 lines"].join("\n"));
    });

    it("a single overlong line is capped by characters without leaving a lone surrogate", () => {
      const out = render({
        title: "run",
        activity: { kind: "command", tool: "bash", command: "x".repeat(599) + "🎉" + "y".repeat(100) },
      });
      const text = body(out).elements[1]!.elements[0]!.text!;
      expect(text.length).toBeLessThanOrEqual(600);
      expect(text).not.toMatch(/[\uD800-\uDBFF]$/u);
    });
  });
});
