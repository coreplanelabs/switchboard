import { encodeMrkdwnUrl, escapeMrkdwn } from "./slackEscape.js";

// Standard Markdown -> Slack mrkdwn. Agents write normal Markdown (the
// contract for every channel); each adapter converts to its native dialect.
// Slack differences handled: bold, italic, strikethrough, headers, links,
// bullets. Code fences and inline code are preserved untouched.

export function mdToMrkdwn(md: string): string {
  // Split out fenced code blocks first, then inline code, so no transform
  // ever touches code content.
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((seg) => (seg.startsWith("```") ? seg : convertOutsideInlineCode(seg)))
    .join("");
}

function convertOutsideInlineCode(text: string): string {
  // Protect inline code with placeholders instead of splitting: formatting
  // spans that CONTAIN inline code (e.g. **bold with \`code\`**) must still
  // convert, which splitting made impossible (the ** halves landed in
  // different segments).
  const spans: string[] = [];
  const protectedText = text.replace(/`[^`\n]*`/g, (m) => {
    spans.push(m);
    return `\uE000${spans.length - 1}\uE001`;
  });
  const converted = convert(protectedText);
  return converted.replace(/\uE000(\d+)\uE001/g, (_, i) => spans[Number(i)]);
}

function convert(text: string): string {
  let out = text;
  // images can't render inline; keep the bare URL
  out = out.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, "$1");
  // links: [text](url) -> <url|text>. Escape the label and percent-encode the
  // url so a link can't forge or break out of the <url|label> structure (e.g. a
  // label of `x> <!channel` injecting a broadcast). Same helpers as SlackFormatter.
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, text: string, url: string) => `<${encodeMrkdwnUrl(url)}|${escapeMrkdwn(text)}>`,
  );
  // ORDER MATTERS below: italic (single *) runs first so the bold and header
  // passes — which *produce* single-asterisk output — can't be re-eaten by it.
  out = out.replace(/(^|[\s(])\*(?!\*)([^*\s][^*]*?)\*(?!\*)(?=[\s).,;:!?]|$)/gm, "$1_$2_");
  // bold-italic ***x*** -> _*x*_
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, "_*$1*_");
  // bold **x** -> *x*
  out = out.replace(/\*\*([^*]+)\*\*/g, "*$1*");
  // headers -> bold line (Slack has no headers)
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
  // strikethrough ~~x~~ -> ~x~
  out = out.replace(/~~([^~]+)~~/g, "~$1~");
  // markdown bullets render as plain hyphens in Slack; use the bullet glyph
  out = out.replace(/^(\s*)- /gm, "$1• ");
  return out;
}
