import { HAND_BACK_PREFIX } from "@core/core/dispatch/handBack.js";
import { formatDateTime, formatRelative } from "./format";
import { SURFACE_NAME } from "./indexRow";

// The home page's pure rules (docs/reference/specs/web-chat.md; record 0043):
// what the composer's one control is at any moment, what a run-less reply
// means, where a `202` points, how a conversation is titled, and what the
// empty state says. No DOM, no clock: every function takes what it needs, so
// the page tests and the component tests read one implementation.

/** The composer's one control (rule 5): `send` when no run is live in the
 *  conversation; while one is, `steer` when there is text to fold in and
 *  `stop` when the box is empty. It is never disabled while a run is live. */
export type ComposerMode = "send" | "steer" | "stop";

export function composerMode(live: boolean, text: string): ComposerMode {
  if (!live) return "send";
  return text.trim() === "" ? "stop" : "steer";
}

/** What a `200 { reply }` means on the page: a hand-back (record 0039) is the
 *  line to paste, which fills the composer and paints no turn; a steer
 *  acknowledgement paints nothing either (the live turn's `input` event
 *  confirms the turn already drawn); anything else is an inline turn, shown
 *  once and never stored. */
export type InlineReply =
  { kind: "handBack"; command: string } | { kind: "steerAck"; text: string } | { kind: "inline"; text: string };

const STEER_ACK_MARK = "↪ Folded into";

export function classifyReply(reply: string): InlineReply {
  const text = reply.trim();
  if (text.startsWith(HAND_BACK_PREFIX)) {
    return { kind: "handBack", command: text.slice(HAND_BACK_PREFIX.length).trim() };
  }
  if (text.startsWith(STEER_ACK_MARK)) return { kind: "steerAck", text };
  return { kind: "inline", text };
}

/** The run's stream and stop routes from the view path a `202` carries
 *  (`/runs/<id>?t=<token>`): the same two URLs a live run seed carries. */
export function liveUrls(viewPath: string): { id: string; eventsUrl: string; stopUrl: string } | null {
  const m = /^\/runs\/([^/?#]+)(\?t=([^&#]+))?$/.exec(viewPath);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  const token = m[3] ? `?t=${m[3]}` : "";
  return { id, eventsUrl: `/runs/${m[1]}/events${token}`, stopUrl: `/runs/${m[1]}/stop${token}` };
}

/** A conversation's title is its first request cut to one line of at most
 *  `max` characters (record 0043, "The conversation is the thread's records"). */
export function conversationTitle(firstRequest: string, max = 60): string {
  const line =
    firstRequest
      .split(/\r?\n/)
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  if (line.length <= max) return line || "New conversation";
  return `${line.slice(0, max - 1).trimEnd()}…`;
}

/** The rail row's distance (rule 7), short so the title keeps the room: `now`,
 *  `3m`, `1h`, `2d`, then the date as the runs index writes it. The full moment
 *  is the row's tooltip's (`threadTip`). */
export function compactAge(at: number, now: number): string {
  const delta = now - at;
  if (!(delta > 45_000)) return "now";
  const m = Math.floor(delta / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return formatRelative(at, now);
}

/** What a rail row says on hover (rule 7): the first request's line in full
 *  (the excerpt; the cut title when the seed has none), the moment as a date
 *  and time, the channel — `Web` for the person's own lane, else the surface's
 *  name and that it is read-only here — the run count, and whether a run is
 *  in flight. Facts only: the tooltip component lays them out. */
export interface ThreadTipFacts {
  title: string;
  when: string;
  source: string;
  runs: string;
  live: boolean;
}
export function threadTip(
  row: {
    title: string;
    excerpt: string;
    lastAt: number;
    runs: number;
    live: boolean;
    surface?: string;
    channelName?: string;
  },
  now: number,
): ThreadTipFacts {
  const surface = row.surface ?? "web";
  const name = SURFACE_NAME[surface] ?? surface;
  // The channel by name when the seed carries one (`Slack #backend`), the surface alone otherwise.
  const where = row.channelName ? `${name} #${row.channelName}` : name;
  return {
    title: row.excerpt || row.title,
    when: formatDateTime(row.lastAt, now),
    source: surface === "web" ? name : `${where} · read-only here`,
    runs: `${row.runs} run${row.runs === 1 ? "" : "s"}`,
    live: row.live,
  };
}

/** The rail column's width band in CSS pixels (rule 7): 14 to 28 rem, 18 rem
 *  to start, one arrow key one rem. */
export const RAIL_WIDTH = { min: 224, default: 288, max: 448, step: 16 } as const;

/** A width in the band; anything that is not a finite number is the default. */
export function clampRailWidth(n: unknown): number {
  const v = typeof n === "string" ? Number(n) : n;
  if (typeof v !== "number" || !Number.isFinite(v)) return RAIL_WIDTH.default;
  return Math.min(RAIL_WIDTH.max, Math.max(RAIL_WIDTH.min, Math.round(v)));
}

/** The two things the browser remembers about the rail, by their storage keys. */
export const RAIL_PREF = { width: "sb.rail.width", collapsed: "sb.rail.collapsed" } as const;

/** What the remembered strings mean: a width in the band (the default when
 *  nothing or nonsense was kept) and whether the column is hidden (`"1"`). */
export function railPrefs(stored: { width: string | null; collapsed: string | null }): {
  width: number;
  collapsed: boolean;
} {
  return { width: clampRailWidth(stored.width ?? undefined), collapsed: stored.collapsed === "1" };
}

/** The empty state's greeting names the person (rule 7) and the time of day,
 *  from the hour the caller resolved (the browser's local hour), never a clock
 *  read here. */
export function greeting(hour: number, name: string): string {
  const part = hour < 5 ? "Still up" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}.` : `${part}.`;
}

/** The person's turn that a steer confirms: the newest turn awaiting a fold
 *  whose text is the drained `input` event's text, trimmed. One message,
 *  drawn once (rule 3), matched by its words. */
export function matchSteer<T extends { text: string; folded: boolean }>(
  turns: readonly T[],
  inputText: string,
): T | null {
  const want = inputText.trim();
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (!t.folded && t.text.trim() === want) return t;
  }
  return null;
}

/** The transcript follows new content only when the reader was already at the
 *  bottom (rule 2): `distanceFromBottom` in pixels, `slack` how far up still
 *  counts as "at the bottom". */
export function shouldFollow(distanceFromBottom: number, slack = 60): boolean {
  return distanceFromBottom <= slack;
}

/** Enter sends (or steers), Shift+Enter breaks a line (rule 8); every other key is the textarea's. */
export function enterSubmits(ev: { key: string; shiftKey: boolean; isComposing?: boolean }): boolean {
  return ev.key === "Enter" && !ev.shiftKey && !ev.isComposing;
}

/** The rail's filter (rule 7): a case-insensitive subsequence match, so `rvw
 *  api` finds "review https://github.com/acme/api/pull/61". Scored by how
 *  tightly the query's characters sit together; ties keep the rail's order. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;
  const t = text.toLowerCase();
  let from = 0;
  let first = -1;
  let last = -1;
  for (const ch of q) {
    if (ch === " ") continue;
    const at = t.indexOf(ch, from);
    if (at === -1) return null;
    if (first === -1) first = at;
    last = at;
    from = at + 1;
  }
  return first === -1 ? 0 : last - first;
}

export function filterRows<T extends { title: string }>(rows: readonly T[], query: string): T[] {
  if (query.trim() === "") return [...rows];
  return rows
    .map((row, i) => ({ row, i, score: fuzzyScore(query, row.title) }))
    .filter((x): x is { row: T; i: number; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((x) => x.row);
}

/** The page's two shortcuts, shown beside the controls they fire (rule 7):
 *  ⇧⌘O (Ctrl on other platforms) opens a new thread, ⌘K focuses the filter. */
export type Shortcut = "newThread" | "search";

export function shortcutFor(ev: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): Shortcut | null {
  const mod = ev.metaKey || ev.ctrlKey;
  if (!mod) return null;
  const key = ev.key.toLowerCase();
  if (key === "o" && ev.shiftKey) return "newThread";
  if (key === "k" && !ev.shiftKey) return "search";
  return null;
}

/** The placeholder guides the hand (rule 8): what to ask while nothing is live,
 *  what the box does while a run is, and the one thing to do after a hand-back. */
export function placeholderFor(mode: ComposerMode, hint?: string): string {
  if (hint) return "";
  if (mode === "steer") return "Say what to add — it folds into the run at its next step";
  if (mode === "stop") return "A run is working — type to steer it, or stop it";
  return "Review a pull request, ship a fix, investigate a run… or type / for a command";
}
