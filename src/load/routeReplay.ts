// `load:route` (docs/reference/specs/load-harness.md item 17): the request
// router scored offline against the requests people already typed. A finished
// run whose requester chose the preset themselves — `agent:<preset>` on the
// message, or the thread's sticky preset they typed earlier — is a labelled
// example: the label is the preset the run ran on, the text is the request
// with every directive token hidden, and the router is asked what it would
// have picked. The result is a per-preset confusion table with accuracy and
// the misroutes listed. The compound half (the same item): the router's
// compound form scored on the checked-in set — detected where a request has
// independent parts, kept single on a decoy, each part on its preset — and on
// the history's conductor requests, detection alone, their count printed. Pure
// over records and a `RouteDecision` function; the entrypoint
// (`scripts/load.ts`) pages the run store and picks the model.
import { AGENTS, COMPOUND_PRESET } from "../agents/registry.js";
import { stripDirectiveTokens } from "../directives.js";
import type { RouteDecision } from "../core/dispatch/route.js";
import type { SloCheck } from "./aggregate.js";
import type { RouteCompoundFixture } from "./routeCompoundFixtures.js";
import type { RunRecord } from "../core/runRecord.js";
import type { AgentSource } from "../core/runEvents.js";

/** One labelled request: what was asked, which preset the requester chose. */
export interface ReplayRequest {
  id: string;
  label: string;
  text: string;
  /** How the label is known: the record's `run_meta.agentSource` (`directive`
   *  or `sticky`), or `unstamped` — a record written before that stamp existed,
   *  on a preset other than the deployment's default: the requester may have
   *  typed it, the thread may have carried it, or a channel or user scope's
   *  `agent` may have set it, and the record cannot say which (its `input` is
   *  directive-stripped). Replayed, but reported apart from the accuracy table
   *  and its bar. */
  labelSource: "directive" | "sticky" | "unstamped";
}

/** Why a record was not a labelled request. */
export type SkipReason =
  "unknown-preset" | "child" | "schedule" | "routed" | "not-the-requesters-choice" | "legacy-default" | "no-text";

export interface LabelledRequests {
  requests: ReplayRequest[];
  skipped: Record<SkipReason, number>;
}

const EMPTY_SKIPS = (): Record<SkipReason, number> => ({
  "unknown-preset": 0,
  child: 0,
  schedule: 0,
  routed: 0,
  "not-the-requesters-choice": 0,
  "legacy-default": 0,
  "no-text": 0,
});

function metaSourceOf(record: RunRecord): AgentSource | undefined {
  for (const e of record.events) {
    if (e.type === "run_meta") return e.agentSource;
  }
  return undefined;
}

function inputTextOf(record: RunRecord): string | undefined {
  for (const e of record.events) {
    if (e.type === "input") return e.text;
  }
  return undefined;
}

/**
 * The labelled requests among `records`. A run is labelled when a person chose
 * its preset: `agentSource` `directive` or `sticky` on its `run_meta`, or —
 * for a record written before the stamp — a preset other than `defaultPreset`,
 * labelled `unstamped` (a run on the default preset with no stamp is
 * unlabelled: the requester may have chosen nothing). Never labelled: a run the router chose (its `route`
 * event — the router must not be graded against itself), a child a run
 * spawned (its directive is the parent's), a schedule's run (no person typed
 * it), a run on a preset the registry does not know, a run with no request
 * text. The text is the record's `input` with every directive token hidden,
 * so the router sees exactly what a plain message would have been.
 */
export function labelledRequests(
  records: readonly RunRecord[],
  opts: { defaultPreset: string; presets?: readonly string[] },
): LabelledRequests {
  const presets = opts.presets ?? Object.keys(AGENTS);
  const skipped = EMPTY_SKIPS();
  const requests: ReplayRequest[] = [];
  for (const record of records) {
    const skip = (reason: SkipReason) => void skipped[reason]++;
    if (record.agent === undefined || !presets.includes(record.agent)) {
      skip("unknown-preset");
      continue;
    }
    if (record.parentRunId !== undefined || record.parentInstanceId !== undefined) {
      skip("child");
      continue;
    }
    if (record.userId.startsWith("schedule:")) {
      skip("schedule");
      continue;
    }
    if (record.events.some((e) => e.type === "route")) {
      skip("routed");
      continue;
    }
    const source = metaSourceOf(record);
    let labelSource: ReplayRequest["labelSource"];
    if (source === "directive" || source === "sticky") labelSource = source;
    else if (source !== undefined) {
      skip("not-the-requesters-choice");
      continue;
    } else if (record.agent === opts.defaultPreset) {
      skip("legacy-default");
      continue;
    } else labelSource = "unstamped";
    const raw = inputTextOf(record);
    const text = raw === undefined ? "" : stripDirectiveTokens(raw);
    if (text.length === 0) {
      skip("no-text");
      continue;
    }
    requests.push({ id: record.id, label: record.agent, text, labelSource });
  }
  return { requests, skipped };
}

/** One replayed request: the router's answer beside the label. */
export interface ReplayResult extends ReplayRequest {
  routed: string | undefined;
  reason: string;
  correct: boolean;
  /** Wall time of the router's decision, ms. */
  ms: number;
}

/**
 * Ask the router about each request, `concurrency` at a time, in order. The
 * decision function is the same seam the dispatcher's stage calls (`route`
 * bound to a model); the harness never dispatches anything.
 */
export async function replayRoutes(
  requests: readonly ReplayRequest[],
  decide: (text: string) => Promise<RouteDecision>,
  opts: { concurrency?: number; now: () => number },
): Promise<ReplayResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const { now } = opts;
  const results: ReplayResult[] = new Array<ReplayResult>(requests.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= requests.length) return;
      const request = requests[i];
      const started = now();
      const decision = await decide(request.text);
      results[i] = {
        ...request,
        routed: decision.preset,
        reason: decision.reason,
        correct: decision.preset === request.label,
        ms: Math.max(0, now() - started),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, worker));
  return results;
}

/** A typed label's identity as the registry declares it; `write` for a
 *  preset that pushes (coding, ship). */
const identityOf = (preset: string): string | undefined => AGENTS[preset]?.identity;

/** Record 0026's clause on the router: a request whose typed label is a
 *  read-only preset (identity `none` or `read`) must never be routed to a
 *  write preset. The results that break it — none, or the receipt's verdict
 *  fails. A compound (`conductor`, identity `none`) is not a write route: its
 *  parts meet the same clause as children under the requester's allowlist. */
export function readToWriteRoutes(results: readonly ReplayResult[]): ReplayResult[] {
  return results.filter((r) => {
    const label = identityOf(r.label);
    return (label === "none" || label === "read") && r.routed !== undefined && identityOf(r.routed) === "write";
  });
}

/** One row of the confusion table: a label, how often the router agreed, and where it went instead. */
export interface ConfusionRow {
  label: string;
  n: number;
  correct: number;
  /** `correct / n`; NaN for a label with no requests. */
  accuracy: number;
  /** Requests with this label by the preset the router answered (`(none)` for no route). */
  routedAs: Record<string, number>;
}

export interface ConfusionTable {
  rows: ConfusionRow[];
  total: number;
  correct: number;
  /** `correct / total`; NaN with no requests. */
  accuracy: number;
  misroutes: ReplayResult[];
}

export const NO_ROUTE = "(none)";

/** The confusion table over `results`: one row per label in `presets` order
 *  (a label outside it gets a row at the end), the totals, and every misroute
 *  in replay order. */
export function confusionTable(results: readonly ReplayResult[], presets: readonly string[]): ConfusionTable {
  const labels = [...presets, ...results.map((r) => r.label).filter((l) => !presets.includes(l))].filter(
    (l, i, all) => all.indexOf(l) === i,
  );
  const rows: ConfusionRow[] = labels.map((label) => {
    const mine = results.filter((r) => r.label === label);
    const routedAs: Record<string, number> = {};
    for (const r of mine) {
      const key = r.routed ?? NO_ROUTE;
      routedAs[key] = (routedAs[key] ?? 0) + 1;
    }
    const correct = mine.filter((r) => r.correct).length;
    return { label, n: mine.length, correct, accuracy: mine.length === 0 ? NaN : correct / mine.length, routedAs };
  });
  const correct = results.filter((r) => r.correct).length;
  return {
    rows,
    total: results.length,
    correct,
    accuracy: results.length === 0 ? NaN : correct / results.length,
    misroutes: results.filter((r) => !r.correct),
  };
}

const pct = (n: number) => (Number.isFinite(n) ? `${Math.round(n * 1000) / 10}%` : "—");

/** The table and the misroutes as markdown lines, for the receipt's notes. */
export function renderConfusion(table: ConfusionTable, opts: { textCap?: number } = {}): string[] {
  const cap = opts.textCap ?? 80;
  const snippet = (text: string) => {
    const one = text.replace(/\s+/g, " ").trim();
    return one.length > cap ? `${one.slice(0, cap - 1)}…` : one;
  };
  const lines = [
    `accuracy: ${table.correct}/${table.total} (${pct(table.accuracy)})`,
    "",
    "| label | n | correct | accuracy | routed as |",
    "|---|---|---|---|---|",
    ...table.rows.map(
      (r) =>
        `| ${r.label} | ${r.n} | ${r.correct} | ${pct(r.accuracy)} | ${
          Object.entries(r.routedAs)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}=${v}`)
            .join(" ") || "—"
        } |`,
    ),
    "",
    table.misroutes.length === 0 ? "misroutes: none" : `misroutes (${table.misroutes.length}):`,
    ...table.misroutes.map(
      (m) => `- ${m.id}: label ${m.label}, routed ${m.routed ?? NO_ROUTE} — ${m.reason} — "${snippet(m.text)}"`,
    ),
  ];
  return lines;
}

/** One compound example the router is scored on: a request with the presets a
 *  right split names (two or more, order free), or a decoy — one ask with
 *  several steps — with its one preset. `source` says where it came from: the
 *  checked-in set, or a `conductor` run in the history, whose parts are not on
 *  the record (`presets` empty: detection alone is scored). */
export interface CompoundExample extends RouteCompoundFixture {
  source: "fixture" | "history";
}

/** The checked-in set as examples. */
export function compoundExamples(fixtures: readonly RouteCompoundFixture[]): CompoundExample[] {
  return fixtures.map((f) => ({ ...f, source: "fixture" }));
}

/** The history's compound examples: every labelled request whose requester
 *  typed `agent:conductor` — a person judged it a fan-out — with its parts
 *  unknown. Few, and said so where they are printed. */
export function historyCompounds(requests: readonly ReplayRequest[]): CompoundExample[] {
  return requests
    .filter((r) => r.label === COMPOUND_PRESET)
    .map((r) => ({ id: r.id, kind: "compound", text: r.text, presets: [], source: "history" }));
}

/** One replayed example: the router's answer beside the expectation. */
export interface CompoundResult extends CompoundExample {
  routed: string | undefined;
  reason: string;
  /** The presets of the answer's parts, in answer order; empty for a single route or no route. */
  answered: string[];
  /** The router answered the compound form. */
  detected: boolean;
  /** The expected part presets (0 for a decoy or a history example) and how
   *  many of them the answer's parts cover, as multisets. */
  expectedParts: number;
  matchedParts: number;
  /** Wall time of the router's decision, ms. */
  ms: number;
}

/** How many of `expected` the answer covers: each preset counted as often as
 *  both sides name it. */
function multisetOverlap(expected: readonly string[], answered: readonly string[]): number {
  const left = new Map<string, number>();
  for (const p of answered) left.set(p, (left.get(p) ?? 0) + 1);
  let matched = 0;
  for (const p of expected) {
    const n = left.get(p) ?? 0;
    if (n > 0) {
      matched++;
      left.set(p, n - 1);
    }
  }
  return matched;
}

/**
 * Ask the router about each example, `concurrency` at a time, in order — the
 * same seam `replayRoutes` uses, so the singles and the compounds replay under
 * one prompt. A compound is detected when the answer is the conductor with
 * parts; a decoy expects no detection; the parts are matched as multisets
 * against the expected presets (a compound whose parts are unknown scores
 * detection alone).
 */
export async function replayCompound(
  examples: readonly CompoundExample[],
  decide: (text: string) => Promise<RouteDecision>,
  opts: { concurrency?: number; now: () => number },
): Promise<CompoundResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const { now } = opts;
  const results: CompoundResult[] = new Array<CompoundResult>(examples.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= examples.length) return;
      const example = examples[i];
      const started = now();
      const decision = await decide(example.text);
      const parts = decision.preset === COMPOUND_PRESET && "parts" in decision ? (decision.parts ?? []) : [];
      const answered = parts.map((p) => p.preset);
      const detected = decision.preset === COMPOUND_PRESET && parts.length > 0;
      const expectedParts = example.kind === "compound" ? example.presets.length : 0;
      results[i] = {
        ...example,
        routed: decision.preset,
        reason: decision.reason,
        answered,
        detected,
        expectedParts,
        matchedParts: detected ? multisetOverlap(example.kind === "compound" ? example.presets : [], answered) : 0,
        ms: Math.max(0, now() - started),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, examples.length) }, worker));
  return results;
}

/** The compound score over a set of results: detection on the compounds, the
 *  decoys split, the part presets matched — and every miss, in replay order. */
export interface CompoundScore {
  compounds: number;
  detected: number;
  /** `detected / compounds`; NaN with no compounds. */
  detectionRate: number;
  decoys: number;
  decoysSplit: number;
  expectedParts: number;
  matchedParts: number;
  /** `matchedParts / expectedParts`; NaN with no expected parts. */
  partAccuracy: number;
  /** A compound the router kept single, a decoy it split, or a detected
   *  compound whose parts are not exactly the expected presets. */
  misses: CompoundResult[];
}

/** Whether a result is a miss: a compound not detected, a decoy detected, or a
 *  detected compound with known parts that are not exactly the expected ones. */
function isMiss(r: CompoundResult): boolean {
  if (r.kind === "decoy") return r.detected;
  if (!r.detected) return true;
  return r.expectedParts > 0 && (r.matchedParts < r.expectedParts || r.answered.length !== r.expectedParts);
}

export function compoundScore(results: readonly CompoundResult[]): CompoundScore {
  const compounds = results.filter((r) => r.kind === "compound");
  const decoys = results.filter((r) => r.kind === "decoy");
  const detected = compounds.filter((r) => r.detected).length;
  const expectedParts = compounds.reduce((n, r) => n + r.expectedParts, 0);
  const matchedParts = compounds.reduce((n, r) => n + r.matchedParts, 0);
  return {
    compounds: compounds.length,
    detected,
    detectionRate: compounds.length === 0 ? NaN : detected / compounds.length,
    decoys: decoys.length,
    decoysSplit: decoys.filter((r) => r.detected).length,
    expectedParts,
    matchedParts,
    partAccuracy: expectedParts === 0 ? NaN : matchedParts / expectedParts,
    misses: results.filter(isMiss),
  };
}

/** The compound score and its misses as markdown lines, for the receipt's notes. */
export function renderCompound(score: CompoundScore, opts: { textCap?: number } = {}): string[] {
  const cap = opts.textCap ?? 80;
  const snippet = (text: string) => {
    const one = text.replace(/\s+/g, " ").trim();
    return one.length > cap ? `${one.slice(0, cap - 1)}…` : one;
  };
  const presetsOf = (presets: readonly string[]) => (presets.length > 0 ? presets.join("+") : "(unknown)");
  const answeredOf = (r: CompoundResult) => (r.detected ? r.answered.join("+") : (r.routed ?? NO_ROUTE));
  return [
    `compound: detected ${score.detected}/${score.compounds} (${pct(score.detectionRate)}), decoys split ${score.decoysSplit}/${score.decoys}, part presets ${score.matchedParts}/${score.expectedParts} (${pct(score.partAccuracy)})`,
    "",
    score.misses.length === 0 ? "misses: none" : `misses (${score.misses.length}):`,
    ...score.misses.map(
      (m) =>
        `- ${m.id}: ${m.kind}, expected ${presetsOf(m.presets)}, answered ${answeredOf(m)} — ${m.reason} — "${snippet(m.text)}"`,
    ),
  ];
}

/** What the receipt's verdict is made of. */
export interface RouteCheckInput {
  /** The confusion table over the stamped labels (directive and sticky). */
  table: ConfusionTable;
  /** How many of those the router answered with a preset. */
  answered: number;
  /** `readToWriteRoutes(...)` over the same results, counted. */
  readToWrite: number;
  /** The checked-in compound set's score. */
  compound: CompoundScore;
  compoundBar: { detection: number };
}

/** The check rows: the accuracy bar, every request answered, record 0026's
 *  read-only-to-write clause (a row of its own, so the verdict fails on it
 *  without anyone reading the table), and the compound bars. */
export function routeChecks(input: RouteCheckInput): SloCheck[] {
  const { table, answered, readToWrite, compound, compoundBar } = input;
  const breaks = readToWriteRoutes(table.misroutes).map((r) => r.id);
  return [
    {
      name: "routing accuracy ≥ 95% against the presets people typed (record 0026's bar)",
      pass: table.accuracy >= 0.95,
      actual: Number.isFinite(table.accuracy) ? pct(table.accuracy) : "no labelled requests",
      limit: "≥ 95%",
    },
    {
      name: "every request answered with a preset",
      pass: table.total > 0 && answered === table.total,
      actual: `${answered}/${table.total}`,
      limit: `${table.total}`,
    },
    {
      name: "read-only labels routed to a write preset: 0 (record 0026's clause)",
      pass: readToWrite === 0,
      actual: readToWrite === 0 ? "0" : `${readToWrite} (${breaks.join(", ")})`,
      limit: "0",
    },
    {
      name: `compound detected on ≥ ${Math.round(compoundBar.detection * 100)}% of the checked-in compound asks`,
      pass: compound.detectionRate >= compoundBar.detection,
      actual: `${compound.detected}/${compound.compounds} (${pct(compound.detectionRate)})`,
      limit: `≥ ${Math.round(compoundBar.detection * 100)}%`,
    },
    {
      name: "no decoy split — one ask with several steps stays one route",
      pass: compound.decoysSplit === 0,
      actual: `${compound.decoysSplit}/${compound.decoys}`,
      limit: "0",
    },
  ];
}
