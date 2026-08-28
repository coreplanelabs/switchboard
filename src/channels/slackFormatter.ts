import type {
  ChannelFormatter,
  MessageBlock,
  StatusState,
  StructuredMessage,
} from "../core/structuredMessage.js";
import { encodeMrkdwnUrl, escapeMrkdwn, neutralizeCodeFence } from "./slackEscape.js";

// Slack's ChannelFormatter: structured message -> Slack mrkdwn. Slack-specific,
// so it lives in src/channels/ (AGENTS.md invariant 1: no platform formatting in
// the core). The output is mrkdwn text posted verbatim — SlackIO.sendFormatted
// must NOT run it back through mdToMrkdwn (that would double-convert).
//
// This owns the "guaranteed-correct Slack syntax" the model used to guess:
// headings have no Slack equivalent so they become *bold* lines; bullets use the
// • glyph; links are <url|text>; code is a bare fence (Slack fences take no
// language tag — a `bash` tag would render as literal text inside the block).
//
// Every field carrying record content is escaped before it lands in mrkdwn
// structural syntax (see slackEscape.ts): text fields via escapeMrkdwn (so a
// record can't inject <!channel>, <@U…>, or a forged <url|label>), the link URL
// via encodeMrkdwnUrl (percent-encode, not HTML-escape — HTML-escaping breaks the
// address), and code via neutralizeCodeFence (so embedded ``` can't close early).

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
      return `*${escapeMrkdwn(block.text)}*`;
    case "paragraph":
      return escapeMrkdwn(block.text);
    case "bullets":
      return block.items.map((item) => `• ${escapeMrkdwn(item)}`).join("\n");
    case "code":
      // Slack code fences take no language tag; drop it so it isn't shown as text.
      return "```\n" + neutralizeCodeFence(block.code) + "\n```";
    case "link": {
      const url = encodeMrkdwnUrl(block.url);
      return block.text ? `<${url}|${escapeMrkdwn(block.text)}>` : `<${url}>`;
    }
    case "status":
      return `${SLACK_STATUS_GLYPH[block.state]} ${escapeMrkdwn(block.text)}`;
  }
}
