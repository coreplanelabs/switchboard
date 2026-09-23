// The twelve user nouns, as typed rows — the source of the vocabulary table.
//
// docs/reference/vocabulary.md's noun table is a generated region rendered
// from this list, the way the reference tables come from the command registry
// (`reference.ts`): a hand-written copy of the carrying types can only rot.
// Each row's "Carried by" cell references its type through `Carriers`, keyed
// by the type's own name and built from `import type` references — so renaming
// or deleting a carrying type fails the typecheck here, and a stale or
// hand-edited table fails `docs:check` naming the file.
//
// Pure: rows in, markdown out. No fs, no clock.
import type { Grant, Preset, RoundKind } from "../core/budgets.js";
import type { CoordinatorInstance, CoordinatorUnit } from "../core/coordinator/contract.js";
import type { PlanePullRequestRow } from "../core/plane/table.js";
import type { ReviewVerdict } from "../core/reviewVerdict.js";
import type { RunRecord } from "../core/runRecord.js";
import type { RunSummary } from "../core/runRegistry/projections.js";
import { RUN_LIVE_STATE_NAMES, type RunLiveState } from "../core/runLiveState.js";
import { liveStateWords } from "../core/plane/decide.js";
import type { UnitEnding } from "../core/ship/coordinator.js";
import type { FollowUpInput } from "../core/threadAdmission.js";
import type { ChannelIO, StatusHandle, StatusUpdate } from "../core/types.js";
import { cell } from "./reference.js";

/** Every carrying type, keyed by its own name. The values are the imported
 *  types themselves, so a rename or deletion in the code fails to compile on
 *  this interface — the binding the vocabulary page's rows rely on. The key
 *  must read exactly as the type it carries; a row can only name a key. */
interface Carriers {
  RunSummary: RunSummary;
  RunRecord: RunRecord;
  RunLiveState: RunLiveState;
  Preset: Preset;
  CoordinatorInstance: CoordinatorInstance;
  CoordinatorUnit: CoordinatorUnit;
  RoundKind: RoundKind;
  Grant: Grant;
  FollowUpInput: FollowUpInput;
  ReviewVerdict: ReviewVerdict;
  UnitEnding: UnitEnding;
  StatusUpdate: StatusUpdate;
  StatusHandle: StatusHandle;
  ChannelIO: ChannelIO;
  PlanePullRequestRow: PlanePullRequestRow;
}

export type CarrierName = keyof Carriers;

/** One type-checked reference inside a "Carried by" cell: the type's name
 *  (constrained to the imported set) and, when the cell states it, the file
 *  the type lives in. Renders as `` `Name` `` or `` `Name` (`path`) ``. */
export interface CarrierRef {
  type: CarrierName;
  path?: string;
}

/** A "Carried by" cell is prose interleaved with type references, so the prose
 *  can say HOW the type carries the noun ("the thread key on …") while every
 *  type name stays a checked reference rather than a string that can drift. */
export type CarriedBy = ReadonlyArray<string | CarrierRef>;

/** One noun of the vocabulary page, in the record's five-fact schema. */
export interface VocabularyRow {
  noun: string;
  /** The `<a id>` the specs deep-link (`vocabulary.md#<anchor>`). */
  anchor: string;
  meaning: string;
  holds: string;
  belongsTo: string;
  carriedBy: CarriedBy;
  printedBy: string;
}

const ref = (type: CarrierName, path?: string): CarrierRef => (path === undefined ? { type } : { type, path });

/** The twelve nouns in the schema's order — record 0066's table, one row each. */
export const VOCABULARY_ROWS: readonly VocabularyRow[] = [
  {
    noun: "thread",
    anchor: "thread",
    meaning:
      "Where you talk — a Slack thread or a web thread. One live model run at a time; a pipeline's own hosted run occupies no thread.",
    holds: "runs",
    belongsTo: "a channel",
    carriedBy: ["the thread key on ", ref("RunSummary", "src/core/runRegistry/projections.ts")],
    printedBy: "cards and replies, the web rail's Threads list, the runs index",
  },
  {
    noun: "run",
    anchor: "run",
    meaning: "One piece of work: one request, one agent, one outcome. A pipeline is a run.",
    holds: "its events and outcome",
    belongsTo: "one thread",
    carriedBy: [ref("RunRecord", "src/core/runRecord.ts")],
    printedBy: "the run page, the runs index, cards",
  },
  {
    noun: "agent",
    anchor: "agent",
    meaning: "The kind of run: general, coding, review, ship, research, explore, conductor.",
    holds: "—",
    belongsTo: "a run",
    carriedBy: [ref("Preset", "src/core/budgets.ts")],
    printedBy: "cards, the runs index, command summaries",
  },
  {
    noun: "pipeline",
    anchor: "pipeline",
    meaning: "Ship's job on a plan: asked in one thread, ending with a report there.",
    holds: "units",
    belongsTo: "the asking thread",
    carriedBy: [ref("CoordinatorInstance", "src/core/coordinator/contract.ts")],
    printedBy: "the asking thread's card, the run page's unit lineage, the unit page",
  },
  {
    noun: "unit",
    anchor: "unit",
    meaning: "One deliverable of a pipeline: its own branch, its own pull request, its own thread.",
    holds: "rounds",
    belongsTo: "a pipeline",
    carriedBy: [ref("CoordinatorUnit", "src/core/coordinator/contract.ts")],
    printedBy: "the unit page, the `runs unit` summary, the plane table",
  },
  {
    noun: "round",
    anchor: "round",
    meaning:
      "One pass over a unit — coding, review, findings or merge; the first three spawn child runs, the merge round waits on the guards.",
    holds: "a child run (except merge)",
    belongsTo: "a unit",
    carriedBy: [ref("RoundKind", "src/core/budgets.ts")],
    printedBy: "the unit page's runs-by-round list, cards",
  },
  {
    noun: "budget",
    anchor: "budget",
    meaning: "The minutes a run, a unit or a pipeline may spend; renewable.",
    holds: "minutes and renewals",
    belongsTo: "a run, a unit or a pipeline",
    carriedBy: [ref("Grant"), " and the lease arithmetic (`src/core/budgets.ts`)"],
    printedBy: "cards, the run page",
  },
  {
    noun: "follow-up",
    anchor: "follow-up",
    meaning: "A reply in a thread, during or after a run.",
    holds: "—",
    belongsTo: "a thread",
    carriedBy: [ref("FollowUpInput", "src/core/threadAdmission.ts")],
    printedBy: "cards, replies",
  },
  {
    noun: "verdict",
    anchor: "verdict",
    meaning: "The review's findings joined with the checks at the reviewed head.",
    holds: "findings and check results",
    belongsTo: "a review round",
    carriedBy: [ref("ReviewVerdict", "src/core/reviewVerdict.ts")],
    printedBy: "review replies, the unit page",
  },
  {
    noun: "outcome",
    anchor: "outcome",
    meaning:
      "How a run or a unit stands once it is not working — ended or idle; merged, merge-ready, idle, failed, stopped are its values.",
    holds: "its value",
    belongsTo: "a run or a unit",
    carriedBy: [ref("UnitEnding", "src/core/ship/coordinator.ts"), ", the status on ", ref("RunSummary")],
    printedBy: "cards, the runs index, the plane table",
  },
  {
    noun: "card",
    anchor: "card",
    meaning: "The message Switchboard keeps updating in a thread for a run.",
    holds: "the run's live status",
    belongsTo: "a thread",
    carriedBy: [ref("StatusUpdate"), "/", ref("StatusHandle"), " on ", ref("ChannelIO", "src/core/types.ts")],
    printedBy: "the thread itself — Slack and web",
  },
  {
    noun: "pull request",
    anchor: "pull-request",
    meaning: "GitHub's own noun, unchanged.",
    holds: "—",
    belongsTo: "a unit",
    carriedBy: [
      "the pull request fields on ",
      ref("CoordinatorUnit"),
      "; ",
      ref("PlanePullRequestRow", "src/core/plane/table.ts"),
    ],
    printedBy: "the unit page, the plane table, the delivery report",
  },
];

function renderCarriedBy(parts: CarriedBy): string {
  return parts
    .map((p) => (typeof p === "string" ? p : p.path === undefined ? `\`${p.type}\`` : `\`${p.type}\` (\`${p.path}\`)`))
    .join("");
}

/** The noun table, one row per entry in the order given. */
export function renderVocabularyTable(rows: readonly VocabularyRow[]): string {
  const lines = [
    "| Noun | Meaning | Holds | Belongs to | Carried by | Printed by |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) =>
      [
        "",
        `<a id="${r.anchor}"></a>**${cell(r.noun)}**`,
        cell(r.meaning),
        cell(r.holds),
        cell(r.belongsTo),
        cell(renderCarriedBy(r.carriedBy)),
        cell(r.printedBy),
        "",
      ]
        .join(" | ")
        .trim(),
    ),
  ];
  return lines.join("\n");
}

/** The run noun's closed live-condition values and their sole user wording. */
export function renderLiveStateValues(): string {
  return [
    "| Value | User wording | Carried by |",
    "| --- | --- | --- |",
    ...RUN_LIVE_STATE_NAMES.map(
      (state) =>
        `| \`${cell(state)}\` | ${cell(liveStateWords(state))} | \`RunLiveState\` (\`src/core/runLiveState.ts\`) |`,
    ),
  ].join("\n");
}

/** The note in the region's opening marker: what writes it, so a reader of the raw markdown edits the source. */
export const VOCABULARY_REGION_NOTE = "npm run docs:gen — rendered from src/docs/vocabulary.ts, do not edit by hand";

/** File (relative to `docs/`) → region → renderer over the rows. */
export const VOCABULARY_REGIONS: Readonly<
  Record<string, Readonly<Record<string, (rows: readonly VocabularyRow[]) => string>>>
> = {
  "reference/vocabulary.md": {
    "vocabulary-nouns": renderVocabularyTable,
    "run-live-state-values": () => renderLiveStateValues(),
  },
};
