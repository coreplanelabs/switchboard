// The reply stage of the dispatch pipeline (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// how a run is shown. The label a run carries on the runs index, the humanized
// form of a channel-authored turn for the record, the card's activity line and
// its close lines, the live-run link, the one shape a failure is reported in,
// and a command reply that outgrows one chat message. Pure string and shape
// work over the core's own types — no channel SDK (AGENTS.md invariant 1).
import type { ChannelIO, DocumentAttachment, ImageAttachment } from "../types.js";
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
import { postReviewComment, type ReviewCommentTarget } from "../../execution/githubComments.js";
import { currentPrHeadSha, type RepoContext } from "../repoContext.js";
import { runReviewPostStep } from "../reviewRound.js";
import type { ReviewVerdict } from "../reviewVerdict.js";
import { scheduleReflection } from "../memory/index.js";
import { resolveChatActor } from "../authz/actor.js";
import type { ChannelVisibility } from "../authz/types.js";
import type { FrictionDiagnosis } from "../runFriction.js";
import type { StopMode } from "../runEvents.js";
import type { RunHandle } from "../runRegistry.js";
import type { LedgerRun } from "../runLedger/writeThrough.js";
import type { RunEnding } from "../runEnding.js";
import type { CardShell } from "../statusCardFrame.js";
import type { Span } from "../trace/types.js";
import type { HistoryItem, IncomingMessage, StatusHandle } from "../types.js";
import type { AuthorizeDeps } from "./authorize.js";
import type { ProvisionDeps } from "./provision.js";
import type { ResolveDeps } from "./resolve.js";

/** The external live-view capability URL for a run, or undefined when
 *  PUBLIC_BASE_URL is unset/blank — the feature degrades gracefully (no link,
 *  everything else works). The token is a per-run capability, unguessable and
 *  scoped to one run; it is not a logged credential. */
export function liveViewLink(id: string, token: string): string | undefined {
  const base = process.env.PUBLIC_BASE_URL?.trim();
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}/runs/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`;
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
    case "answer":
      return "answer ready";
    case "turn":
      return ""; // legacy stored records only; a live run's thought line rides the runner's progress note
    case "run_meta":
      return "run context recorded"; // published straight to the registry too — never arrives here
    case "skill_use":
      return `📚 skill ${e.skill} loaded`;
    case "mcp_tool_use":
      return `🔌 ${e.server}/${e.tool} ${e.ok ? "ok" : "failed"} (${e.durationMs} ms)`;
    case "review_artifact":
      return "reading diff ready"; // published straight to the registry — never arrives here
    case "pr_description":
      return "PR description recorded"; // published straight to the registry — never arrives here
    case "pr_opened":
      return "PR opened"; // published straight to the registry — never arrives here
    case "ship_round":
      return `round ${e.index} (${e.agent}): ${e.outcome}`; // published straight to the registry — never arrives here
    case "span_start":
    case "span_end":
      return ""; // timing, not activity (docs/reference/specs/tracing.md): the card's activity line never shows a span
  }
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
 *   preferring display names and falling back to the prefix-stripped ids;
 * - a short quoted snippet of the request is appended when the text is non-empty;
 * - the whole thing is capped to RUN_LABEL_MAX chars.
 * Pure and channel-agnostic (HTTP/MCP have no names → the id fallback applies).
 */
export function composeRunLabel(input: RunLabelInput): string {
  const segments: string[] = [input.agent];
  if (input.repo) {
    segments.push(input.repo);
  } else {
    segments.push(`#${input.channelName ?? stripPlatformPrefix(input.channelId)}`);
    segments.push(input.userName ?? stripPlatformPrefix(input.userId));
  }
  const snippet = textSnippet(input.text);
  if (snippet) segments.push(snippet);
  const label = segments.join(" · ");
  return label.length > RUN_LABEL_MAX ? `${label.slice(0, RUN_LABEL_MAX - 1).trimEnd()}…` : label;
}

/** Prefixes the core stamps on status text — adapters use this to filter their
 *  own status noise out of history. */
export const STATUS_PREFIXES = ["⏳", "✅", "◐", "◓", "◑", "◒"];
/** The one shape a dispatch failure is reported in — the outer handler's reply
 *  and a failed inline run's `answer` are built from it, so they cannot drift. */
export function errorReply(err: unknown): string {
  return `⚠️ ${err instanceof Error ? err.message : String(err)}`;
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

/** What the reply stage's post-run steps read off the dispatcher's
 *  dependencies: the memory store and providers for the reflection pass, the
 *  review post and the PR head lookup for the review post-step. `CoreDeps`
 *  extends this; a caller's shape is unchanged. */
export interface ReplyDeps
  extends Pick<ProvisionDeps, "memory">, Pick<ResolveDeps, "providers">, Pick<AuthorizeDeps, "fetchPrHead"> {
  config: ConfigStore;
  /**
   * Posts a review comment back to a PR. Called after a `review`
   * run against a resolved PR, unless the request opted out. Default: the real
   * GitHub REST post with the App installation token (App `pull_requests:write`;
   * no `gh` shell-out — AGENTS.md invariant 5). Injectable so tests assert the
   * decision without a network call.
   */
  postReviewComment?: (target: ReviewCommentTarget, body: string) => Promise<void>;
}

/** How the answer's delivery ended: delivered (the card closed, the reply
 *  sent, the run sealed), or fenced — another generation owns the run now, and
 *  nothing more reaches the thread from here. */
export type Delivery = "delivered" | "fenced";

/**
 * The answer reaches the thread: `finishing` on the ledger first (the
 * double-answer protection once runs resume), then the card close, the reply
 * and the seal that writes the record — and the workspace released after,
 * whatever happened, so a channel failure never holds a pool user.
 */
export async function deliverAnswer(ctx: {
  msg: IncomingMessage;
  io: ChannelIO;
  agent: AgentDef;
  run: RunHandle;
  answer: string;
  liveUrl: string | undefined;
  prNote: string | undefined;
  stopped: StopMode | undefined;
  ledgerRun: LedgerRun | undefined;
  ending: RunEnding;
  card: StatusHandle;
  shell: CardShell;
  finalDetail: () => string | undefined;
  checkedOffDetail: () => string | undefined;
  /** The done card's shape and queued lines, from the finish-site diagnosis (the dispatch's `doneLines`). */
  doneLines: (diagnosis: FrictionDiagnosis | undefined) => { shape?: string; queued?: string };
  runDiagnosis: FrictionDiagnosis | undefined;
  releaseWorkspace: (span?: Span) => Promise<void>;
  root: Span;
}): Promise<Delivery> {
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
    finalDetail,
    checkedOffDetail,
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
      return "fenced";
    }
    // A review verdict carries its run link (as standard Markdown — each
    // adapter renders its own dialect): the verdict message is what gets
    // scanned in the review loop, and the card above scrolls away. Projection
    // only — the `answer` event published above and the GitHub post body stay
    // link-free.
    const channelAnswer = agent.name === "review" && liveUrl ? `${answer}\n\n[Live run](${liveUrl})` : answer;
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
              detail: stopped ? finalDetail() : checkedOffDetail(),
              ...doneLines(runDiagnosis),
            }),
          ),
        ),
      () => root.span("post.reply", () => io.reply(prNote ? `${channelAnswer}\n\n${prNote}` : channelAnswer)),
    );
  } finally {
    await root.span("post.workspace_release", (span) => releaseWorkspace(span));
  }
  return "delivered";
}

/**
 * After the reply has landed: the memory reflection pass (fire-and-forget,
 * gated on memory being on and the run having done real work) and the
 * deterministic review post-step (a review of a resolved PR posts its findings
 * back, behind the reviewed-head guard). Deliberately after the workspace
 * release and the registry finish, as before.
 */
export async function afterReply(
  deps: ReplyDeps,
  ctx: {
    msg: IncomingMessage;
    io: ChannelIO;
    agent: AgentDef;
    resolved: ResolvedRequest;
    directives: RequestDirectives;
    history: HistoryItem[];
    repoCtx: RepoContext;
    run: RunHandle;
    channelVisibility: ChannelVisibility;
    stopped: StopMode | undefined;
    answer: string;
    toolCalls: number;
    reviewHead: string | undefined;
    observedHead: string | undefined;
    verdict: ReviewVerdict | undefined;
    carried: { reviewed: string; current: string; commits: number } | undefined;
    root: Span;
  },
): Promise<void> {
  const {
    msg,
    io,
    agent,
    resolved,
    directives,
    history,
    repoCtx,
    run,
    channelVisibility,
    stopped,
    answer,
    toolCalls,
    reviewHead,
    observedHead,
    verdict,
    carried,
    root,
  } = ctx;
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
      providers: deps.providers,
      runModelRef: resolved.modelRef,
      gate: { toolCalls, historyTurns: history.length, agentName: resolved.agentName },
      threadKey: msg.threadKey,
      runId: run.id,
      // The writes are the policy's decision for the run's principal under the
      // run's stamped origin (authorization.md item 8): the same actor the chat
      // commands resolve, the same stamp the record carries.
      actor: resolveChatActor(msg, (id) => deps.config.grantsFor(id)),
      originChannelVisibility: channelVisibility,
      organization: deps.config.config.organization,
      userId: msg.userId,
      channelId: msg.channelId,
      repo: repoCtx.repo,
      history,
      request: directives.text,
      answer,
    });

  // Deterministic review post-step (runReviewPostStep in
  // reviewRound.ts): a `review` run against a resolved PR posts its findings
  // back to that PR by default — no need to ask — behind the reviewed-head
  // guard (item 8, fail-closed) and pinned to the verified head (or the
  // carried one, item 12). Best-effort: a post failure is logged and said in
  // the thread but never fails the dispatch (the review already landed in
  // Slack). A HARD-stopped review has no findings — only the abort line — so
  // nothing is posted; a soft stop's "findings so far" finale posts as
  // usual. Deliberately AFTER the workspace release and registry finish
  // above — the plain path's lifecycle position is unchanged.
  await root.span("post.review_post", () =>
    runReviewPostStep({
      agent,
      requestText: directives.text,
      repoCtx,
      heads: { reviewHead, observedHead },
      verdict,
      answer,
      carried,
      hardStopped: stopped === "hard",
      post: deps.postReviewComment ?? postReviewComment,
      fetchPrHead: deps.fetchPrHead ?? currentPrHeadSha,
      reply: (text) => io.reply(text),
      logKey: msg.threadKey,
    }),
  );
}
