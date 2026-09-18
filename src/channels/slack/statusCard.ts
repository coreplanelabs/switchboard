// The status card's frame and the record of which cards are live: `render`
// (a StatusUpdate as Block Kit), the live-card sets the reconnect sweep asks
// before closing a card as orphaned, and the closes a boot reclaim paints.

import type { StatusUpdate } from "../../core/types.js";
import { escapeMrkdwn } from "../slackEscape.js";

// The card body is bounded so the blocks payload stays far under Slack's
// per-message limits whatever the tools emit.
const RENDER_DETAIL_RAW_MAX = 900;

/** Status cards THIS process is currently driving (channel:ts), added when the
 *  card is posted and removed when it is closed. The reconnect sweep consults
 *  it so a websocket reconnect without a restart never closes a running run's
 *  card as "interrupted" — only cards no living process owns are orphans. */
export const liveCards = new Set<string>();
export const liveCardKey = (channel: string, ts: string) => `${channel}:${ts}`;
export function ownsLiveCard(channel: string, ts: string): boolean {
  return liveCards.has(liveCardKey(channel, ts));
}
// Cards of runs another generation still holds a current lease on (the boot
// reclaim's `liveElsewhere`, docs/reference/specs/run-history.md item 36): a rollout
// overlap, or a container that kept running. The orphan sweep must not close
// them — their runs are live, just not here.
const foreignLiveCards = new Set<string>();
export function markForeignLiveCards(cards: Iterable<{ channel: string; ts: string }>): void {
  foreignLiveCards.clear();
  for (const c of cards) foreignLiveCards.add(liveCardKey(c.channel, c.ts));
}
// Where the set comes from on every reconnect (the ledger's live rows under a
// CURRENT lease held by another generation): refreshed right before each
// catch-up scan, so an overlapping generation that later dies loses its hold
// on its cards — the sweep then closes them like any orphan. A failed refresh
// keeps the previous set (never widens the sweep on a blip).
let foreignLiveCardsSource: (() => Promise<Iterable<{ channel: string; ts: string }>>) | undefined;
export function setForeignLiveCardsSource(source: typeof foreignLiveCardsSource): void {
  foreignLiveCardsSource = source;
}
export async function refreshForeignLiveCards(warn: (line: string) => void = console.warn): Promise<void> {
  if (!foreignLiveCardsSource) return;
  try {
    markForeignLiveCards(await foreignLiveCardsSource());
  } catch (err) {
    warn(`[slack] foreign live cards not refreshed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
/** Close the cards of the runs a boot reclaim finished on the ledger with a
 *  terminal status other than `interrupted` (docs/reference/specs/run-history.md item 36):
 *  their reply is in the thread, so the card says how the run ended rather
 *  than being swept as interrupted. Interrupted runs' cards are left for the
 *  sweep. Best-effort per card; a failure is logged and the rest go on. */
export async function closeReclaimedCards(
  client: { chat: { update(args: { channel: string; ts: string; text: string; blocks: object[] }): Promise<unknown> } },
  closures: Iterable<{
    status: string;
    agent?: string;
    card: { channel: string; ts: string } | null;
    note?: string;
  }>,
  warn: (line: string) => void = console.warn,
): Promise<number> {
  const glyph: Record<string, string> = {
    completed: "✅",
    stopped_soft: "⏹",
    stopped_hard: "⛔",
    failed: "❌",
    interrupted: "❌",
  };
  let closed = 0;
  for (const c of closures) {
    if (!c.card || !(c.status in glyph)) continue;
    // A run that replied: its record is complete. An interrupted run: the
    // closure's note says what to do next (run-history item 36).
    const detail =
      c.status === "interrupted"
        ? (c.note ?? "The bot restarted while this run was in flight and it could not be resumed.")
        : "The bot restarted after this run replied; its record is complete.";
    const frame: StatusUpdate = {
      title: `${glyph[c.status]} ${c.agent ?? "run"} · ${c.status.replace("_", " ")}`,
      detail,
    };
    try {
      await client.chat.update({ channel: c.card.channel, ts: c.card.ts, ...render(frame) });
      closed++;
    } catch (err) {
      warn(
        `[slack] reclaimed card ${c.card.channel}:${c.card.ts} not closed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return closed;
}
/** The sweep's question: is this card's run live anywhere we know of? */
export function isLiveCard(channel: string, ts: string): boolean {
  return ownsLiveCard(channel, ts) || foreignLiveCards.has(liveCardKey(channel, ts));
}

/** Status frames render as Block Kit: context headline + rich_text activity.
 *
 *  The body MUST be a `rich_text` block, never a `section`: Slack's client
 *  collapses a section's mrkdwn behind "Show more" at FIVE rendered lines
 *  (measured against the live client — 8/12/16/20-line sections all fold; rich_text
 *  at 30 lines does not), and a folded card re-renders expanded-then-collapsed
 *  on every chat.update, shoving the whole thread up and down on each 5s
 *  heartbeat. The card is link + checklist + activity ≈ 6+ lines, permanently
 *  past that fold. rich_text has no per-block fold, so the card never folds
 *  and edits never move the layout.
 *
 *  rich_text also neutralizes injection by construction: `text` elements are
 *  literal (a `<!channel>` in tool output renders as those characters, never a
 *  live @channel broadcast), so the untrusted `frame.detail` needs no escaping.
 *  `frame.title` still lands in a `mrkdwn` context field and is escaped;
 *  escapeMrkdwn only neutralizes `&`/`<`/`>`, so the title's intentional
 *  `*bold*`/`` `code` `` markup renders as before. Exported for tests. */
export function render(frame: StatusUpdate): { text: string; blocks: object[] } {
  const title = escapeMrkdwn(frame.title);
  const blocks: object[] = [{ type: "context", elements: [{ type: "mrkdwn", text: title }] }];
  const elements: object[] = [];
  // Each text piece after the first opens on its own line.
  const line = (text: string) => elements.push({ type: "text", text: elements.length > 0 ? `\n${text}` : text });
  // The run link is a typed link element: one rendered line, and its 100+-char
  // capability URL lives in the `url` field where it has no width at all.
  if (frame.link) elements.push({ type: "link", url: frame.link.url, text: frame.link.label });
  // The cap cut can land mid-astral-char; a lone high surrogate is invalid
  // JSON text and Slack rejects the payload, so drop it from the cut edge.
  if (frame.detail) line(frame.detail.slice(0, RENDER_DETAIL_RAW_MAX).replace(/[\uD800-\uDBFF]$/u, ""));
  // The activity is typed (run-visibility item 2): a command draws as a caption
  // naming the tool and a `rich_text_preformatted` code block beside the
  // section — a sibling element of the same rich_text block, so the no-fold
  // property holds — never a command re-parsed out of the text. A line is one
  // more line of the section.
  const activity = frame.activity;
  if (activity?.kind === "line") line(activity.text);
  if (activity?.kind === "command") line(`→ ${activity.tool}`);
  const body: object[] = [];
  if (elements.length > 0) body.push({ type: "rich_text_section", elements });
  if (activity?.kind === "command")
    body.push({ type: "rich_text_preformatted", elements: [{ type: "text", text: clipCommand(activity.command) }] });
  if (body.length > 0) blocks.push({ type: "rich_text", elements: body });
  return { text: title, blocks };
}

/** Lines of a command the card shows before counting the rest. */
const COMMAND_LINES_MAX = 6;
/** Characters of a command the card shows, whatever its line count. */
const COMMAND_CHARS_MAX = 600;

/** A command cut by structure, not by pattern: the first `COMMAND_LINES_MAX`
 *  lines kept and the rest counted (`… +N lines`), then the character cap with
 *  the same lone-surrogate guard the detail has — so a heredoc-fed script
 *  reads as its opening lines and a one-line monster cannot widen the card. */
export function clipCommand(command: string): string {
  const lines = command.split("\n");
  const kept =
    lines.length > COMMAND_LINES_MAX
      ? [...lines.slice(0, COMMAND_LINES_MAX), `… +${lines.length - COMMAND_LINES_MAX} lines`].join("\n")
      : command;
  if (kept.length <= COMMAND_CHARS_MAX) return kept;
  return `${kept.slice(0, COMMAND_CHARS_MAX - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
}
