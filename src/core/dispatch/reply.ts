// The reply stage of the dispatch pipeline (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// how a run is shown. The label a run carries on the runs index, the humanized
// form of a channel-authored turn for the record, the card's activity line and
// its close lines, the live-run link, the one shape a failure is reported in,
// and a command reply that outgrows one chat message. Pure string and shape
// work over the core's own types — no channel SDK (AGENTS.md invariant 1).
import { buildReviewChannelReply, type ReviewPost, type ReviewVerdict } from "../reviewVerdict.js";
import { shows, type Verbosity } from "../verbosity.js";
import { visibilityOf } from "../authz/channelDirectory.js";
import type { ChannelIO, ConfirmationOffer, DocumentAttachment, ImageAttachment } from "../types.js";
import { confirmationMessageOf, newConfirmationId, renderOffer, type ConfirmationStore } from "../confirmations.js";
import { QUESTION_TTL_MS } from "../budgets.js";
import type { ParsedChatCommand } from "../commandChat.js";
import { cliWords } from "../commandSurface.js";
import { toMarkdownDocument } from "../markdownDocument.js";
import type { RunEvent } from "../runEvents.js";
import type { RequestTrace } from "../requestTrace.js";
import type { RunOwner } from "../trace/streamSpans.js";
import { cardShapeLine } from "../runShape.js";
import type { ConfigStore, ResolvedRequest } from "../../config.js";
import type { AgentDef } from "../../agents/registry.js";
import type { RequestDirectives } from "../../directives.js";
import type { RepoContext } from "../repoContext.js";
import { scheduleReflection } from "../memory/index.js";
import { resolveChatActor } from "../authz/actor.js";
import { narrowestVisibility } from "../memory/reflection.js";
import type { ChannelVisibility } from "../authz/types.js";
import type { FrictionDiagnosis } from "../runFriction.js";
import type { StopMode } from "../runEvents.js";
import type { RunHandle } from "../runRegistry.js";
import type { LedgerRun } from "../runLedger/writeThrough.js";
import type { RunEnding } from "../runEnding.js";
import type { CardShell } from "../statusCardFrame.js";
import type { Span } from "../trace/types.js";
import type { HistoryItem, IncomingMessage, StatusActivity, StatusHandle } from "../types.js";
import { refusalLine, type Refusal } from "../refusal.js";
import type { ProvisionDeps } from "./provision.js";
import type { RouteDeps } from "./route.js";

/** The external live-view capability URL for a run, or undefined when
 *  PUBLIC_BASE_URL is unset/blank — the feature degrades gracefully (no link,
 *  everything else works). The token is a per-run capability, unguessable and
 *  scoped to one run; it is not a logged credential. */
export function liveViewLink(id: string, token: string): string | undefined {
  const base = process.env.PUBLIC_BASE_URL?.trim();
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}/runs/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`;
}

/** The run's tokenless page (the finished run's history view, Access-gated) —
 *  what a stored file's lead points at on a channel without uploads
 *  (agent-coding.md item 10); undefined without PUBLIC_BASE_URL. */
export function runPageLink(id: string): string | undefined {
  const base = process.env.PUBLIC_BASE_URL?.trim();
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}/runs/${encodeURIComponent(id)}`;
}

/** One stored file's link: the run page's artifact proxy for `key`
 *  (`/runs/:id/artifacts/<key>`, live-view.md item 26), each key segment
 *  encoded so the route decodes them back; `?t=<token>` when the run's
 *  live token is given, so the link opens while the run is live. What a
 *  ticketless channel's lead carries (agent-coding.md item 10); undefined
 *  without PUBLIC_BASE_URL. */
export function artifactLink(id: string, key: string, token?: string): string | undefined {
  const page = runPageLink(id);
  if (!page) return undefined;
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `${page}/artifacts/${path}${token ? `?t=${encodeURIComponent(token)}` : ""}`;
}

// ---- run label (Area 2 / live-view index) -----------------------------------

/** Everything `composeRunLabel` needs to build one human-readable run label.
 *  Channel-agnostic: `channelName`/`userName` are optional display hints (Slack
 *  provides them; HTTP/MCP don't), and `channelId`/`userId` are the always-present
 *  namespaced ids the label falls back to. */
export interface RunLabelInput {
  /** Resolved agent name — the label always leads with this. */
  agent: string;
  /** Target repo (`owner/name`) for repo runs; absent for chat runs. */
  repo?: string;
  /** Namespaced channel id (`slack:C…`), used when no `channelName` resolved. */
  channelId: string;
  /** Namespaced user id (`slack:U…`), used when no `userName` resolved. */
  userId: string;
  /** Human channel/conversation name, if the adapter resolved one. */
  channelName?: string;
  /** Human user display name, if the adapter resolved one. */
  userName?: string;
  /** The request text; a short quoted snippet of it is appended to the label. */
  text: string;
}

/** Max chars in a snippet before it is cut (at a word boundary) and ellipsized —
 *  a laptop-width index row holds ~100 after the started column, chips and facts
 *  (live-view item 21; was 60, which left half the row empty). */
const SNIPPET_MAX = 100;
/** Hard cap on the whole label so one hostile/huge field can't dominate the index
 *  (the registry's own cap is 200). */
const RUN_LABEL_MAX = 160;

/** Drop the platform prefix from a namespaced id (`slack:U0123` → `U0123`) so an
 *  id fallback reads a little better when no display name is available. */
function stripPlatformPrefix(id: string): string {
  const i = id.indexOf(":");
  return i === -1 ? id : id.slice(i + 1);
}

/** Rewrite one URL into its shortest useful display form: a GitHub PR/issue
 *  becomes `owner/repo#N` (any trailing `/files`, `#discussion_…` dropped);
 *  anything else loses its scheme and `www.` so the host/path is what shows. */
function compactUrl(url: string): string {
  const gh = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+)\/(?:pull|issues)\/(\d+)/.exec(url);
  if (gh) return `${gh[1]}#${gh[2]}`;
  return url.replace(/^https?:\/\/(?:www\.)?/, "");
}

/** Make request text readable: Slack's `<url|label>` renders as its label,
 *  `<url>` as the url, mentions/channels as `@name`/`#name`. With `compact`
 *  (the run-label snippet) every URL also loses its scheme/`www.` and GitHub
 *  PR/issue URLs become `owner/repo#N` — the raw mrkdwn a Slack review request
 *  carries (`<https://github.com/…/pull/41|…>`) would otherwise be sliced
 *  mid-URL by the snippet budget. Without it (message events) URLs stay whole
 *  so the run page can render them as links. */
function humanizeLinks(text: string, compact = true): string {
  const show = (url: string) => (compact ? compactUrl(url) : url);
  // `<url|label>`: the label alone for the compact snippet. For message text the
  // url must survive so the run page can link it — Slack's auto-link form (label
  // = the url, or the url minus scheme/`www.`/trailing slash) becomes the bare
  // url; a genuine custom label becomes `label (url)`.
  const labelled = (url: string, label: string) => {
    if (!label.trim()) return show(url);
    if (compact) return label;
    return isAutoLinkLabel(url, label) ? url : `${label} (${url})`;
  };
  return (
    text
      // Slack mentions: `<@U…|name>` / `<#C…|name>` / `<!subteam^S…|@eng>` keep
      // their label; label-less ones become a readable stub rather than a raw id.
      .replace(/<@[^<>|\s]+\|([^<>]*)>/g, (_m, label: string) => `@${label.replace(/^@/, "")}`)
      .replace(/<@[^<>\s]+>/g, "@user")
      .replace(/<#[^<>|\s]+\|([^<>]*)>/g, (_m, label: string) => `#${label.replace(/^#/, "")}`)
      .replace(/<#[^<>\s]+>/g, "#channel")
      .replace(/<!(?:here|channel|everyone)(?:\|[^<>]*)?>/g, (m) => `@${/here|channel|everyone/.exec(m)![0]}`)
      .replace(/<!subteam\^[^<>|\s]+\|([^<>]*)>/g, (_m, label: string) => `@${label.replace(/^@/, "")}`)
      .replace(/<!subteam\^[^<>\s]+>/g, "@group")
      // Slack links: `<url|label>` → label (or the compacted url when empty), `<url>` → url.
      .replace(/<([^<>|\s]+)\|([^<>]*)>/g, (_m, url: string, label: string) => labelled(url, label))
      .replace(/<([a-z][a-z0-9+.-]*:\/\/[^<>\s]+)>/gi, (_m, url: string) => show(url))
      // Bare URLs: trailing sentence punctuation (`…/pull/12,` / `…/a).`) belongs
      // to the prose, not the url, so it is left in place.
      .replace(/\bhttps?:\/\/[^\s<>"']+/gi, (url) => {
        const trail = /[)\].,;:!?'"]+$/.exec(url)?.[0] ?? "";
        return show(url.slice(0, url.length - trail.length)) + trail;
      })
  );
}

/** Slack auto-links a pasted URL as `<url|label>` where the label is the url
 *  itself, often without its scheme, `www.` or trailing slash. */
function isAutoLinkLabel(url: string, label: string): boolean {
  const strip = (s: string) =>
    s
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/+$/, "");
  return strip(url) === strip(label);
}

/** Slack delivers message text with `&`, `<`, `>` as `&amp;`/`&lt;`/`&gt;` (the
 *  mrkdwn structural characters — the inverse of `escapeMrkdwn`). Undo that
 *  ONCE, after the `<…>` markup has been unwrapped so a literal `&lt;` never
 *  becomes structural. Pure string work: the core stays free of Slack imports. */
function unescapeSlackEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** The human-readable form of a Slack-authored turn for the run record: link,
 *  mention and channel markup unwrapped — `<url>` and auto-link `<url|url>` →
 *  the whole url, custom `<url|label>` → `label (url)`, never compacted — and
 *  entities unescaped. Only for text that came in through a channel — model
 *  output is not mrkdwn and must not pass through here. */
export function humanizeMessageText(text: string): string {
  return markdownEmphasis(unescapeSlackEntities(humanizeLinks(text, false)));
}

/** mrkdwn's bold in Markdown terms, so the run page's markdown renderer reads a
 *  Slack-authored turn as the human saw it (live-view item 18): `*bold*` →
 *  `**bold**` when the asterisks delimit a run that starts and ends on non-space
 *  (mrkdwn's rule) and sit on word edges — a glob (`src/*.ts`) or arithmetic
 *  (`2 * 3 * 4`) is left alone. Code spans and fences are left byte-for-byte.
 *  `_italic_` already means the same in both dialects; block-level mrkdwn (`•`
 *  bullets, quotes) cannot survive here — `parseDirectives` has already collapsed
 *  the request to one line. */
function markdownEmphasis(text: string): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/(^|[\s([{"'>])\*(\S(?:[^*\n]*?\S)?)\*(?=$|[\s)\]}.,!?:;"'<])/gm, "$1**$2**");
  }
  return parts.join("");
}

/** Whether a channel's text is Slack mrkdwn (AGENTS.md invariant 4: the id
 *  prefix names the platform) — the ONE gate on `humanizeMessageText` for the
 *  run record. HTTP, MCP, CLI and cron text is not mrkdwn and is recorded raw,
 *  exactly as the model received it. */
export function isMrkdwnChannel(channelId: string): boolean {
  return channelId.startsWith("slack:");
}

/** A short, quoted snippet of the request text for a run label: links
 *  humanized, whitespace collapsed, cut at the first sentence end or ~SNIPPET_MAX
 *  chars (whichever comes first, on a word boundary), ellipsized when anything
 *  was dropped. Empty/whitespace-only text → undefined (no snippet segment). */
function textSnippet(text: string): string | undefined {
  const collapsed = humanizeLinks(text).replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  // First sentence, when it ends within the budget AND there is more after it.
  // `#41` / `example.com/x` must not count as a sentence end, so a period only
  // ends a sentence when followed by whitespace. (No `$` alternative: it would
  // match the end of the SLICE, turning a dot at the budget edge inside a token
  // into a false sentence end. A dot ending the whole text needs no sentence
  // cut — the "whole thing fits" branch below covers it.)
  const end = collapsed.slice(0, SNIPPET_MAX + 1).search(/[.!?](?=\s)/);
  if (end !== -1 && end + 1 < collapsed.length) return `"${collapsed.slice(0, end)}…"`;
  // Otherwise the whole thing if it fits …
  if (collapsed.length <= SNIPPET_MAX) return `"${collapsed}"`;
  // … or a word-boundary cut with an ellipsis (fall back to a hard cut if the
  // first "word" alone already overflows the budget).
  const hard = collapsed.slice(0, SNIPPET_MAX);
  const wordCut = hard.replace(/\s+\S*$/, "").trimEnd();
  const body = wordCut.length >= SNIPPET_MAX / 2 ? wordCut : hard.trimEnd();
  return `"${body}…"`;
}

/** Longest `assistant` excerpt shown as the card's one-line activity trace. */
const ASSISTANT_TRACE_CAP = 80;

/**
 * The one-line activity trace the status card shows for a run event (the card
 * is a digest; the run page is the record). An `assistant` turn becomes a short
 * `💬` excerpt — one line, replaced by the next event, so the model's prose is
 * visible in-channel without ever growing the card. `input`, `context` and
 * `answer` are published straight to the registry and never arrive here; the
 * fallbacks only keep the switch total.
 */
export function activityLine(e: RunEvent): string {
  switch (e.type) {
    case "tool_call":
      return `→ ${e.summary}`;
    case "tool_result":
      return `${e.ok ? "✓" : "✗"} ${e.tool}: ${e.summary}`;
    case "run_note":
      return `⏱ ${e.summary}`;
    case "assistant": {
      const oneLine = e.text.replace(/\s+/g, " ").trim();
      return `💬 ${oneLine.length > ASSISTANT_TRACE_CAP ? `${oneLine.slice(0, ASSISTANT_TRACE_CAP)}…` : oneLine}`;
    }
    case "input":
      return "request received";
    case "context":
      return "context recorded";
    case "reference":
      return "referenced thread quoted";
    case "notes":
      return "📝 notes saved";
    case "answer":
      return "answer ready";
    case "run_meta":
      return "run context recorded"; // published straight to the registry too — never arrives here
    case "lease":
      return "lease started"; // the harness's clocks: head material the run loop keeps off the card — never arrives here
    case "skill_use":
      return `📚 skill ${e.skill} loaded`;
    case "artifact":
      return e.direction === "out" ? `📎 ${e.name} sent` : `📎 ${e.name} received`;
    case "review_artifact": // published straight to the registry — never arrives here
      return e.artifact === "pr_description" ? "PR description ready" : "reading diff ready";
    case "pr_description":
      return "PR description recorded"; // published straight to the registry — never arrives here
    case "pr_opened":
      return "PR opened"; // published straight to the registry — never arrives here
    case "pushed_head":
      return `⬆ pushed ${e.ref} @ ${e.sha.slice(0, 7)}`;
    case "coordinator_tag":
      return "coordinator tag recorded"; // published straight to the registry — never arrives here
    case "child_interrupted":
      return `🔁 interrupted by a deploy roll: ${e.reason}`; // published straight to the registry — never arrives here
    case "child_resumed":
      return `🔁 ${e.summary}`; // published straight to the registry — never arrives here
    case "review_posted":
      return "review posted"; // published straight to the registry — never arrives here
    case "ship_round":
      return `round ${e.index} (${e.agent}): ${e.outcome}`; // published straight to the registry — never arrives here
    case "ship_handoff":
      return "handed to the plan runner"; // published straight to the registry — never arrives here
    case "ship_unit":
      return `unit ${e.unit}: ${e.state}`; // published straight to the registry — never arrives here
    case "route":
      return `routed to ${e.preset}`; // published straight to the registry — never arrives here
    case "operator":
      return `operator ${e.outcome}`; // published straight to the registry — never arrives here (a shadow decision has no card line)
    case "refusal":
      return `refused: ${e.code}`; // published straight to the registry — never arrives here (a door record has no card)
    case "span_start":
    case "span_end":
      return ""; // timing, not activity (docs/reference/specs/tracing.md): the card's activity line never shows a span
  }
}

/**
 * The card's activity for a run event, with its structure kept: a bash call
 * that carries its `command` is a `command` part — the full command, not the
 * 200-char summary — which the Slack card draws as a code block; every other
 * event is its `activityLine` as a `line` part. No channel ever re-parses the
 * summary text to find the command (docs/reference/specs/run-visibility.md item 2).
 */
export function cardActivity(e: RunEvent): StatusActivity {
  if (e.type === "tool_call" && e.command !== undefined) return { kind: "command", tool: e.tool, command: e.command };
  return { kind: "line", text: activityLine(e) };
}

/** The activity as a quiet card paints it (routing-and-config item 28): a
 *  command becomes the caption Slack would draw over its code block — `→ bash`
 *  — and the block itself is kept for `verbose`; a line is a line. */
export function quietActivity(activity: StatusActivity | undefined): StatusActivity | undefined {
  if (activity?.kind === "command") return { kind: "line", text: `→ ${activity.tool}` };
  return activity;
}

/**
 * One-line note of what rode along with the request, for the `input` event
 * (docs/reference/specs/live-view.md item 12): `[+2 images, 1 document]`. Counts only — the
 * payloads never enter the run stream. Empty when nothing was attached.
 */
export function attachmentSuffix(
  images: ImageAttachment[] | undefined,
  documents: DocumentAttachment[] | undefined,
): string {
  const parts: string[] = [];
  if (images && images.length > 0) parts.push(`${images.length} image${images.length === 1 ? "" : "s"}`);
  if (documents && documents.length > 0) parts.push(`${documents.length} document${documents.length === 1 ? "" : "s"}`);
  return parts.length > 0 ? `[+${parts.join(", ")}]` : "";
}

/**
 * Build the human-first run label shown on the Access-gated `/runs` index. Rules:
 * - always lead with the agent name;
 * - a repo run is repo-identified (`coding · owner/repo · "…"`);
 * - a chat run shows channel + user (`review · #<channel> · <user> · "…"`),
 *   preferring display names and falling back to the prefix-stripped ids — and
 *   a direct message, which has no name and never a hash, reads `DM`;
 * - a short quoted snippet of the request is appended when the text is non-empty;
 * - the whole thing is capped to RUN_LABEL_MAX chars.
 * Pure and channel-agnostic (HTTP/MCP have no names → the id fallback applies).
 */
export function composeRunLabel(input: RunLabelInput): string {
  const segments: string[] = [input.agent];
  if (input.repo) {
    segments.push(input.repo);
  } else {
    segments.push(channelSegment(input.channelId, input.channelName));
    segments.push(input.userName ?? stripPlatformPrefix(input.userId));
  }
  const snippet = textSnippet(input.text);
  if (snippet) segments.push(snippet);
  const label = segments.join(" · ");
  return label.length > RUN_LABEL_MAX ? `${label.slice(0, RUN_LABEL_MAX - 1).trimEnd()}…` : label;
}

/** The label's channel segment: `#<name>`, or `#<id>` with the platform prefix
 *  stripped when no name resolved — except a direct message. A `slack:D…` id or
 *  the web chat's own lane (`visibilityOf` → `dm`) has no name Slack would give
 *  it and is not a channel a hash could point at, so it reads `DM`. */
function channelSegment(channelId: string, channelName: string | undefined): string {
  if (channelName === undefined && visibilityOf(channelId) === "dm") return "DM";
  return `#${channelName ?? stripPlatformPrefix(channelId)}`;
}

/** Prefixes the core stamps on status text — adapters use this to filter their
 *  own status noise out of history. */
export const STATUS_PREFIXES = ["⏳", "✅", "◐", "◓", "◑", "◒"];
/** The one shape a dispatch failure is reported in — the outer handler's reply
 *  and a failed inline run's `answer` are built from it, so they cannot drift. */
export function errorReply(err: unknown): string {
  return `⚠️ ${err instanceof Error ? err.message : String(err)}`;
}

/** The receipt of an operator bind (record 0057; the one-door plan's receipt
 *  rule): every bind's receipt carries the line as bound, the class verdict
 *  over its PARSED input and the operator's one-line reason — so the person
 *  reads what ran, how dangerous the door judged it and why the operator
 *  chose it, from one line — at `verbose` and above (routing-and-config item
 *  28), like the router's `routed:` line; the record's `operator` event keeps
 *  the bind at every level. */
export function renderOperatorReceipt(line: string, radius: string, reason: string): string {
  return `bound: \`${line}\` — ${radius} — ${reason}`;
}

/**
 * The one place a `Refusal` becomes what the person reads (record 0054):
 * the text is the producer's own sentence, byte-identical to what the site
 * said before the seam — the renderer adds nothing the producer did not put
 * in `text` or `wayForward`. A `policy` refusal appends its way forward when
 * the producer set one apart from the text; a `system` refusal renders the
 * text as the error it is and never an offer or a Yes; a `request` refusal
 * without a guess renders the text — which names what the door needs.
 */
export async function renderRefusal(
  refusal: Refusal,
  io: ChannelIO,
  ctx: { confirmations?: ConfirmationStore } = {},
): Promise<void> {
  // A `request` refusal that holds a guess is one question: the producer's
  // sentence, the marker, the corrected line to type and the evidence that
  // names the match. A channel that offers gets Yes and No on the same
  // question (record 0054's button): the proposal is stored as a `redispatch`
  // row and Yes hands it to `dispatch()` as the requester — a button showing
  // the exact line, as record 0044's Run is. A channel without `offer`, a
  // process without the store, or a store that cannot be reached at mint
  // costs the button and nothing else: the line to type is what the person
  // reads (the record's channel-without-offer shape).
  if (refusal.cause === "request" && refusal.guess) {
    if (await offerQuestion(refusal, io, ctx.confirmations)) return;
    return io.reply(refusalQuestion(refusal));
  }
  return io.reply(refusalLine(refusal));
}

/** Mint the question's `redispatch` row and show Yes and No on the channel's
 *  offer; answers whether the offer went out. */
async function offerQuestion(refusal: Refusal, io: ChannelIO, store: ConfirmationStore | undefined): Promise<boolean> {
  const guess = refusal.guess;
  if (!guess || !io.offer || !store) return false;
  const proposal = confirmationMessageOf(guess.proposal);
  let row;
  try {
    row = await store.put(
      {
        kind: "redispatch",
        id: newConfirmationId(),
        message: proposal,
        line: guess.line,
        evidence: guess.evidence,
        code: refusal.code,
      },
      // The question's own day, not the write's ten minutes: Yes only
      // re-dispatches the proposal, which meets its own gates when it runs.
      QUESTION_TTL_MS,
    );
  } catch (err) {
    console.warn(
      `[reply] ${proposal.threadKey} confirmation store unreachable at the question's mint, rendering the line to type: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  await io.offer({
    id: row.id,
    line: guess.line,
    risk: "",
    expiresAt: row.expiresAt,
    question: { text: refusal.text, evidence: guess.evidence },
  });
  return true;
}
/**
 * The one question a `request` refusal with a guess renders (record 0054): the
 * producer's sentence, then the marker — `Did you mean:`, the corrected line as
 * one code span — and the evidence. Pure and exported so the surfaces that
 * render a refusal without a channel (the chat error line, tests) read the same
 * bytes the renderer sends.
 */
export function refusalQuestion(refusal: Refusal): string {
  const guess = refusal.guess;
  if (!guess) return refusalLine(refusal);
  return `${refusal.text}\nDid you mean:\n\`${guess.line}\`\n\n${guess.evidence}`;
}
/**
 * An acknowledgement from a producing module the fence covers (record 0054):
 * a steered follow-up's ack, a hand-off's accepted reply, a unit-owned
 * thread's "noted" — sentences that refuse nothing and say what the system is
 * doing for the person. `verbose` material (routing-and-config item 28): sent
 * only when the request's level shows it; at `quiet` the person hears the
 * result and nothing before it. The fence (`refusals/no-raw-refusal`) keeps
 * producers off `io.reply`; what goes through here is review's to judge as an
 * ack, never a refusal in ack's clothing.
 */
export async function replyAck(io: ChannelIO, verbosity: Verbosity, text: string): Promise<void> {
  if (!shows(verbosity, "verbose")) return;
  return io.reply(text);
}

/**
 * A request's outcome that is neither a refusal nor an ack (record 0064: the
 * queued card — "a refusal becomes a queue position"): said at every
 * verbosity, because it is the answer to the ask, not material before it. The
 * renderer owns the reply so the producing modules stay behind the fence.
 */
export async function replyOutcome(io: ChannelIO, text: string): Promise<void> {
  return io.reply(text);
}
/**
 * The one caller of a channel's `offer` (record 0054): the Block Kit an
 * offered confirmation shows goes out through the reply stage, so the unit
 * that gives a `request` refusal its question and Yes reuses this seam. A
 * channel without `offer` gets the offer's text form — the same words the
 * record's `answer` carries (`renderOffer`).
 */
export async function renderConfirmationOffer(io: ChannelIO, offer: ConfirmationOffer): Promise<void> {
  if (io.offer) return io.offer(offer);
  return io.reply(renderOffer(offer));
}
/**
 * The gate sentences, keyed by refusal code (record 0054): each builder
 * returns the exact bytes the gate said before the seam — the producing site
 * calls its builder, the byte-identity test diffs the builders against the
 * inventory's quotes, and a drifted sentence fails there instead of shipping.
 * Codes missing here carry producer-built text on the `Refusal` instead:
 * `profile_bounded` (`profileRefusalReply`), `follow_up_refused` and its
 * `elsewhere_` twin (`refusalReply` in admission.ts), `pr_head_unknown`
 * (`checkPrHeadPreflight`), `branch_moved` (`guardAttachedHead`),
 * `ship_preflight` (the preflight's own reply), the reference codes (the one
 * `REFERENCE_REFUSAL` line), the click codes (confirm.ts's lines), and the
 * silent codes (`coordinator_thread_live`, `workspace_lost`, `setup_failed`,
 * `uncaught`) that render nothing here.
 */
export const REFUSAL_SENTENCES = {
  agent_allowlist: (p: { agent: string; adminsHint: string }) =>
    `🚫 You're not on the allowlist for the \`${p.agent}\` agent. Ask ${p.adminsHint} for access.`,
  live_agent_allowlist: (p: { agent: string; adminsHint: string }) =>
    `🚫 You're not on the allowlist for the \`${p.agent}\` agent, whose run is in flight in this thread. Ask ${p.adminsHint} for access.`,
  elsewhere_agent_allowlist: (p: { agent: string; adminsHint: string }) =>
    `🚫 You're not on the allowlist for the \`${p.agent}\` agent, whose run is in flight in this thread. Ask ${p.adminsHint} for access.`,
  repo_not_visible: (p: { slug: string; agent: string }) =>
    `📦 \`${p.slug}\` is not a repository this installation can see — GitHub answered 404 — so I did not start ${aRun(p.agent)} for it. ` +
    `The repository is outside the Switchboard GitHub App installation (\`github_repos\` lists the reachable ones), or the name is wrong.`,
  repo_unverified: (p: { slug: string; agent: string; via: "github" | "registry" }) =>
    p.via === "github"
      ? `⚠️ I couldn't verify \`${p.slug}\` against GitHub — it didn't answer — so I did not start ${aRun(p.agent)} rather than guess which repository you meant. Try again in a minute.`
      : `⚠️ I couldn't verify that \`${p.slug}\` is an onboarded repo — the resident registry didn't answer — so I did not start a *${p.agent}* run rather than guess which repo you meant. ` +
        `Try again in a minute, or name the repository by URL (https://github.com/${p.slug}) to run in a cold per-thread sandbox.`,
  repo_not_onboarded: (p: { slug: string; agent: string; onboardHint: string }) =>
    `📦 \`${p.slug}\` is not onboarded as a resident, so I did not start a *${p.agent}* run for it. ` +
    `${p.onboardHint} for a warm, deps-ready environment, or name the repository by URL ` +
    `(https://github.com/${p.slug}) to run in a cold per-thread sandbox.`,
  repo_access: (p: { repo: string; adminsHint: string }) =>
    `🚫 You're not on the allowlist for the \`${p.repo}\` repo environment. Ask ${p.adminsHint} for access.`,
  which_branch: (p: { repo: string | undefined }) =>
    `🌿 Which branch of \`${p.repo}\` should this thread work on? ` +
    `No branch is bound yet — reply naming one (e.g. "on main" or "on branch fix/login") and I'll pick it up from there.`,
  ship_thread_live: () =>
    "🚫 A pipeline is already running in this thread — one pipeline per thread. " +
    "Follow the one in flight here, or start this one in a thread of its own.",
  pipeline_thread_owned: (p: { agent: string; units: ReadonlyArray<{ unit: string; threadKey?: string }> }) =>
    `🚦 This thread belongs to the live *${p.agent}* pipeline runner — nothing runs beside it here. ` +
    (p.units.length > 0
      ? `Reply in the unit's own thread instead: ${p.units
          .map((u) => `${u.unit}${u.threadKey !== undefined ? ` (\`${u.threadKey}\`)` : ""}`)
          .join(", ")}.`
      : "Reply in the unit's own thread instead."),
  ship_budget: (p: { maxMinutes: number; maxRounds: number; need: number; provision: number; coding: number }) =>
    `🚫 Ship cannot start under a ${p.maxMinutes}-minute budget: the loop it allows (${p.maxRounds} review rounds) needs ${p.need} minutes — ` +
    `${p.provision} to provision, the coding child's ${p.coding}, and the reserve for the rounds after it at their floors. ` +
    `Widen the budget or the boundary that clipped it, or run \`agent:coding\` for a single pass without the review loop.`,
} as const;

/** `a *coding* run`, `an *explore* run`: the agent's name with its article. */
function aRun(agentName: string): string {
  return `${/^[aeiou]/i.test(agentName) ? "an" : "a"} *${agentName}* run`;
}
/** The card's shape and queued lines at a close (docs/reference/specs/tracing.md item 5):
 *  the root's streamed children so far, partitioned over the request's window
 *  — to the finish for a run that ran, to now for a close before any run. The
 *  card's own gate (a minute, or 15 s of getting ready) applies. */
export function cardLines(
  trace: RequestTrace,
  opts: { end: number; finished: boolean; owner: RunOwner; queued: string | undefined },
): { shape?: string; queued?: string } {
  const shape = cardShapeLine(trace.spansSoFar(), {
    window: { start: trace.receivedAt, end: opts.end },
    owner: opts.owner,
    finished: opts.finished,
  });
  return { ...(shape ? { shape } : {}), ...(opts.queued ? { queued: opts.queued } : {}) };
}
/** A command reply longer than one chat message can hold (a 100-tool `mcp
 *  show`) goes out as an attachment where the channel has one: the first line
 *  as the message, the whole text as a Markdown document named after the
 *  command (`toMarkdownDocument` — Slack renders a `.md` upload as CommonMark,
 *  which reads the chat dialect differently). Channels without `attach` — and
 *  an attach that fails — reply the text as before. */
export const LONG_COMMAND_REPLY_CHARS = 3_000;

export async function replyCommandOutput(io: ChannelIO, parsed: ParsedChatCommand, text: string): Promise<void> {
  if (!io.attach || text.length <= LONG_COMMAND_REPLY_CHARS) return io.reply(text);
  const nl = text.indexOf("\n");
  const lead = nl === -1 ? text : text.slice(0, nl);
  const name = parsed.kind === "invoke" ? cliWords(parsed.id).join("-") : "command";
  await io.attach({
    name: `${name}.md`,
    text: toMarkdownDocument(text),
    lead: `${lead}\n_(full output attached — ${text.length.toLocaleString("en-US")} chars)_`,
  });
}

/** What the reply stage's post-run step reads off the dispatcher's
 *  dependencies: the memory store and providers for the reflection pass.
 *  `CoreDeps` extends this; a caller's shape is unchanged. */
export interface ReplyDeps extends Pick<ProvisionDeps, "memory">, Pick<RouteDeps, "completions"> {
  config: ConfigStore;
}

/** How the answer's delivery ended: delivered (the card closed, the reply
 *  sent, the run sealed), or fenced — another generation owns the run now, and
 *  nothing more reaches the thread from here. */
export type Delivery = { kind: "delivered" } | { kind: "fenced" };

/** What `deliverAnswer` reads off the dispatch. */
export interface DeliveryContext {
  msg: IncomingMessage;
  io: ChannelIO;
  agent: AgentDef;
  run: RunHandle;
  answer: string;
  /** A review run's verdict and post outcome: the channel reply is rendered
   *  from them (agent-review.md item 5b). Absent on every other run. */
  verdict?: ReviewVerdict | undefined;
  reviewPost?: ReviewPost | undefined;
  /** The request's level: a review's thread reply is one line below `verbose`
   *  (routing-and-config item 28). Absent reads as `verbose` — the full render. */
  verbosity?: Verbosity | undefined;
  liveUrl: string | undefined;
  prNote: string | undefined;
  stopped: StopMode | undefined;
  ledgerRun: LedgerRun | undefined;
  ending: RunEnding;
  card: StatusHandle;
  shell: CardShell;
  checklistAsLeft: () => string | undefined;
  checklistCheckedOff: () => string | undefined;
  /** The done card's shape and queued lines, from the finish-site diagnosis (the dispatch's `doneLines`). */
  doneLines: (diagnosis: FrictionDiagnosis | undefined) => { shape?: string; queued?: string };
  runDiagnosis: FrictionDiagnosis | undefined;
  releaseWorkspace: (span?: Span) => Promise<void>;
  root: Span;
}

/**
 * The answer reaches the thread: `finishing` on the ledger first (the
 * double-answer protection once runs resume), then the card close, the reply
 * and the seal that writes the record — and the workspace released after,
 * whatever happened, so a channel failure never holds a pool user.
 */
export async function deliverAnswer(ctx: DeliveryContext): Promise<Delivery> {
  const {
    msg,
    io,
    agent,
    run,
    answer,
    liveUrl,
    prNote,
    stopped,
    ledgerRun,
    ending,
    card,
    shell,
    checklistAsLeft,
    checklistCheckedOff,
    doneLines,
    runDiagnosis,
    releaseWorkspace,
    root,
  } = ctx;
  // The coding PR post-step ran INSIDE the try above (before the stream
  // finished — its outcome is the `pr_opened` event); `prNote` carries what
  // it has to say to the thread.
  // `finally`, not sequential: a Slack failure in either call (outage, an
  // unchunkable line) must still give the pool user back, or it is held
  // until the hourly sweep — the toil 16a exists to avoid.
  try {
    // `live → finishing` on the ledger BEFORE anything reaches the thread
    // (item 35): the double-answer protection once runs resume — a
    // generation that lost the run is refused here and must not reply.
    // The status the record will carry rides on the row first, so a reclaim
    // of a `finishing` row (replied, died before `finish`) closes it
    // truthfully. A `fenced` answer means another generation reclaimed this
    // run while it ran (a handoff, or a lease that lapsed) and is driving it
    // now: nothing more reaches the thread from here — the record is theirs.
    ledgerRun?.setState({ finalStatus: stopped ? `stopped_${stopped}` : "completed" });
    if ((await root.span("post.ledger_finishing", () => ledgerRun?.finishing())) === "fenced") {
      // Nothing more from here: no reply, no card close, and no record — the
      // run is the other generation's now and its record is theirs to write
      // (a partial record from this process could race the real finish). The
      // outer finally still seals the stream here.
      console.log(`[run] ${msg.threadKey} run ${run.id}: another generation owns this run — not replying`);
      ending.drop(run.id);
      return { kind: "fenced" };
    }
    // A review's reply is rendered from its typed verdict (agent-review.md
    // item 5b): the verdict line, the findings, where it was posted and the run
    // link (as standard Markdown — each adapter renders its own dialect); the
    // write-up rides along only when no GitHub post carries it. Projection
    // only — the `answer` event published above stays the model's own words
    // and link-free.
    const channelAnswer =
      agent.name === "review"
        ? buildReviewChannelReply({
            answer,
            verdict: ctx.verdict,
            posted: ctx.reviewPost?.posted ? ctx.reviewPost.target : undefined,
            liveUrl,
            ...(ctx.verbosity !== undefined ? { verbosity: ctx.verbosity } : {}),
          })
        : answer;
    // The PR note (post-step above) is a projection too: the `answer` event
    // stays the model's own words — the PR facts live in the pr_description
    // event and the [pr-post] log line.
    // The card close, the reply, then the drain: the run is sealed with how
    // the reply went and its record goes to the store — BEFORE the
    // workspace release below: the record does not depend on it, and on the
    // ledger the finish is what frees the thread, which must not wait ~90 s on
    // a sandbox teardown (docs/reference/specs/run-history.md item 36). Fire-and-forget;
    // the writer's `pending()` is incremented inside the drain, before the
    // outer finally's `activeRuns--`, so the shutdown drain never observes
    // "0 runs, 0 writes". A reply that threw still seals (`replyOk: false`)
    // and writes (`failed`) here, then reaches the outer catch for the error
    // reply.
    await ending.sealAfterReply(
      () =>
        root.span("post.card_close", () =>
          card.done(
            shell.close({
              kind: "done",
              icon: stopped === "hard" ? "⛔" : stopped === "soft" ? "⏹" : "✅",
              detail: stopped ? checklistAsLeft() : checklistCheckedOff(),
              ...doneLines(runDiagnosis),
            }),
          ),
        ),
      () => root.span("post.reply", () => io.reply(prNote ? `${channelAnswer}\n\n${prNote}` : channelAnswer)),
      // A null channel's reply resolves but reaches nobody: the seal says
      // `replyOk: false` with the reason (run-history.md item 38).
      io.undeliverable !== undefined ? { undelivered: io.undeliverable } : undefined,
    );
  } finally {
    await root.span("post.workspace_release", (span) => releaseWorkspace(span));
  }
  return { kind: "delivered" };
}

/** What `afterReply` reads off the dispatch. */
export interface AfterReplyContext {
  msg: IncomingMessage;
  resolved: ResolvedRequest;
  directives: RequestDirectives;
  history: HistoryItem[];
  repoCtx: RepoContext;
  run: RunHandle;
  channelVisibility: ChannelVisibility;
  /** The visibility of every conversation the run quoted (record 0037); the
   *  memory gate writes under the narrowest of these and the origin. */
  referenceVisibilities?: readonly ChannelVisibility[];
  stopped: StopMode | undefined;
  answer: string;
  toolCalls: number;
}

/**
 * After the reply has landed: the memory reflection pass (fire-and-forget,
 * gated on memory being on and the run having done real work). The review
 * post-step used to run here too, after the seal that writes the record; it
 * now runs inside the run loop, before the stream finishes, so the record
 * carries its outcome (agent-review.md item 18).
 */
export function afterReply(deps: ReplyDeps, ctx: AfterReplyContext): void {
  const { msg, resolved, directives, history, repoCtx, run, channelVisibility, stopped, answer, toolCalls } = ctx;
  const referenceVisibilities = ctx.referenceVisibilities ?? [];
  // Cross-session memory — WRITE path. AFTER the reply has
  // landed, distill this run into memory records: fire-and-forget (tracked
  // only for the shutdown drain), so its latency/failures never reach the
  // user; gated on memory.enabled (default off → nothing happens) and on the
  // run having done real work (tools used, or a long thread) and not being a
  // `review` run (findings live on the PR; distilling them floods org
  // memory with per-PR ephemera). Fast paths above returned before this
  // point and never reflect. A HARD-stopped run has no summary to distill
  // (its answer is the abort line), so it is skipped too; a soft stop wrote
  // a real finale and reflects normally.
  if (stopped !== "hard")
    scheduleReflection({
      cfg: deps.config.config.memory,
      store: deps.memory,
      // The extractor's one call goes through pi's model library
      // (harness-pi.md item 13), never the loop's own provider adapters.
      providers: deps.completions,
      runModelRef: resolved.modelRef,
      gate: { toolCalls, historyTurns: history.length, agentName: resolved.agentName },
      threadKey: msg.threadKey,
      runId: run.id,
      // The writes are the policy's decision for the run's principal under the
      // run's stamped origin (authorization.md item 8): the same actor the chat
      // commands resolve, the same stamp the record carries — narrowed to the
      // narrowest conversation the run quoted (record 0037), so a private
      // thread quoted into a public channel never seeds an org fact.
      actor: resolveChatActor(msg, (id) => deps.config.grantsFor(id)),
      originChannelVisibility: narrowestVisibility(channelVisibility, ...referenceVisibilities),
      organization: deps.config.config.organization,
      userId: msg.userId,
      channelId: msg.channelId,
      repo: repoCtx.repo,
      history,
      request: directives.text,
      answer,
    });
}
