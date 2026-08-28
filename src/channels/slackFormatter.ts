import type {
  ChannelFormatter,
  MessageBlock,
  StatusState,
  StructuredMessage,
} from "../core/structuredMessage.js";

// Slack's ChannelFormatter: structured message -> Slack mrkdwn. Slack-specific,
// so it lives in src/channels/ (AGENTS.md invariant 1: no platform formatting in
// the core). The output is mrkdwn text posted verbatim — SlackIO.sendFormatted
// must NOT run it back through mdToMrkdwn (that would double-convert).
//
// This owns the "guaranteed-correct Slack syntax" the model used to guess:
// headings have no Slack equivalent so they become *bold* lines; bullets use the
// • glyph; links are <url|text>; code is a bare fence (Slack fences take no
// language tag — a `bash` tag would render as literal text inside the block).

const SLACK_STATUS_GLYPH: Record<StatusState, string> = {
  ok: "✅",
  warn: "⚠️",
  error: "❌",
  info: "ℹ️",
};

export class SlackFormatter implements ChannelFormatter {
  readonly name = "slack";

  format(message: StructuredMessage): string {
    return message.blocks.map(renderSlackBlock).join("\n\n");
  }
}

function renderSlackBlock(block: MessageBlock): string {
  switch (block.type) {
    case "heading":
      return `*${block.text}*`;
    case "paragraph":
      return block.text;
    case "bullets":
      return block.items.map((item) => `• ${item}`).join("\n");
    case "code":
      // Slack code fences take no language tag; drop it so it isn't shown as text.
      return "```\n" + block.code + "\n```";
    case "link":
      return block.text ? `<${block.url}|${block.text}>` : `<${block.url}>`;
    case "status":
      return `${SLACK_STATUS_GLYPH[block.state]} ${block.text}`;
  }
}
