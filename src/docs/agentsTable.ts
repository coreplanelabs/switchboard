// The AGENTS.md Commands table, as pure functions.
//
// AGENTS.md is the operating contract every agent reads first, so its table of
// commands must be true: every root npm script, what it does, when to run it.
// The script list comes from package.json; the prose comes from project.json's
// `commands` map. `scripts/agents-gen.ts` is the only caller that reads or
// writes files; everything here is string in, string out, so the decisions
// (what a row looks like, what counts as an undocumented script, how big is
// too big) are unit-tested without touching the tree.

/** AGENTS.md is loaded into every agent's context on every task; past this it
 *  stops being an index and starts crowding out the work. */
export const AGENTS_BUDGET_BYTES = 15 * 1024;

/** The generated region's name in AGENTS.md, and the note its opening marker carries. */
export const REGION = "commands";
export const NOTE = "npm run agents:gen — generated from package.json + project.json, do not edit by hand";

export interface CommandDoc {
  does: string;
  when: string;
}

/** Pure: the Markdown table for the scripts, in package.json order. */
export function renderCommandsTable(scripts: Record<string, string>, docs: Record<string, CommandDoc>): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|");
  const rows = Object.keys(scripts).map((name) => {
    const d = docs[name];
    return `| \`npm run ${cell(name)}\` | ${cell(d.does)} | ${cell(d.when)} |`;
  });
  return ["| Command | What it does | When |", "|---|---|---|", ...rows].join("\n");
}

/** Pure: scripts without a description, and descriptions without a script.
 *  A `$`-prefixed key in the docs map is commentary, not a script. */
export function commandDocProblems(scripts: Record<string, string>, docs: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const name of Object.keys(scripts)) {
    const d = docs[name] as Partial<CommandDoc> | undefined;
    if (!d || typeof d.does !== "string" || typeof d.when !== "string") {
      problems.push(`script "${name}" has no { does, when } entry in project.json → commands`);
    }
  }
  for (const name of Object.keys(docs)) {
    if (name.startsWith("$")) continue;
    if (!(name in scripts)) problems.push(`project.json describes "${name}", which is not a script in package.json`);
  }
  return problems;
}

/** Pure: the size problem, if any. */
export function budgetProblem(text: string, budget = AGENTS_BUDGET_BYTES): string | null {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= budget) return null;
  return `AGENTS.md is ${bytes} bytes, over its ${budget}-byte budget — move detail into docs/ and link it`;
}
