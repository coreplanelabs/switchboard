// Records — the decision records under docs/decisions/ and the dated plans under
// docs/plans/ — are written once and never edited: a record that no longer
// holds is superseded by a new one, so the reasoning that was current at the
// time is never lost. Two things keep that true by a check rather than by
// discipline (docs/reference/specs/docs-site.md item 16). Every record carries a `status`
// from a closed set (and a `superseded_by` that resolves when it is
// superseded), so a record whose state nobody wrote down is a failing build,
// not a document of unknown standing. And once a record is accepted, its body
// is frozen: the check diffs it against the copy on the base branch and fails
// on any change other than the status lines — or on the record being gone —
// naming the file and telling you to supersede it.
//
// Pure: records in, problems out. The host (scripts/decisions-check.ts) reads
// the tree and the base; the docs generator reads frontmatter through
// parseFrontmatter for the Design decisions index.

import { dirname, join } from "node:path";

export const RECORD_DIRS = ["docs/decisions", "docs/plans"] as const;
export const STATUSES = ["proposed", "accepted", "implemented", "superseded"] as const;
/** The frontmatter keys a record may change after acceptance. */
export const MUTABLE_KEYS = ["status", "superseded_by"] as const;

export interface Frontmatter {
  fields: Record<string, string> | null;
  body: string;
}
export interface RecordText {
  /** Repo-relative path, e.g. `docs/decisions/0001-seams-with-two-implementations.md`. */
  path: string;
  text: string;
}
export interface RecordProblem {
  path: string;
  what: string;
}

/**
 * A record's frontmatter (the `key: value` lines between the leading `---`
 * fences) and its body (everything after). No frontmatter → `fields` is null
 * and the body is the whole text.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.split("\n");
  if (lines[0] !== "---") return { fields: null, body: text };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { fields: null, body: text };
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

/** The frontmatter without the keys a record may change after acceptance — what must not move. */
export function frozenFrontmatter(fields: Record<string, string> | null | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields ?? {}).filter(([k]) => !(MUTABLE_KEYS as readonly string[]).includes(k)),
  );
}

/**
 * What is wrong with a set of records' standing. `exists(path)` answers whether
 * a repo-relative path is a file, for `superseded_by` links.
 */
export function statusProblems(records: readonly RecordText[], exists: (path: string) => boolean): RecordProblem[] {
  const problems: RecordProblem[] = [];
  const say = (path: string, what: string) => problems.push({ path, what });
  const statuses = STATUSES as readonly string[];
  for (const { path, text } of records) {
    const { fields } = parseFrontmatter(text);
    if (!fields) {
      say(path, "has no frontmatter — a record needs `status:` (and `date:`)");
      continue;
    }
    const status = fields.status;
    if (status === undefined) say(path, `has no \`status:\` — one of ${STATUSES.join(" | ")}`);
    else if (!statuses.includes(status)) say(path, `status "${status}" is not one of ${STATUSES.join(" | ")}`);
    if (!fields.date) say(path, "has no `date:`");
    if (path.startsWith("docs/decisions/") && !fields.title) say(path, "has no `title:`");
    if (status === "superseded") {
      if (!fields.superseded_by) say(path, "is superseded but names no `superseded_by:`");
      else {
        const target = fields.superseded_by.startsWith("docs/")
          ? fields.superseded_by
          : join(dirname(path), fields.superseded_by);
        if (!exists(target)) say(path, `superseded_by "${fields.superseded_by}" does not resolve (${target})`);
        else if (target === path) say(path, "supersedes itself");
      }
    } else if (fields.superseded_by) {
      say(path, `names \`superseded_by:\` but its status is "${status}", not superseded`);
    }
  }
  return problems;
}

/**
 * What changed in records that were already accepted on the base. `base` maps
 * every record on the base branch (repo-relative path → text); a record absent
 * from it is new and free to change. A record whose base status is proposed may
 * change freely; once accepted, implemented or superseded, only the mutable
 * frontmatter keys may differ — and the record must still exist.
 */
export function immutabilityProblems(
  records: readonly RecordText[],
  base: ReadonlyMap<string, string>,
): RecordProblem[] {
  const problems: RecordProblem[] = [];
  for (const { path, text } of records) {
    const before = base.get(path);
    if (before === undefined) continue;
    const was = parseFrontmatter(before);
    if (!was.fields || was.fields.status === undefined || was.fields.status === "proposed") continue;
    const now = parseFrontmatter(text);
    if (!now.fields) {
      problems.push({ path, what: `was ${was.fields.status} and lost its frontmatter` });
      continue;
    }
    if (now.body !== was.body)
      problems.push({
        path,
        what: `was ${was.fields.status} on the base and its body changed — a record is never edited; write a new one and set this one's \`status: superseded\` + \`superseded_by:\``,
      });
    const frozenBefore = JSON.stringify(frozenFrontmatter(was.fields));
    const frozenNow = JSON.stringify(frozenFrontmatter(now.fields));
    if (frozenBefore !== frozenNow)
      problems.push({
        path,
        what: `was ${was.fields.status} on the base and its frontmatter changed beyond ${MUTABLE_KEYS.join("/")}`,
      });
    if (
      (was.fields.status === "implemented" || was.fields.status === "superseded") &&
      now.fields.status !== was.fields.status &&
      !(was.fields.status === "implemented" && now.fields.status === "superseded")
    )
      problems.push({ path, what: `status may not go from ${was.fields.status} back to ${now.fields.status}` });
  }
  // Freezing edits but not removal would leave a hole: deleting (or renaming,
  // which git sees as delete + add) an accepted record must fail the same way.
  const present = new Set(records.map((r) => r.path));
  for (const [path, before] of base) {
    if (present.has(path)) continue;
    const was = parseFrontmatter(before);
    if (!was.fields || was.fields.status === undefined || was.fields.status === "proposed") continue;
    problems.push({
      path,
      what: `was ${was.fields.status} on the base and is gone from the tree — a record is never deleted or renamed; supersede it`,
    });
  }
  return problems;
}
