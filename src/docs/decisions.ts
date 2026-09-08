// The Design decisions index (docs/explanation/design-decisions.md) is
// generated from the records' own frontmatter, so a new ADR or a status change
// shows up in the index by `npm run docs:gen` and never by hand — the same
// mechanism as the command tables (regions.ts). Pure: records in, markdown out.

import { parseFrontmatter } from "./records.js";

export interface DecisionRecord {
  /** Repo-relative path, e.g. `docs/decisions/0001-seams-with-two-implementations.md`. */
  path: string;
  text: string;
}

interface Row {
  id: string;
  title: string;
  status: string;
  date: string;
  pattern: string;
  file: string;
  supersededBy: string | undefined;
}

function rowOf(record: DecisionRecord): Row | undefined {
  const { fields } = parseFrontmatter(record.text);
  if (!fields) return undefined;
  const file = record.path.split("/").at(-1) ?? record.path;
  const id = /^(\d{4})-/.exec(file)?.[1] ?? "";
  return {
    id,
    title: fields.title ?? file,
    status: fields.status ?? "",
    date: fields.date ?? "",
    pattern: fields.pattern ?? "",
    file,
    supersededBy: fields.superseded_by,
  };
}

const cell = (s: string) => s.replace(/\|/g, "\\|");

/**
 * The gate accepts `superseded_by` in two forms — a file beside the record or a
 * `docs/`-rooted path — and the index links from docs/explanation/, so both
 * become `../<path under docs/>`, labelled by file name.
 */
function successorLink(supersededBy: string): string {
  const underDocs = supersededBy.startsWith("docs/") ? supersededBy.slice("docs/".length) : `decisions/${supersededBy}`;
  const name = underDocs.split("/").at(-1) ?? underDocs;
  return `[${cell(name)}](../${underDocs})`;
}

/** The index table: one row per record under docs/decisions/, in id order, linking each file. */
export function renderDecisionIndex(records: readonly DecisionRecord[]): string {
  const rows = records
    .filter((r) => r.path.startsWith("docs/decisions/") && !r.path.endsWith("/README.md"))
    .map(rowOf)
    .filter((r): r is Row => r !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
  const lines = ["| # | Decision | Pattern | Status | Date |", "|---|---|---|---|---|"];
  for (const r of rows) {
    const status = r.supersededBy ? `${r.status} → ${successorLink(r.supersededBy)}` : r.status;
    lines.push(
      `| ${r.id} | [${cell(r.title)}](../decisions/${r.file}) | ${cell(r.pattern) || "—"} | ${status} | ${r.date} |`,
    );
  }
  return lines.join("\n");
}
