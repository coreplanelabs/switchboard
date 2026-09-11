// The child contract (docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md,
// docs/reference/specs/agent-ship.md item 13): what a coding child is handed
// for a plan unit, and what the review child checks the diff against. Both
// published accounts of agent-run development find that the instructions
// handed to a worker decide the outcome, and the plan already knows more than
// a task string can carry — so the contract is the unit's own section
// verbatim, the spec rows the unit names with their current proof bindings,
// the target repository's agent rules, and the guards the child may not
// weaken, with the rebase onto the merged parent as its first instruction.
//
// It is a typed object the runner (by hand: `contract render`) builds and
// renders — never assembled by the child, which would choose what to leave
// out — under fixed headings, so the review child can be handed the same
// object and name what the diff did not add. This module is pure: the plan
// and the specs arrive as text through the caller, nothing here reads a disk
// or the network. Over-length is cut by dropping Approach text before spec
// rows, never the other way, and the render says what it dropped.

/** One plan unit: its `### U<n>.` heading to the next `###`/`##` heading. */
export interface ContractUnit {
  /** `U<n>` as the plan's heading spells it; `task` on the compatibility path. */
  id: string;
  title: string;
  /** The section verbatim, heading line included, trailing blank lines and a
   *  closing thematic break dropped. */
  section: string;
  /** The section's `- **Key**:` bullets by key, each body whole (continuation
   *  lines joined with newlines, their common indentation removed). */
  bullets: Readonly<Record<string, string>>;
}

/** A spec row as a unit names it: `<spec>.md item <n>`. */
export interface SpecItemRef {
  spec: string;
  item: number;
}

export interface ContractValidationRow {
  criterion: string;
  proof: string;
}

/** A named spec row resolved against the spec's current text. */
export interface ContractSpecRow extends SpecItemRef {
  /** Whether the spec's text was there to read; false → nothing below is known. */
  specRead: boolean;
  /** The numbered behavior statement verbatim; undefined when the spec was not
   *  readable or has no such item — said in the render, never invented. */
  text: string | undefined;
  /** The validation-table rows whose criterion names this item, with their proof bindings. */
  validation: ContractValidationRow[];
}

export interface AgentRules {
  /** `AGENTS.md`, else `CLAUDE.md` — whichever the repository has at the head. */
  file: string;
  text: string;
}

export interface Guard {
  name: string;
  /** One line: what the guard refuses. */
  refuses: string;
}

export interface ChildContract {
  unit: ContractUnit;
  specRows: ContractSpecRow[];
  /** Absent when the repository has neither rules file. */
  agentRules: AgentRules | undefined;
  guards: readonly Guard[];
  /** The first instruction's names, when the caller knows them: the unit's
   *  branch and the merged parent it is rebased onto. */
  rebase: { branch: string | undefined; onto: string | undefined };
  /** The unit's board issue, when the caller knows it: where the parent posts
   *  the child's handoff (handoff.ts). Absent on a task-string pipeline and on
   *  the by-hand render, whose handoff is recorded on the run only. Never
   *  rendered — the block is the child's brief, and the post is the parent's. */
  issue: { repo: string; number: number } | undefined;
}

/** The guards a child may not weaken (AGENTS.md's Commands table), one line each on what they refuse. */
export const GUARDS: readonly Guard[] = [
  {
    name: "specs:check",
    refuses:
      "a spec whose `file::describe::it` proof names a test that does not exist, or whose Code/Tests header path is gone — a test cannot be renamed or deleted out from under its spec row",
  },
  {
    name: "specs:coverage --test-guard",
    refuses:
      "a deleted test file, a removed test title or an added skip marker in a test file unless a spec covering that file changes in the same range; a lower assertion count or a rename is printed for the reviewer to dispose of",
  },
  {
    name: "hygiene:check",
    refuses:
      "a new imprint in the public tree (a company, a person, a tracker reference, a plan id, a platform id, a date); the recorded list only shrinks",
  },
  {
    name: "decisions:check",
    refuses:
      "a record under docs/decisions or docs/plans without a valid status, a superseded one that names no successor, and any edit to an accepted record's body",
  },
];

export const CONTRACT_HEADING = "## Contract";

/** The fixed sub-headings, in render order. The prompts name them (src/agents/registry.ts). */
export const CONTRACT_SECTION_HEADINGS = {
  firstInstruction: "### First instruction",
  unit: "### Unit",
  specRows: "### Spec rows",
  agentRules: "### Agent rules",
  guards: "### Guards",
} as const;

/** The budget the children render with. Record 0031 lacks the measured
 *  number; this is the backstop until `contract render` has measured real
 *  units: roughly 12k tokens, a fraction of a first turn, with this
 *  repository's rules file (~15k characters) and a long unit both inside it. */
export const DEFAULT_CONTRACT_MAX_CHARS = 48_000;

const UNIT_HEADING = /^### (U\d+)\. (.+?)\s*$/;
const ANY_HEADING = /^#{2,3} /;
const BULLET = /^- \*\*([^*]+)\*\*:(?:\s?(.*))?$/;

/** The unit's section: from its heading line to the line before the next
 *  `##`/`###` heading, trailing blank lines and a closing `---` dropped. */
export function parsePlanUnit(planMarkdown: string, unitId: string): ContractUnit | undefined {
  const lines = planMarkdown.split("\n");
  const start = lines.findIndex((l) => {
    const m = UNIT_HEADING.exec(l);
    return m !== null && m[1] === unitId;
  });
  if (start < 0) return undefined;
  let end = lines.findIndex((l, i) => i > start && ANY_HEADING.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start, end);
  while (body.length > 1 && /^\s*$/.test(body[body.length - 1]!)) body.pop();
  if (body.length > 1 && /^---\s*$/.test(body[body.length - 1]!)) body.pop();
  while (body.length > 1 && /^\s*$/.test(body[body.length - 1]!)) body.pop();
  const heading = UNIT_HEADING.exec(body[0]!)!;
  return { id: heading[1]!, title: heading[2]!, section: body.join("\n"), bullets: parseBullets(body.slice(1)) };
}

/** The ids of every unit heading in the plan, in order. */
export function planUnitIds(planMarkdown: string): string[] {
  return planMarkdown
    .split("\n")
    .map((l) => UNIT_HEADING.exec(l)?.[1])
    .filter((id): id is string => id !== undefined);
}

interface BulletSpan {
  key: string;
  /** Line indices into the section, heading line included: [start, end). */
  start: number;
  end: number;
}

/** Where each `- **Key**:` bullet sits in the section's lines (heading at index 0). */
function bulletSpans(sectionLines: readonly string[]): BulletSpan[] {
  const spans: BulletSpan[] = [];
  for (let i = 1; i < sectionLines.length; i++) {
    const m = BULLET.exec(sectionLines[i]!);
    if (!m) continue;
    if (spans.length > 0) spans[spans.length - 1]!.end = i;
    spans.push({ key: m[1]!, start: i, end: sectionLines.length });
  }
  return spans;
}

function bulletBody(lines: readonly string[]): string {
  const first = BULLET.exec(lines[0]!)!;
  const head = first[2] ?? "";
  const rest = lines.slice(1);
  while (rest.length > 0 && /^\s*$/.test(rest[rest.length - 1]!)) rest.pop();
  if (rest.length === 0) return head.trim();
  const indent = Math.min(...rest.filter((l) => l.trim() !== "").map((l) => /^\s*/.exec(l)![0].length));
  const dedented = rest.map((l) => l.slice(Math.min(indent, /^\s*/.exec(l)![0].length)));
  return [head.trim(), ...dedented].filter((l, i) => i > 0 || l !== "").join("\n");
}

function parseBullets(bodyLines: readonly string[]): Record<string, string> {
  const withHeading = ["", ...bodyLines];
  const out: Record<string, string> = {};
  for (const span of bulletSpans(withHeading)) out[span.key] = bulletBody(withHeading.slice(span.start, span.end));
  return out;
}

// ---- the spec rows a unit names -------------------------------------------------------------------

/** A spec file as a unit may spell it: backticked, path-prefixed, a markdown link, or bare. */
const SPEC_MENTION =
  /`(?:docs\/reference\/specs\/)?([a-z0-9-]+\.md)`|\[([a-z0-9-]+\.md)\]\([^)]*\)|(?<![\w/.-])(?:docs\/reference\/specs\/)?([a-z0-9-]+\.md)(?![\w/])/g;
/** `item 22`, `items 3 and 7`, `items 3, 5, 7`, `items 4–6`, `items 7-9`, `items 2 to 4` (a criterion may
 *  capitalize the word; a spec name never is — `AGENTS.md` is not a spec, so no `i` flag). */
const ITEM_LIST = /\b[Ii]tems?\s+(\d+(?:\s*(?:,|and|&|–|-|to|\/)\s*\d+)*)/g;
/** The mention immediately followed by its item list — an optional parenthetical between. */
const NAMED_REF = new RegExp(`(?:${SPEC_MENTION.source})\\s+(?:\\([^)]*\\)\\s+)?${ITEM_LIST.source}`, "g");

/** `3, 5 and 7` → [3, 5, 7]; `4–6` → [4, 5, 6]. */
function expandItemList(list: string): number[] {
  const out: number[] = [];
  const ranged = /(\d+)\s*(?:–|-|to)\s*(\d+)/g;
  let rest = list;
  for (const m of list.matchAll(ranged)) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (to >= from && to - from <= 100) for (let n = from; n <= to; n++) out.push(n);
    rest = rest.replace(m[0], " ");
  }
  for (const m of rest.matchAll(/\d+/g)) out.push(Number(m[0]));
  return out;
}

/** Any markdown file the section mentions — a spec or not (`AGENTS.md`, `README.md`, a how-to). */
const ANY_MD_MENTION = /(?<![\w/.-])(?:[\w.-]+\/)*([\w.-]+\.md)(?![\w/])/g;

/** The spec name a file mention resolves to: a bare or `docs/reference/specs/`-prefixed
 *  lowercase `<name>.md`; anything else (`AGENTS.md`, `docs/how-to/x.md`) is not a spec. */
function specNameOf(mention: string): string | undefined {
  const m = /^(?:docs\/reference\/specs\/)?([a-z0-9-]+\.md)$/.exec(mention);
  return m?.[1];
}

/** The spec rows the section names, once each, in order of first appearance.
 *  A bare `item N` with no spec beside it is attributed to the nearest
 *  preceding file mention in the section when that is a spec; with none, or
 *  with another file (`AGENTS.md`) nearer, it names nothing. */
export function specItemRefs(section: string): SpecItemRef[] {
  const seen = new Set<string>();
  const refs: SpecItemRef[] = [];
  const add = (spec: string, item: number) => {
    const key = `${spec}#${item}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ spec, item });
  };
  const named: Array<{ index: number; end: number; spec: string; items: number[] }> = [];
  for (const m of section.matchAll(NAMED_REF)) {
    const spec = m[1] ?? m[2] ?? m[3]!;
    named.push({ index: m.index, end: m.index + m[0].length, spec, items: expandItemList(m[4]!) });
  }
  const mentions = [...section.matchAll(ANY_MD_MENTION)].map((m) => ({ index: m.index, spec: specNameOf(m[0]) }));
  // Every item list in the section, in order: a list inside a named reference
  // belongs to that spec; a bare one to the nearest spec mentioned before it.
  const bare: Array<{ index: number; items: number[] }> = [];
  for (const m of section.matchAll(ITEM_LIST)) {
    if (named.some((n) => m.index >= n.index && m.index < n.end)) continue;
    bare.push({ index: m.index, items: expandItemList(m[1]!) });
  }
  const all = [
    ...named.map((n) => ({ index: n.index, spec: n.spec as string | undefined, items: n.items })),
    ...bare.map((b) => ({
      index: b.index,
      spec: mentions.filter((x) => x.index < b.index).at(-1)?.spec,
      items: b.items,
    })),
  ].sort((a, b) => a.index - b.index);
  for (const ref of all) if (ref.spec !== undefined) for (const item of ref.items) add(ref.spec, item);
  return refs;
}

// ---- a spec's items and validation rows -----------------------------------------------------------

const SPEC_ITEM = /^(\d+)\. /;

/** A numbered item: its `N.` line to the next item or heading, trailing blank lines dropped. */
export function parseSpecItem(specMarkdown: string, item: number): string | undefined {
  const lines = specMarkdown.split("\n");
  const start = lines.findIndex((l) => Number(SPEC_ITEM.exec(l)?.[1]) === item);
  if (start < 0) return undefined;
  let end = lines.findIndex((l, i) => i > start && (SPEC_ITEM.test(l) || /^#{1,3} /.test(l)));
  if (end < 0) end = lines.length;
  const body = lines.slice(start, end);
  while (body.length > 1 && /^\s*$/.test(body[body.length - 1]!)) body.pop();
  return body.join("\n");
}

/** The rows of the spec's validation table: `| criterion | proof |`, header and separator excluded. */
export function parseValidationRows(specMarkdown: string): ContractValidationRow[] {
  const rows: ContractValidationRow[] = [];
  for (const line of specMarkdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    if (/^-+$/.test(cells[0]!) || (cells[0] === "Criterion" && cells[1] === "Proof")) continue;
    rows.push({ criterion: cells[0]!, proof: cells.slice(1).join(" | ") });
  }
  return rows;
}

/** The item numbers a criterion names: a leading `N:`, `item N`, `items A, B and C`, an `A–B` range. */
export function itemNumbersNamed(criterion: string): Set<number> {
  const out = new Set<number>();
  const lead = /^(\d+(?:\s*[,/]\s*\d+)*)\s*:/.exec(criterion);
  if (lead) for (const n of expandItemList(lead[1]!)) out.add(n);
  for (const m of criterion.matchAll(ITEM_LIST)) for (const n of expandItemList(m[1]!)) out.add(n);
  return out;
}

/** One named row against the spec's text (undefined when the spec was not readable). */
export function resolveSpecRow(ref: SpecItemRef, specMarkdown: string | undefined): ContractSpecRow {
  if (specMarkdown === undefined) return { ...ref, specRead: false, text: undefined, validation: [] };
  return {
    ...ref,
    specRead: true,
    text: parseSpecItem(specMarkdown, ref.item),
    validation: parseValidationRows(specMarkdown).filter((row) => itemNumbersNamed(row.criterion).has(ref.item)),
  };
}

// ---- the builders ----------------------------------------------------------------------------------

export interface ContractFromPlanInput {
  planMarkdown: string;
  unitId: string;
  /** The spec's text by file name (`resident-repos.md`); undefined when it is not there. */
  readSpec: (spec: string) => string | undefined;
  agentRules?: AgentRules;
  rebase?: { branch?: string; onto?: string };
  /** The unit's board issue, when the caller knows it (the runner; a test). */
  issue?: { repo: string; number: number };
}

/** The contract for one unit of a plan. Throws when the plan has no such unit. */
export function contractFromPlan(input: ContractFromPlanInput): ChildContract {
  const unit = parsePlanUnit(input.planMarkdown, input.unitId);
  if (!unit) {
    const ids = planUnitIds(input.planMarkdown);
    throw new Error(
      `the plan has no unit ${input.unitId} (its units: ${ids.length > 0 ? ids.join(", ") : "none — no `### U<n>.` heading"})`,
    );
  }
  return {
    unit,
    specRows: specItemRefs(unit.section).map((ref) => resolveSpecRow(ref, input.readSpec(ref.spec))),
    agentRules: input.agentRules,
    guards: GUARDS,
    rebase: { branch: input.rebase?.branch, onto: input.rebase?.onto },
    issue: input.issue,
  };
}

const TITLE_MAX = 80;

/** The compatibility path record 0031 names: a task string is a plan of one
 *  unit with no spec rows. The task is the unit's whole section. */
export function contractFromTask(input: {
  task: string;
  agentRules?: AgentRules;
  rebase?: { branch?: string; onto?: string };
  issue?: { repo: string; number: number };
}): ChildContract {
  const firstLine =
    input.task
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  const title = firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 1).trimEnd()}…` : firstLine;
  return {
    unit: { id: "task", title, section: input.task, bullets: {} },
    specRows: [],
    agentRules: input.agentRules,
    guards: GUARDS,
    rebase: { branch: input.rebase?.branch, onto: input.rebase?.onto },
    issue: input.issue,
  };
}

// ---- the render --------------------------------------------------------------------------------------

/** What a cut can drop, in the order it drops them: the unit's Approach text,
 *  the agent rules, the spec items' behavior text (their proof rows stay),
 *  then the proof rows too (the rows' names stay). */
export type DroppedPart = "approach" | "agentRules" | "specText" | "specRows";

export interface RenderedContract {
  text: string;
  /** `text.length` — the number record 0031 lacks, measured per render. */
  chars: number;
  dropped: DroppedPart[];
  /** True when the text is still longer than the budget after every cut; the
   *  render never truncates the unit's own text or the guards. */
  overBudget: boolean;
}

const APPROACH_DROPPED = "- **Approach**: (dropped to fit the contract's budget — read it in the plan)";

/** The unit's body without its heading line; with `dropApproach`, the
 *  Approach bullet's lines replaced by one placeholder line. */
function unitBody(unit: ContractUnit, dropApproach: boolean): string {
  const lines = unit.section.split("\n");
  if (dropApproach) {
    const span = bulletSpans(lines).find((s) => s.key === "Approach");
    if (span) lines.splice(span.start, span.end - span.start, APPROACH_DROPPED);
  }
  return lines.slice(1).join("\n").trim();
}

function hasApproach(unit: ContractUnit): boolean {
  return "Approach" in unit.bullets;
}

function renderFirstInstruction(rebase: ChildContract["rebase"]): string {
  const branch = rebase.branch ? `\`${rebase.branch}\`` : "the unit's branch";
  const onto = rebase.onto ? `\`${rebase.onto}\`` : "the merged parent";
  return (
    `Rebase ${branch} onto ${onto} before any other work — the parent unit has merged and the base has moved; ` +
    `the only writes are your own on that branch. A conflict ends the unit: report it as the handoff and stop.`
  );
}

function renderSpecRow(row: ContractSpecRow, dropText: boolean): string {
  const head = `#### ${row.spec} item ${row.item}`;
  if (!row.specRead) return `${head}\n\n(not found: no spec ${row.spec} was readable)`;
  if (row.text === undefined) return `${head}\n\n(not found: ${row.spec} has no item ${row.item})`;
  const text = dropText ? `(text dropped — read item ${row.item} in the spec)` : row.text;
  const rows =
    row.validation.length === 0
      ? `(no validation row names item ${row.item})`
      : ["| Criterion | Proof |", "|---|---|", ...row.validation.map((r) => `| ${r.criterion} | ${r.proof} |`)].join(
          "\n",
        );
  return `${head}\n\n${text}\n\n${rows}`;
}

function renderSpecRows(rows: ContractSpecRow[], dropped: { text: boolean; rows: boolean }): string {
  if (rows.length === 0)
    return "(none — the unit names no spec rows; until decided, a unit naming none receives none, not the covering specs' rows by path)";
  if (dropped.rows) return rows.map((r) => `- ${r.spec} item ${r.item}`).join("\n");
  return rows.map((r) => renderSpecRow(r, dropped.text)).join("\n\n");
}

function renderAgentRules(rules: AgentRules | undefined, dropped: boolean): string {
  if (!rules) return "(none — the repository has neither AGENTS.md nor CLAUDE.md)";
  if (dropped)
    return `Source: ${rules.file}\n\n(dropped to fit the contract's budget — read ${rules.file} at the head)`;
  return `Source: ${rules.file}\n\n${rules.text.trim()}`;
}

function renderGuards(guards: readonly Guard[]): string {
  return [
    "Never weaken a guard: each refuses one class of change, and the review runs them over your range.",
    ...guards.map((g) => `- \`${g.name}\` — ${g.refuses}`),
  ].join("\n");
}

const DROP_NOTE: Readonly<Record<DroppedPart, string>> = {
  approach: "the unit's Approach text was dropped (read it in the plan)",
  agentRules: "the agent rules were dropped (read the file at the head)",
  specText: "the spec items' text was dropped (read them in the specs; their proof rows stay)",
  specRows: "the spec rows' proof rows were dropped too (their names stay above)",
};

/**
 * The block a child's turn carries. `maxChars` (default
 * `DEFAULT_CONTRACT_MAX_CHARS`) is the budget: over it, the Approach text goes
 * first, then the agent rules, then the spec items' behavior text, then their
 * proof rows — never spec rows before Approach — each leaving a placeholder,
 * and a closing line says what was dropped. The unit's other bullets (its test
 * scenarios above all), the spec rows' names and the guards are never cut;
 * `overBudget` says when they alone exceed the budget.
 */
export function renderContract(contract: ChildContract, opts: { maxChars?: number }): RenderedContract {
  const maxChars = opts.maxChars ?? DEFAULT_CONTRACT_MAX_CHARS;
  const hasSpecText = contract.specRows.some((r) => r.text !== undefined);
  const ladder: Array<{ part: DroppedPart; present: boolean }> = [
    { part: "approach", present: hasApproach(contract.unit) },
    { part: "agentRules", present: contract.agentRules !== undefined },
    { part: "specText", present: hasSpecText },
    { part: "specRows", present: contract.specRows.length > 0 },
  ];
  const compose = (dropped: DroppedPart[]): string => {
    const has = (p: DroppedPart) => dropped.includes(p);
    const parts = [
      CONTRACT_HEADING,
      `${CONTRACT_SECTION_HEADINGS.firstInstruction}\n\n${renderFirstInstruction(contract.rebase)}`,
      `${CONTRACT_SECTION_HEADINGS.unit} ${contract.unit.id} — ${contract.unit.title}\n\n${unitBody(contract.unit, has("approach"))}`,
      `${CONTRACT_SECTION_HEADINGS.specRows}\n\n${renderSpecRows(contract.specRows, { text: has("specText"), rows: has("specRows") })}`,
      `${CONTRACT_SECTION_HEADINGS.agentRules}\n\n${renderAgentRules(contract.agentRules, has("agentRules"))}`,
      `${CONTRACT_SECTION_HEADINGS.guards}\n\n${renderGuards(contract.guards)}`,
    ];
    if (dropped.length > 0)
      parts.push(`Cut to fit ${maxChars} characters: ${dropped.map((p) => DROP_NOTE[p]).join("; ")}.`);
    return parts.join("\n\n");
  };
  const dropped: DroppedPart[] = [];
  let text = compose(dropped);
  for (const step of ladder) {
    if (text.length <= maxChars) break;
    if (!step.present) continue;
    dropped.push(step.part);
    text = compose(dropped);
  }
  return { text, chars: text.length, dropped, overBudget: text.length > maxChars };
}
