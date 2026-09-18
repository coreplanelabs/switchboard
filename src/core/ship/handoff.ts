import { redactSecrets } from "../redact.js";

// The handoff (docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md,
// docs/reference/specs/agent-ship.md item 14, agent-coding.md item 9): what a
// coding child hands back beside its pull-request description when it ran for
// a plan unit — where it departed from the unit and why, what it found and did
// not do, which of the unit's criteria it could not prove, and what of the
// unit was already on the base before it began (`landed`, the fact the ship
// machine ends a unit `already_landed` on, agent-ship.md item 12). It is data, not
// prose in a final message: the child submits it through `submit_handoff` (the
// same tool path as the description), the run record carries it, and the
// parent posts it to the unit's board issue, where a person decides each row's
// disposition and amends the plan's follow-ups ledger while the plan is still
// `proposed` — no bot path writes a plan record.
//
// Pure and dependency-light on purpose: `runRecord.ts` (node-free, shared with
// the state Worker) imports the type and the shape check, so nothing here may
// pull in zod or a Node built-in. The validator is hand-written like
// `isRunRecord`; the redaction seam is the same import-free module every
// surface uses.

export interface HandoffDeviation {
  /** What the unit said. */
  from: string;
  /** What was done instead. */
  to: string;
  why: string;
}

export interface HandoffFollowUp {
  /** What was found and not done. */
  what: string;
  /** Where it belongs — a file, a unit, a spec. */
  where: string;
}

export interface HandoffUnproven {
  /** The unit's test scenario or criterion. */
  criterion: string;
  why: string;
}

/** A part of the unit's scope that was already on the base when the run
 *  began — the fact the ship machine reads at round 0 (agent-ship.md item 12):
 *  a handoff naming where the scope landed, beside a branch with no commits
 *  over the base, ends the unit `already_landed` instead of aborting it. */
export interface HandoffLanded {
  /** What of the unit was already there. */
  what: string;
  /** Where it landed — the pull request or commit that carries it. */
  where: string;
}

export interface Handoff {
  deviations: HandoffDeviation[];
  followUps: HandoffFollowUp[];
  unproven: HandoffUnproven[];
  /** Absent on a handoff that named none and on a record written before the
   *  list existed; every reader treats absent as empty. */
  landed?: HandoffLanded[];
}

/** The most entries one list may carry: a handoff is a summary for a person,
 *  not a second review. */
export const HANDOFF_MAX_ITEMS = 20;
/** The most characters one field may carry, on the way in. Stored records are
 *  checked for shape only (`isHandoffShape`): redaction may lengthen a string. */
export const HANDOFF_MAX_FIELD_CHARS = 500;

type ListKey = keyof Handoff;

/** Each list's entry fields, the one source for the validator, the redactor and the renderers. */
const FIELDS: Readonly<Record<ListKey, readonly string[]>> = {
  deviations: ["from", "to", "why"],
  followUps: ["what", "where"],
  unproven: ["criterion", "why"],
  landed: ["what", "where"],
};
const LISTS: readonly ListKey[] = ["deviations", "followUps", "unproven", "landed"];
/** The lists every handoff carries; `landed` is optional (its type says so). */
const REQUIRED: ReadonlySet<ListKey> = new Set<ListKey>(["deviations", "followUps", "unproven"]);

/** A handoff under construction: each list as entries keyed by `FIELDS`, the
 *  optional one present only when given. It IS a `Handoff` once every entry
 *  carries its list's fields — which the two builders below guarantee — so the
 *  one conversion at their boundary is the table above standing in for four
 *  interface declarations. */
type FieldLists = Record<Exclude<ListKey, "landed">, Record<string, string>[]> & {
  landed?: Record<string, string>[];
};

const emptyLists = (): FieldLists => ({ deviations: [], followUps: [], unproven: [] });
const asHandoff = (lists: FieldLists): Handoff => lists as unknown as Handoff;
const asLists = (h: Handoff): FieldLists => h as unknown as FieldLists;
/** A list's entries, an absent optional list read as empty. */
const listOf = (lists: FieldLists, key: ListKey): Record<string, string>[] => lists[key] ?? [];

export function emptyHandoff(): Handoff {
  return asHandoff(emptyLists());
}

export function isEmptyHandoff(h: Handoff): boolean {
  return LISTS.every((k) => listOf(asLists(h), k).length === 0);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural check — the three lists, each entry an object whose named fields
 *  are strings. What a stored record is validated with: no bounds, so a record
 *  never becomes unreadable because redaction lengthened a field. */
export function isHandoffShape(v: unknown): v is Handoff {
  if (!isRecord(v)) return false;
  return LISTS.every((key) => {
    const list = v[key];
    if (list === undefined) return !REQUIRED.has(key);
    return (
      Array.isArray(list) &&
      list.every((entry) => isRecord(entry) && FIELDS[key].every((f) => typeof entry[f] === "string"))
    );
  });
}

export type ParsedHandoff = { ok: true; handoff: Handoff } | { ok: false; error: string };

const fieldList = (key: ListKey): string => {
  const fs = FIELDS[key];
  return `${fs.slice(0, -1).join(", ")} and ${fs[fs.length - 1]}`;
};

/** Validate untrusted input (a tool call) into a Handoff: the three lists
 *  present (each may be empty) and `landed` when given, at most
 *  `HANDOFF_MAX_ITEMS` entries each, every field a non-empty string of at most
 *  `HANDOFF_MAX_FIELD_CHARS` once trimmed; unknown keys are dropped. A refusal
 *  is a string naming the path, never a throw, so the model can fix the object
 *  and call again. */
export function parseHandoff(input: unknown): ParsedHandoff {
  if (!isRecord(input))
    return { ok: false, error: "handoff: must be an object with deviations, followUps and unproven" };
  const out = emptyLists();
  for (const key of LISTS) {
    const list = input[key];
    if (list === undefined && !REQUIRED.has(key)) continue;
    if (!Array.isArray(list))
      return { ok: false, error: `${key}: must be an array (empty when there is nothing to say)` };
    out[key] = [];
    if (list.length > HANDOFF_MAX_ITEMS) return { ok: false, error: `${key}: at most ${HANDOFF_MAX_ITEMS} entries` };
    for (let i = 0; i < list.length; i++) {
      const entry: unknown = list[i];
      if (!isRecord(entry)) return { ok: false, error: `${key}.${i}: must be an object with ${fieldList(key)}` };
      const clean: Record<string, string> = {};
      for (const f of FIELDS[key]) {
        const raw = entry[f];
        const value = typeof raw === "string" ? raw.trim() : "";
        if (value.length === 0 || value.length > HANDOFF_MAX_FIELD_CHARS)
          return {
            ok: false,
            error: `${key}.${i}.${f}: must be a non-empty string of at most ${HANDOFF_MAX_FIELD_CHARS} characters`,
          };
        clean[f] = value;
      }
      out[key]!.push(clean);
    }
  }
  return { ok: true, handoff: asHandoff(out) };
}

/** Every string leaf through the redaction seam (`redactSecrets` by default),
 *  structure preserved, the input untouched — the same rule the published
 *  description follows, so a credential pasted into a handoff never reaches a
 *  run record or a board issue. */
export function redactHandoff(h: Handoff, redact: (s: string) => string = redactSecrets): Handoff {
  const out = emptyLists();
  const lists = asLists(h);
  for (const key of LISTS) {
    if (lists[key] === undefined) continue;
    out[key] = lists[key].map((entry) => {
      const clean: Record<string, string> = {};
      for (const f of FIELDS[key]) clean[f] = redact(entry[f]!);
      return clean;
    });
  }
  return asHandoff(out);
}

// ---- the renders ---------------------------------------------------------------------------------

export interface HandoffRenderContext {
  /** The unit's id as the plan spells it (`U17`). */
  unitId: string;
  /** The unit's pull request, when the round opened or edited one. */
  pr?: { number: number; url: string };
}

/** The header of the plan's follow-ups ledger (Appendix B), so the rows below
 *  paste into it as the same table. */
export const HANDOFF_LEDGER_HEADER = "| Follow-up | Source | Disposition |\n|---|---|---|";

/** One line: a newline would end a bullet or a table row. */
function line(s: string): string {
  return s.replace(/\s*\n\s*/g, " ");
}

/** A table cell: a literal `|` would split the row; a backslash is escaped
 *  first so an input `\|` does not become an escaped escape. */
function cell(s: string): string {
  return line(s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|"));
}

/** Each entry as one line of prose, the same words in a bullet and in a ledger row. */
function entryLines(h: Handoff): Array<{ list: ListKey; bullet: string; row: string }> {
  return [
    ...h.deviations.map((d) => {
      const text = `${d.from} → ${d.to} — ${d.why}`;
      return { list: "deviations" as const, bullet: text, row: `Deviation: ${text}` };
    }),
    ...h.followUps.map((f) => {
      const text = `${f.what} — ${f.where}`;
      return { list: "followUps" as const, bullet: text, row: text };
    }),
    ...h.unproven.map((u) => {
      const text = `${u.criterion} — ${u.why}`;
      return { list: "unproven" as const, bullet: text, row: `Unproven: ${text}` };
    }),
    ...(h.landed ?? []).map((l) => {
      const text = `${l.what} — ${l.where}`;
      return { list: "landed" as const, bullet: text, row: `Landed: ${text}` };
    }),
  ];
}

/** Each entry as one line, list by list — a deviation as `Deviation: from → to
 *  — why`, a follow-up as `what — where`, an unproven criterion as `Unproven:
 *  criterion — why`, a landed part as `Landed: what — where` — the same words
 *  the ledger rows carry, for a reader that wants the handoff as plain lines
 *  (the thread's artifacts block). Empty for an empty handoff. */
export function handoffLines(h: Handoff): string[] {
  return entryLines(h).map((e) => e.row);
}

function prLink(pr: HandoffRenderContext["pr"]): string | undefined {
  return pr ? `[#${pr.number}](${pr.url})` : undefined;
}

/**
 * The rows a person pastes into the plan's follow-ups ledger — one per entry,
 * in the ledger's shape `| Follow-up | Source | Disposition |`, the source
 * naming the unit's handoff and its pull request, the disposition `open` until
 * a person decides. Empty string for an empty handoff.
 */
export function renderHandoffLedgerRows(h: Handoff, ctx: HandoffRenderContext): string {
  const link = prLink(ctx.pr);
  const source = `${ctx.unitId} handoff${link ? ` (${link})` : ""}`;
  return entryLines(h)
    .map((e) => `| ${cell(e.row)} | ${cell(source)} | open |`)
    .join("\n");
}

const HEADINGS: Readonly<Record<ListKey, string>> = {
  deviations: "### Deviations",
  followUps: "### Follow-ups",
  unproven: "### Unproven",
  landed: "### Already landed",
};

/**
 * The comment the parent posts on the unit's board issue: the unit id and the
 * pull request in the first line, each non-empty list under its own heading,
 * then the ledger rows in a fenced block a person pastes into the plan while
 * it is `proposed`. An empty list is omitted with its heading; an entirely
 * empty handoff renders nothing — there is nothing for a person to decide.
 * The same object renders to the same bytes.
 */
export function renderHandoffComment(h: Handoff, ctx: HandoffRenderContext): string | undefined {
  if (isEmptyHandoff(h)) return undefined;
  const link = prLink(ctx.pr);
  const parts: string[] = [`**Handoff — ${ctx.unitId}** · ${link ? `pull request ${link}` : "no pull request"}`];
  const lines = entryLines(h);
  for (const key of LISTS) {
    const bullets = lines.filter((e) => e.list === key).map((e) => `- ${line(e.bullet)}`);
    if (bullets.length > 0) parts.push(`${HEADINGS[key]}\n\n${bullets.join("\n")}`);
  }
  parts.push(
    "### Ledger rows\n\n" +
      "Paste into the plan's follow-ups ledger while the plan is `proposed`; a person decides each disposition.\n\n" +
      `\`\`\`markdown\n${HANDOFF_LEDGER_HEADER}\n${renderHandoffLedgerRows(h, ctx)}\n\`\`\``,
  );
  return parts.join("\n\n");
}
