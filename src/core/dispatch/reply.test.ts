import { describe, expect, it, vi } from "vitest";
import type { ParsedChatCommand } from "../commandChat.js";
import { attachmentSuffix, composeRunLabel, LONG_COMMAND_REPLY_CHARS, replyCommandOutput } from "./reply.js";
import type { ChannelIO } from "../types.js";

// docs/reference/specs/command-registry.md item 27 / mcp-tools.md item 19: a command reply
// longer than one chat message goes out as an attachment where the channel
// has one — lead line as the message, the whole text as `<group>-<verb>.md`,
// converted from the chat dialect to CommonMark (`toMarkdownDocument`).

const invoke: ParsedChatCommand = { kind: "invoke", id: "mcp.show", input: { args: ["vanta"], options: {} } };
const help: ParsedChatCommand = { kind: "reply", text: "usage…" };

function io(withAttach: boolean) {
  const reply = vi.fn(async (_text: string) => {});
  const attach = vi.fn(async (_file: { name: string; text: string; lead: string }) => {});
  const base: ChannelIO = {
    reply,
    status: async () => ({ update: async () => {}, done: async () => {} }) as never,
    history: async () => [],
  };
  return { io: withAttach ? { ...base, attach } : base, reply, attach };
}

describe("replyCommandOutput", () => {
  const long = `• \`vanta\` (user) ✅ connected — https://mcp.vanta.com/mcp\nTools (100):\n${Array.from({ length: 100 }, (_, i) => `  - \`tool_${i}\` — ${"x".repeat(80)}`).join("\n")}`;

  it("a long reply on a channel with attach: the first line leads, the whole text is the file as a Markdown document, named after the command", async () => {
    const { io: channel, reply, attach } = io(true);
    await replyCommandOutput(channel, invoke, long);
    expect(reply).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledTimes(1);
    const file = attach.mock.calls[0][0];
    expect(file.name).toBe("mcp-show.md");
    // `•` -> `-`, one line per fact kept by hard breaks; nothing dropped
    expect(
      file.text.startsWith(
        "- `vanta` (user) ✅ connected — https://mcp.vanta.com/mcp  \nTools (100):  \n  - `tool_0` — ",
      ),
    ).toBe(true);
    expect(file.text.split("\n")).toHaveLength(long.split("\n").length);
    expect(file.text).toContain("`tool_99`");
    expect(file.lead.startsWith("• `vanta` (user) ✅ connected — https://mcp.vanta.com/mcp\n")).toBe(true);
    expect(file.lead).toMatch(/full output attached — [\d,]+ chars/);
    expect(file.lead).not.toContain("tool_0");
  });

  it("a short reply is a plain reply even with attach; a long one without attach is a plain reply; a help reply attaches as `command.md`", async () => {
    const short = io(true);
    await replyCommandOutput(short.io, invoke, "x".repeat(LONG_COMMAND_REPLY_CHARS));
    expect(short.reply).toHaveBeenCalledWith("x".repeat(LONG_COMMAND_REPLY_CHARS));
    expect(short.attach).not.toHaveBeenCalled();
    const plain = io(false);
    await replyCommandOutput(plain.io, invoke, long);
    expect(plain.reply).toHaveBeenCalledWith(long);
    const usage = io(true);
    await replyCommandOutput(usage.io, help, `usage\n${"y".repeat(LONG_COMMAND_REPLY_CHARS)}`);
    expect(usage.attach.mock.calls[0][0].name).toBe("command.md");
  });
});

// Feature: docs/reference/specs/live-view.md — the human-readable run label the dispatcher
// stamps on each run for the Access-gated /runs index. `composeRunLabel` is the
// pure, channel-agnostic composer: agent-first, repo-identified for repo runs,
// channel+user (names or stripped ids) for chat runs, always with a short quoted
// snippet of the request, capped to a sane length.
// Feature: docs/reference/specs/live-view.md item 12 — the one-line attachment note the
// dispatcher appends to the `input` event's text.
describe("attachmentSuffix", () => {
  const img = { name: "a.png", mediaType: "image/png" as const, data: "" };
  const doc = { name: "a.txt", mediaType: "text/plain" as const, data: "" };
  it("is empty with no attachments", () => {
    expect(attachmentSuffix(undefined, undefined)).toBe("");
    expect(attachmentSuffix([], [])).toBe("");
  });
  it("counts images and documents with singular/plural", () => {
    expect(attachmentSuffix([img], undefined)).toBe("[+1 image]");
    expect(attachmentSuffix([img, img], [doc])).toBe("[+2 images, 1 document]");
    expect(attachmentSuffix(undefined, [doc, doc])).toBe("[+2 documents]");
  });
});

describe("composeRunLabel", () => {
  const base = { agent: "review", channelId: "slack:C0BQ", userId: "slack:U123", text: "" };

  it("a repo run is repo-identified: agent · owner/repo · snippet", () => {
    expect(composeRunLabel({ ...base, agent: "coding", repo: "owner/repo", text: "fix the login bug" })).toBe(
      'coding · owner/repo · "fix the login bug"',
    );
  });

  it("a chat run shows channel + user display names when available", () => {
    expect(
      composeRunLabel({
        ...base,
        channelName: "general",
        userName: "alice",
        text: "run these with bash",
      }),
    ).toBe('review · #general · alice · "run these with bash"');
  });

  it("falls back to the raw ids (slack: prefix stripped) when names are absent", () => {
    expect(composeRunLabel({ ...base, text: "hello" })).toBe('review · #C0BQ · U123 · "hello"');
  });

  it("uses the channel name but the stripped user id when only one name resolved", () => {
    expect(composeRunLabel({ ...base, channelName: "general", text: "hi" })).toBe('review · #general · U123 · "hi"');
  });

  it("is channel-agnostic: http/mcp ids (no names) strip their platform prefix", () => {
    expect(composeRunLabel({ agent: "review", channelId: "http:svc", userId: "http:alice", text: "go" })).toBe(
      'review · #svc · alice · "go"',
    );
  });

  it("empty (or whitespace-only) text yields no snippet segment", () => {
    expect(composeRunLabel({ ...base, repo: "owner/repo", text: "   " })).toBe("review · owner/repo");
    expect(composeRunLabel({ ...base, channelName: "c", userName: "u", text: "" })).toBe("review · #c · u");
  });

  it("collapses internal whitespace in the snippet", () => {
    expect(composeRunLabel({ ...base, channelName: "c", userName: "u", text: "  do   this\n\tnow  " })).toBe(
      'review · #c · u · "do this now"',
    );
  });

  it("prefers the first sentence when it ends within the budget", () => {
    expect(composeRunLabel({ ...base, repo: "owner/repo", text: "Deploy the app. Then celebrate loudly." })).toBe(
      'review · owner/repo · "Deploy the app…"',
    );
  });

  it("truncates a long snippet at a word boundary with an ellipsis", () => {
    const label = composeRunLabel({
      ...base,
      channelName: "c",
      userName: "u",
      text: "please run all of the integration tests and then report the results back to me thanks, and while you are at it check the deploy logs too",
    });
    expect(label.startsWith('review · #c · u · "please run all of the ')).toBe(true);
    expect(label.length).toBeLessThan(140); // ~100 chars of snippet (live-view item 21): a laptop-width row, not half of one
    expect(label.endsWith('…"')).toBe(true);
    expect(label).not.toContain("  "); // no doubled whitespace leaks through
    expect(label).not.toMatch(/ …"$/); // cut on a word boundary — no trailing space before the ellipsis
  });

  it("unwraps Slack angle-links and compacts GitHub PR/issue URLs to owner/repo#N", () => {
    expect(
      composeRunLabel({
        ...base,
        repo: "acme/api",
        text: "<https://github.com/acme/api/pull/41|https://github.com/acme/api/pull/41> — lead with a verdict",
      }),
    ).toBe('review · acme/api · "acme/api#41 — lead with a verdict"');
    expect(composeRunLabel({ ...base, repo: "o/r", text: "<https://github.com/o/r/issues/7>" })).toBe(
      'review · o/r · "o/r#7"',
    );
    expect(composeRunLabel({ ...base, repo: "o/r", text: "fix https://github.com/o/r/pull/12/files please" })).toBe(
      'review · o/r · "fix o/r#12 please"',
    );
  });

  it("a Slack link with a human label shows the label, and other URLs drop their scheme", () => {
    expect(composeRunLabel({ ...base, repo: "o/r", text: "see <https://example.com/docs/a|the docs>" })).toBe(
      'review · o/r · "see the docs"',
    );
    expect(composeRunLabel({ ...base, repo: "o/r", text: "read https://www.example.com/x/y" })).toBe(
      'review · o/r · "read example.com/x/y"',
    );
  });

  it("a snippet never ends in a severed URL", () => {
    const label = composeRunLabel({
      ...base,
      repo: "o/r",
      text: "please look at https://example.com/a/very/long/path/that/keeps/going/and/going/forever/more/and/more/and/more/and/more/still",
    });
    expect(label).not.toMatch(/https?:/);
    expect(label.endsWith('…"')).toBe(true);
  });

  it("a dot at the snippet budget edge inside a token is not a sentence end", () => {
    // 100 chars of prose, then a hostname whose first '.' lands exactly at index 100 (the snippet budget).
    const lead = "x".repeat(96) + " api";
    expect(lead.length).toBe(100);
    const label = composeRunLabel({ ...base, repo: "o/r", text: `${lead}.example.com is down please look` });
    expect(label).not.toContain('api…"');
    expect(label.startsWith(`review · o/r · "${"x".repeat(96)}`)).toBe(true);
  });

  it("trailing punctuation after a URL stays in the prose", () => {
    expect(composeRunLabel({ ...base, repo: "o/r", text: "fix https://github.com/o/r/pull/12, then deploy" })).toBe(
      'review · o/r · "fix o/r#12, then deploy"',
    );
    expect(composeRunLabel({ ...base, repo: "o/r", text: "(see https://example.com/a)." })).toBe(
      'review · o/r · "(see example.com/a)."',
    );
  });

  it("Slack user/channel mentions render as their label or a readable stub", () => {
    expect(
      composeRunLabel({ ...base, repo: "o/r", text: "<@U0AAAAAAAAA> review this. Sent using <@U0BBBBBBBBB|Claude>" }),
    ).toBe('review · o/r · "@user review this…"');
    expect(composeRunLabel({ ...base, repo: "o/r", text: "post in <#C0AAAAAAAAA|general> and <#C0BQ>" })).toBe(
      'review · o/r · "post in #general and #channel"',
    );
    expect(composeRunLabel({ ...base, repo: "o/r", text: "cc <!here> and <!subteam^S123|@eng>" })).toBe(
      'review · o/r · "cc @here and @eng"',
    );
  });

  it("caps the overall label to a sane length", () => {
    const label = composeRunLabel({
      ...base,
      channelName: "c".repeat(200),
      userName: "u".repeat(200),
      text: "hello there",
    });
    expect(label.length).toBeLessThanOrEqual(160);
    expect(label.endsWith("…")).toBe(true);
  });
});
