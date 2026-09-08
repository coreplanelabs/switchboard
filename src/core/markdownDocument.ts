/**
 * Command output as a CommonMark document.
 *
 * Commands render their reply once, in the chat dialect every channel reads
 * (`*bold*`, `•` bullets, backticks, one line per fact): the Slack adapter
 * converts it to mrkdwn (`src/channels/mrkdwn.ts`), the CLI prints it as is.
 * A reply too long for one message is attached as a `.md` file instead
 * (`replyCommandOutput`), and Slack renders that as CommonMark — where the
 * same text says something else: `*x*` is italic, `•` is prose, and a bare
 * newline joins two lines into one paragraph (a bullet's follow-up line becomes
 * part of the bullet). This is the dialect translation for that document: the
 * inverse of `mdToMrkdwn`, with the same rule that code content is never touched.
 */

// Private-use placeholders for stashed inline code (same scheme as mrkdwn.ts).
const CODE_OPEN = "\uE000";
const CODE_CLOSE = "\uE001";

export function toMarkdownDocument(text: string): string {
  // Closed fenced blocks (the split's captures, at the odd indices) are kept
  // verbatim; every other segment is prose and gets both the dialect rewrites
  // and the hard breaks — so an unclosed fence is prose to both passes, never a
  // fence to one and prose to the other.
  return text
    .replace(/[\uE000\uE001]/g, "")
    .split(/(```[\s\S]*?```)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : hardBreaks(convertProse(seg))))
    .join("");
}

function convertProse(text: string): string {
  const spans: string[] = [];
  const protectedText = text.replace(/`[^`\n]*`/g, (m) => {
    spans.push(m);
    return `${CODE_OPEN}${spans.length - 1}${CODE_CLOSE}`;
  });
  let out = protectedText;
  // `*x*` (chat-dialect bold) -> `**x**`. `**x**` / `***x***` already mean
  // bold / bold-italic in CommonMark and are left alone: the run must not be
  // adjacent to another asterisk. A spaced-out `*` (`5 * 3`) is arithmetic.
  out = out.replace(/(?<!\*)\*([^*\s](?:[^*\n]*[^*\s])?)\*(?!\*)/g, "**$1**");
  // `• item` -> `- item`, at any indentation (nested bullets stay nested).
  out = out.replace(/^([ \t]*)• /gm, "$1- ");
  return out.replace(new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, "g"), (_, i) => spans[Number(i)]);
}

/** Two trailing spaces on every non-blank line that another non-blank line
 *  follows: CommonMark's hard line break, so the reply keeps one line per fact
 *  instead of flowing a run of lines into one paragraph. Blank lines and the
 *  last line of a segment are left alone (a fence starts its own block, so the
 *  line before one needs no break). */
function hardBreaks(text: string): string {
  const lines = text.split("\n");
  return lines
    .map((line, i) => {
      const next = lines[i + 1];
      if (line.trim() === "" || next === undefined || next.trim() === "") return line;
      return `${line}  `;
    })
    .join("\n");
}
