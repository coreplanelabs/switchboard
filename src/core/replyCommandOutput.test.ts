import { describe, expect, it, vi } from "vitest";
import type { ParsedChatCommand } from "./commandChat.js";
import { LONG_COMMAND_REPLY_CHARS, replyCommandOutput } from "./dispatcher.js";
import type { ChannelIO } from "./types.js";

// features/command-registry.md item 27 / mcp-tools.md item 19: a command reply
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
