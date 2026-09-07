import { encodeMrkdwnUrl, escapeMrkdwn } from "./slackEscape.js";

// Standard Markdown -> Slack mrkdwn. Agents write normal Markdown (the
// contract for every channel); each adapter converts to its native dialect.
// Slack differences handled: bold, strikethrough, headers, links, bullets,
// blockquotes. Asterisk emphasis (`*x*` and `**x**`) always renders bold —
// deterministic whichever dialect the model wrote; `_x_` is the one italic
// form. Code fences and inline code keep their markers but their content is
// escaped like all other text.
//
// Injection safety: mrkdwn gives `&`, `<`, `>` special meaning — `<…>` is
// Slack's link/mention/broadcast syntax (`<url|label>`, `<@U…>`, `<!channel>`).
// The agent's text (which can quote tool output or a prompt injection) is prose
// we don't control, so every character of it is escaped. Only the structural
// syntax mdToMrkdwn *itself* produces — generated `<url|label>` links, image
// URLs, blockquote markers — is exempted, by stashing it before the escape pass
// and restoring it after, so it is never double-escaped or corrupted.

// Private-use delimiters for placeholders. Two disjoint pairs so the inline-code
// and structural restores never collide, and so the escape pass (which only
// touches `&`/`<`/`>`) and the marker passes leave placeholders untouched.
const CODE_OPEN = "\uE000";
const CODE_CLOSE = "\uE001";
const STRUCT_OPEN = "\uE002";
const STRUCT_CLOSE = "\uE003";

export function mdToMrkdwn(md: string): string {
  // Strip the private-use sentinels the placeholder scheme relies on before any
  // stashing happens. These chars have no legitimate meaning in a chat reply, so
  // removing them is harmless — but if agent-controlled input carried them
  // literally they would collide with real placeholders on restore (an
  // out-of-range index throws; a matching index cross-splices unrelated stashed
  // content). Doing it here, at the true raw-input boundary, keeps both the
  // inline-code (CODE_*) and structural (STRUCT_*) placeholders collision-proof.
  const sanitized = md.replace(/[-]/g, "");

  // Split out fenced code blocks first, then inline code, so no formatting
  // transform ever touches code content. The fence markers stay; the content
  // still gets its `&`/`<`/`>` escaped (Slack renders those literally only when
  // escaped, inside code too), so `<!channel>` in a code block is inert.
  return sanitized
    .split(/(```[\s\S]*?```)/g)
    .map((seg) => (seg.startsWith("```") ? escapeMrkdwn(seg) : convertOutsideInlineCode(seg)))
    .join("");
}

function convertOutsideInlineCode(text: string): string {
  // Protect inline code with placeholders instead of splitting: formatting
  // spans that CONTAIN inline code (e.g. **bold with \`code\`**) must still
  // convert, which splitting made impossible (the ** halves landed in
  // different segments). Placeholders carry no `&`/`<`/`>`, so the escape pass
  // in convert() leaves them intact; on restore each span's content is escaped
  // (the markers and backticks kept) so entities inside inline code are inert too.
  const spans: string[] = [];
  const protectedText = text.replace(/`[^`\n]*`/g, (m) => {
    spans.push(m);
    return `${CODE_OPEN}${spans.length - 1}${CODE_CLOSE}`;
  });
  const converted = convert(protectedText);
  return converted.replace(new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, "g"), (_, i) =>
    escapeMrkdwn(spans[Number(i)]),
  );
}

function convert(text: string): string {
  let out = text;

  // Stash the structural syntax this function produces so the prose escape below
  // can't double-escape or corrupt it; restored verbatim at the end.
  const structural: string[] = [];
  const stash = (s: string): string => {
    structural.push(s);
    return `${STRUCT_OPEN}${structural.length - 1}${STRUCT_CLOSE}`;
  };

  // images can't render inline; keep the bare URL. Percent-encode its structural
  // `<`/`>`/`|` (mirroring the link path) so an image url of `<!channel>`/`<@U…>`
  // can't reach Slack as a live broadcast/mention, then stash it so its literal
  // `&` (query params) survives the prose escape untouched.
  out = out.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (_, url: string) => stash(encodeMrkdwnUrl(url)));

  // links [text](url) -> <url|label>. Escape the label and percent-encode only
  // the url's structural chars (<>|) so a link can't forge or break out of the
  // <url|label> structure (e.g. a label of `x> <!channel` injecting a broadcast).
  // The url keeps its literal `&` — query params must survive; HTML-escaping it
  // would corrupt the address. Stash the whole produced link so the prose escape
  // below leaves its real `<`/`>`/`|` and already-escaped label alone.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) =>
    stash(`<${encodeMrkdwnUrl(url)}|${escapeMrkdwn(label)}>`),
  );

  // Blockquotes use the same leading `>` in Markdown and Slack. Stash the leading
  // marker run so the escape pass doesn't turn it into `&gt;` (which would kill
  // the quote); a `>` anywhere else on the line is prose and stays escaped.
  out = out.replace(/^([ \t]*)(>+)/gm, (_, ws: string, gts: string) => `${ws}${stash(gts)}`);

  // Everything left is prose the agent controls: escape `&`/`<`/`>` so bare
  // <!channel>/<@U…>/forged <url|label> become inert visible text. This runs
  // BEFORE the marker conversions below, whose markers (*, _, ~, •) never
  // introduce `&`/`<`/`>`, so escaping first can't break or double-escape them.
  out = escapeMrkdwn(out);

  // Asterisk emphasis is normalized to BOLD, whichever dialect the model wrote:
  // `**x**` collapses to `*x*` and a single `*x*` is already mrkdwn bold, so both
  // render identically. Mapping `*x*` to italic (standard-Markdown semantics) made
  // the rendering depend on which dialect the model happened to emit — the same
  // verdict line arrived bold or italic run to run. Italic is `_x_` only.
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

  // Restore stashed structural syntax verbatim.
  return out.replace(new RegExp(`${STRUCT_OPEN}(\\d+)${STRUCT_CLOSE}`, "g"), (_, i) => structural[Number(i)]);
}
