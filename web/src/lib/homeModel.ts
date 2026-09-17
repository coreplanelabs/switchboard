import { HAND_BACK_PREFIX } from "@core/core/dispatch/handBack.js";

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

/** The `/` palette (rule 8): a message that is nothing but `/` and one word so
 *  far is a command being looked up; the word after the slash is the query.
 *  Anything else — prose, a second line, a slash mid-sentence — is not. */
export function slashQuery(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text);
  return m ? m[1] : null;
}

/** The palette's rows for a query: every command whose chat form or description
 *  matches the fuzzy filter, tightest first, the catalogue's order on ties. */
export function filterCommands<T extends { chat: string; describe: string }>(
  commands: readonly T[],
  query: string,
): T[] {
  if (query === "") return [...commands];
  return commands
    .map((c, i) => {
      const a = fuzzyScore(query, c.chat);
      const b = fuzzyScore(query, c.describe);
      const score = a === null ? b : b === null ? a : Math.min(a, b);
      return { c, i, score };
    })
    .filter((x): x is { c: T; i: number; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((x) => x.c);
}

/** Picking a row replaces the `/query` with the command's chat form and a
 *  space, so the person types its arguments next; the slash never reaches the
 *  bot (the fast path reads `<group> <verb>` at the start of a message). */
export function completeCommand(chat: string): string {
  return `${chat} `;
}

/** The placeholder guides the hand (rule 8): what to ask while nothing is live,
 *  what the box does while a run is, and the one thing to do after a hand-back. */
export function placeholderFor(mode: ComposerMode, hint?: string): string {
  if (hint) return "";
  if (mode === "steer") return "Say what to add — it folds into the run at its next step";
  if (mode === "stop") return "A run is working — type to steer it, or stop it";
  return "Review a pull request, ship a fix, investigate a run… or type / for a command";
}
