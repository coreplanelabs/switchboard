import type { HomeCommandSeed } from "@core/channels/webSeed.js";
import { fuzzyScore } from "./homeModel";

// The `/` completer (docs/reference/specs/web-chat.md rule 8): a level-aware
// completion over the seed's commands, all client side, from one map built once
// per seed. The message is read as words; each word settled narrows the next:
// `/` offers the groups, `/config ` the verbs of config, `/config set ` the
// command's arguments and options. At every level the best match is shown as
// GHOST text after the caret — the rest of the word in grey — and Tab or → (at
// the end of the text) accepts it and moves on; the arrows change which match
// is the ghost. A word that settles on nothing closes the palette: the person
// is typing something else. The slash itself never reaches the bot
// (`stripSlash` removes it from a message that names a command).

export type SlashLevel = "group" | "verb" | "tail";

export interface SlashRow {
  /** What accepting this row puts in place of the word being typed. */
  insert: string;
  /** The row as shown, `/config set` or `--channel <id>`. */
  label: string;
  describe: string;
  kind: "group" | "command" | "option" | "usage";
  /** False for a row that only informs (the command's usage): Enter sends instead. */
  acceptable: boolean;
}

export interface SlashState {
  level: SlashLevel;
  /** The text before the word being typed, slash included (`/config `). */
  head: string;
  /** The word being typed, possibly empty. */
  partial: string;
  rows: SlashRow[];
  /** The command the words have settled on (tail level). */
  command?: HomeCommandSeed;
}

export interface SlashGhost {
  text: string;
  /** Tab / → accept it; a usage hint is shown but not accepted. */
  acceptable: boolean;
}

interface Group {
  name: string;
  /** The one-word command of this name (`help`), when there is one. */
  bare?: HomeCommandSeed;
  verbs: { verb: string; command: HomeCommandSeed }[];
}

/** The map the completer walks: groups in catalogue order, each with its verbs. */
export function slashIndex(commands: readonly HomeCommandSeed[]): Group[] {
  const groups = new Map<string, Group>();
  for (const c of commands) {
    const [name, verb] = c.chat.split(" ", 2);
    if (!name) continue;
    const g = groups.get(name) ?? { name, verbs: [] };
    if (verb === undefined) g.bare = c;
    else g.verbs.push({ verb, command: c });
    groups.set(name, g);
  }
  return [...groups.values()];
}

/** The matches for a word at one level: the items whose word starts with it, in
 *  catalogue order, when there are any — a prefix is what a person is typing —
 *  else the fuzzy matches on the word or its description, tightest first. */
function rank<T>(items: readonly T[], partial: string, texts: (item: T) => string[]): T[] {
  if (partial === "") return [...items];
  const q = partial.toLowerCase();
  const byPrefix = items.filter((item) => texts(item)[0].toLowerCase().startsWith(q));
  if (byPrefix.length > 0) return byPrefix;
  const scored = items
    .map((item, i) => {
      const scores = texts(item)
        .map((t) => fuzzyScore(partial, t))
        .filter((s): s is number => s !== null);
      return scores.length === 0 ? null : { item, i, score: Math.min(...scores) };
    })
    .filter((x): x is { item: T; i: number; score: number } => x !== null);
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((x) => x.item);
}

function usageOf(c: HomeCommandSeed, skipArgs = 0, usedFlags: ReadonlySet<string> = new Set()): string {
  const args = (c.args ?? []).slice(skipArgs);
  const options = (c.options ?? []).filter((o) => !usedFlags.has(flagOf(o.form))).map((o) => `[${o.form}]`);
  return [...args, ...options].join(" ");
}

const flagOf = (form: string): string => form.split(" ", 1)[0];

/** The words after the command's own, read for what they have consumed: how many
 *  positional arguments, and which flags (a flag whose form takes a value eats the next word). */
function consumed(c: HomeCommandSeed, words: readonly string[]): { positionals: number; flags: Set<string> } {
  const flags = new Set<string>();
  let positionals = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("-")) {
      flags.add(w);
      const option = (c.options ?? []).find((o) => flagOf(o.form) === w);
      if (option && option.form.includes(" ")) i++;
    } else positionals++;
  }
  return { positionals, flags };
}

/** The palette's state for the text, or null when the text is not a command being
 *  typed: prose, a second line, a slash mid-sentence, or words that settled on
 *  no group or verb. */
export function slashState(text: string, commands: readonly HomeCommandSeed[]): SlashState | null {
  const m = /^\/([^\n]*)$/.exec(text);
  if (!m || commands.length === 0) return null;
  const words = m[1].split(" ");
  const partial = words[words.length - 1];
  const done = words.slice(0, -1).filter((w) => w !== "");
  const head = text.slice(0, text.length - partial.length);
  const groups = slashIndex(commands);

  if (done.length === 0) {
    const rows = rank(groups, partial, (g) => [
      g.name,
      ...(g.bare ? [g.bare.describe] : []),
      ...g.verbs.map((v) => v.command.describe),
    ]).map((g): SlashRow => ({
      insert: g.name,
      label: `/${g.name}`,
      describe: g.bare
        ? g.verbs.length > 0
          ? `${g.bare.describe} · also ${g.verbs.map((v) => v.verb).join(", ")}`
          : g.bare.describe
        : g.verbs.map((v) => v.verb).join(" · "),
      kind: g.bare && g.verbs.length === 0 ? "command" : "group",
      acceptable: true,
    }));
    return { level: "group", head, partial, rows };
  }

  const group = groups.find((g) => g.name === done[0]);
  if (!group) return null;

  if (done.length === 1) {
    const verbs = rank(group.verbs, partial, (v) => [v.verb, v.command.describe]);
    // The group's one-word command with a word after it that is no verb: the word is its argument.
    if (verbs.length === 0 && group.bare && partial !== "") return tail(group.bare, head, partial, []);
    if (verbs.length === 0 && !group.bare) return { level: "verb", head, partial, rows: [] };
    const rows: SlashRow[] = verbs.map((v) => ({
      insert: v.verb,
      label: `/${v.command.chat}`,
      describe: v.command.describe,
      kind: "command",
      acceptable: true,
    }));
    if (group.bare && partial === "") rows.unshift(usageRow(group.bare, 0, new Set()));
    return { level: "verb", head, partial, rows };
  }

  const verb = group.verbs.find((v) => v.verb === done[1]);
  if (verb) return tail(verb.command, head, partial, done.slice(2));
  if (group.bare) return tail(group.bare, head, partial, done.slice(1));
  return null;
}

function usageRow(c: HomeCommandSeed, skipArgs: number, usedFlags: ReadonlySet<string>): SlashRow {
  const usage = usageOf(c, skipArgs, usedFlags);
  return {
    insert: "",
    label: `/${c.chat}`,
    describe: usage ? `${usage} — ${c.describe}` : c.describe,
    kind: "usage",
    acceptable: false,
  };
}

function tail(c: HomeCommandSeed, head: string, partial: string, after: readonly string[]): SlashState {
  const used = consumed(c, after);
  if (partial.startsWith("-")) {
    const options = rank(
      (c.options ?? []).filter((o) => !used.flags.has(flagOf(o.form))),
      partial,
      (o) => [flagOf(o.form), o.describe],
    );
    const rows: SlashRow[] = options.map((o) => ({
      insert: flagOf(o.form),
      label: o.form,
      describe: o.describe,
      kind: "option",
      acceptable: true,
    }));
    return { level: "tail", head, partial, rows, command: c };
  }
  return { level: "tail", head, partial, rows: [usageRow(c, used.positionals, used.flags)], command: c };
}

/** The grey text after the caret for the selected row: the rest of the word the
 *  row completes (accepted by Tab or →), or — when the row only informs and the
 *  word being typed is empty — the command's remaining usage, shown, never accepted. */
export function slashGhost(state: SlashState, selected: number): SlashGhost | null {
  const row = state.rows[selected];
  if (!row) return null;
  if (row.acceptable) {
    if (!row.insert.toLowerCase().startsWith(state.partial.toLowerCase())) return null;
    const rest = row.insert.slice(state.partial.length);
    return rest === "" ? null : { text: rest, acceptable: true };
  }
  if (state.partial !== "" || row.kind !== "usage") return null;
  const [hint, ...rest] = row.describe.split(" — ");
  return rest.length === 0 ? null : { text: hint, acceptable: false };
}

/** The text after accepting a row: the word being typed becomes the row's word, and a
 *  space follows so the next level opens at once. */
export function acceptRow(state: SlashState, row: SlashRow): string {
  return `${state.head}${row.insert} `;
}

/** A message that names a command loses its slash before it is sent: the fast
 *  path reads `<group> <verb>` at the start of a message. Anything else is sent as typed. */
export function stripSlash(text: string, commands: readonly HomeCommandSeed[]): string {
  if (!text.startsWith("/")) return text;
  const body = text.slice(1);
  const [a, b] = body.split(/\s+/, 2);
  const known = commands.some((c) => c.chat === a || (b !== undefined && c.chat === `${a} ${b}`));
  return known ? body : text;
}
