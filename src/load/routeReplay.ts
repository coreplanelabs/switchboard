// `load:route` (docs/reference/specs/load-harness.md item 17): the request
// router scored offline against the requests people already typed. A finished
// run whose requester chose the preset themselves — `agent:<preset>` on the
// message, or the thread's sticky preset they typed earlier — is a labelled
// example: the label is the preset the run ran on, the text is the request
// with every directive token hidden, and the router is asked what it would
// have picked. The result is a per-preset confusion table with accuracy and
// the misroutes listed. The compound half (the same item): the router's
// compound form scored on the checked-in set — detected where a request has
// independent read parts, collapsed to its write preset where a part needs
// one (record 0034: a write ask is never a part), kept single on a decoy,
// each part on its preset — and on the history's conductor requests,
// detection alone, their count printed. The
// imperative half (the same item): the checked-in set of terse imperatives —
// an order to change code with no detail to route on — scored on reaching the
// write preset, its read-only look-alikes on never reaching one. The command
// half (the same item): the checked-in command set bound and parsed, never
// invoked; under `--verify`, one more call on every bind of a write- or
// destructive-class command (record 0044's verifier), scored as write
// misbinds removed and correct binds rejected. Pure over
// records and a `RouteDecision` function; the entrypoint (`scripts/load.ts`)
// pages the run store and picks the model.
import { AGENTS, COMPOUND_PRESET } from "../agents/registry.js";
import { stripDirectiveTokens } from "../directives.js";
import { blastRadius, parseInput, type CommandDef, type CommandInput } from "../core/commandRegistry.js";
import { chatInvocation } from "../core/commandSurface.js";
import type { Provider } from "../core/provider.js";
import { oneLine, redactAndCap } from "../core/redact.js";
import {
  parseVerifierAnswer,
  ROUTE_MIN_OUTPUT_TOKENS,
  ROUTE_REASON_CAP,
  ROUTE_TIMEOUT_MS,
  verifierPrompt,
  type RouteDecision,
  type RouteInput,
  type RouteModel,
  type VerifierAnswer,
} from "../core/dispatch/route.js";
import type { SloCheck } from "./aggregate.js";
import type { RouteCompoundFixture } from "./routeCompoundFixtures.js";
import type { RouteCommandExample } from "./routeCommandFixtures.js";
import type { RouteImperativeFixture } from "./routeImperativeFixtures.js";
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
   *  directive-stripped). Only a `directive` label was typed for the message
   *  itself (`typedLabels`): a `sticky` one is the thread's preset carried onto
   *  a later message, so it and `unstamped` are replayed but reported apart
   *  from the accuracy table, its bar and the read-only-to-write clause. */
  labelSource: "directive" | "sticky" | "unstamped";
}

/** The requests the confusion table and record 0026's clause are scored on:
 *  the ones whose preset was typed for that message (`directive`). A sticky
 *  label is the thread's earlier choice riding a later message — "in one short
 *  paragraph, say what this thread changed" labelled `ship` — so it says
 *  nothing about the router; the replay that moved the write door to `ship`
 *  scored directive labels 246/249 and sticky ones 30/51. */
export function typedLabels<T extends { labelSource: ReplayRequest["labelSource"] }>(requests: readonly T[]): T[] {
  return requests.filter((r) => r.labelSource === "directive");
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

/** The one replay loop every half shares: ask the router about each item's
 *  text, `concurrency` at a time, results in item order, each decision timed.
 *  The decision function is the same seam the dispatcher's stage calls
 *  (`route` bound to a model); the harness never dispatches anything. */
/** The facts a fixture puts on the router's user turn beside its text, as the
 *  route stage puts them there in production: the thread's repository (a
 *  command fixture's `threadRepo`) and the count of conversations the text
 *  links that the bot could quote (an imperative fixture's `references`). */
export type RouteFacts = Pick<RouteInput, "threadRepo" | "references">;

async function decideEach<T extends { text: string }, R>(
  items: readonly T[],
  decide: (text: string, facts?: RouteFacts) => Promise<RouteDecision>,
  opts: { concurrency?: number; now: () => number },
  toResult: (item: T, decision: RouteDecision, ms: number) => R,
  factsOf?: (item: T) => RouteFacts | undefined,
): Promise<R[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const { now } = opts;
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      const started = now();
      const decision = await decide(item.text, factsOf?.(item));
      results[i] = toResult(item, decision, Math.max(0, now() - started));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** Ask the router about each labelled request: the answer beside the label,
 *  correct when they agree. */
export async function replayRoutes(
  requests: readonly ReplayRequest[],
  decide: (text: string) => Promise<RouteDecision>,
  opts: { concurrency?: number; now: () => number },
): Promise<ReplayResult[]> {
  return decideEach(requests, decide, opts, (request, decision, ms) => ({
    ...request,
    routed: decision.preset,
    reason: decision.reason,
    correct: decision.preset === request.label,
    ms,
  }));
}

/** A typed label's identity as the registry declares it; `write` for a
 *  preset that pushes (coding, ship). */
const identityOf = (preset: string): string | undefined => AGENTS[preset]?.identity;

/** The offered table's write preset — the one the imperative bars name and
 *  the historical-label mapping targets; undefined for a table without one. */
export function tableWritePreset(names: readonly string[]): string | undefined {
  return names.find((n) => identityOf(n) === "write");
}

/** Historical labels mapped onto the table's write preset (load-harness item
 *  17): a label whose preset is not in the offered table but shares its
 *  identity with the table's write preset (`coding`, once routable, after
 *  `ship` took its seat) scores as that preset — the requester asked for a
 *  write run, and the table's write door moved under them. The count is
 *  printed beside the table so the mapping is legible on the receipt. */
export function mapHistoricalLabels(
  requests: readonly ReplayRequest[],
  tableNames: readonly string[],
): { requests: ReplayRequest[]; mapped: number } {
  const write = tableWritePreset(tableNames);
  let mapped = 0;
  const out = requests.map((r) => {
    if (write !== undefined && !tableNames.includes(r.label) && identityOf(r.label) === "write") {
      mapped++;
      return { ...r, label: write };
    }
    return r;
  });
  return { requests: out, mapped };
}

/** Record 0026's clause on the router: a request whose typed label is a
 *  read-only preset (identity `none` or `read`) must never be routed to a
 *  write preset. The results that break it — none, or the receipt's verdict
 *  fails. A compound (`conductor`, identity `none`) is not a write route: its
 *  parts meet the same clause as children under the requester's allowlist.
 *  Over the labelled singles alone: a checked-in compound that collapses onto
 *  its write preset is a write label, scored on its own row
 *  (`CompoundScore.collapsed`) and never here. */
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
  /** The example expects a collapse (`collapsesTo`) and the router answered
   *  that preset, single: outright, as the prompt asks, or through the parse's
   *  collapse of a compound answer that named it as a part. */
  collapsed: boolean;
  /** The expected part presets (0 for a decoy, a history example or a
   *  compound that collapses: its parts are never spawned) and how many of
   *  them the answer's parts cover, as multisets. */
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
 * parts; a compound with a write part (`collapsesTo`) is collapsed when the
 * answer is that preset, single; a decoy expects no detection; the parts are
 * matched as multisets against the expected presets (a compound whose parts
 * are unknown scores detection alone; one that collapses has no parts to
 * match).
 */
export async function replayCompound(
  examples: readonly CompoundExample[],
  decide: (text: string) => Promise<RouteDecision>,
  opts: { concurrency?: number; now: () => number },
): Promise<CompoundResult[]> {
  return decideEach(examples, decide, opts, (example, decision, ms) => {
    const parts = decision.preset === COMPOUND_PRESET && "parts" in decision ? (decision.parts ?? []) : [];
    const answered = parts.map((p) => p.preset);
    const detected = decision.preset === COMPOUND_PRESET && parts.length > 0;
    const collapsesTo = example.kind === "compound" ? example.collapsesTo : undefined;
    const expectedParts = example.kind === "compound" && collapsesTo === undefined ? example.presets.length : 0;
    return {
      ...example,
      routed: decision.preset,
      reason: decision.reason,
      answered,
      detected,
      collapsed: collapsesTo !== undefined && decision.preset === collapsesTo,
      expectedParts,
      matchedParts: detected && expectedParts > 0 ? multisetOverlap(example.presets, answered) : 0,
      ms,
    };
  });
}

/** The compound score over a set of results: detection on the compounds to
 *  split, the collapse on the compounds with a write part, the decoys split,
 *  the part presets matched — and every miss, in replay order. */
export interface CompoundScore {
  /** The compounds the router should split: `kind: "compound"` without `collapsesTo`. */
  compounds: number;
  detected: number;
  /** `detected / compounds`; NaN with no compounds. */
  detectionRate: number;
  /** The compounds with a write part (`collapsesTo`), and how many the router
   *  answered as that preset, single. Its own row: a collapse is a write label,
   *  never a read-to-write route. */
  collapseExpected: number;
  collapsed: number;
  decoys: number;
  decoysSplit: number;
  expectedParts: number;
  matchedParts: number;
  /** `matchedParts / expectedParts`; NaN with no expected parts. */
  partAccuracy: number;
  /** A compound the router kept single, a compound with a write part it did
   *  not collapse onto that preset, a decoy it split, or a detected compound
   *  whose parts are not exactly the expected presets. */
  misses: CompoundResult[];
}

/** Whether a result is a miss: a decoy detected, a compound with a write part
 *  not collapsed onto it, a compound to split not detected, or a detected
 *  compound with known parts that are not exactly the expected ones. */
function isMiss(r: CompoundResult): boolean {
  if (r.kind === "decoy") return r.detected;
  if (r.collapsesTo !== undefined) return !r.collapsed;
  if (!r.detected) return true;
  return r.expectedParts > 0 && (r.matchedParts < r.expectedParts || r.answered.length !== r.expectedParts);
}

export function compoundScore(results: readonly CompoundResult[]): CompoundScore {
  const compounds = results.filter((r) => r.kind === "compound" && r.collapsesTo === undefined);
  const collapsing = results.filter((r) => r.kind === "compound" && r.collapsesTo !== undefined);
  const decoys = results.filter((r) => r.kind === "decoy");
  const detected = compounds.filter((r) => r.detected).length;
  const expectedParts = compounds.reduce((n, r) => n + r.expectedParts, 0);
  const matchedParts = compounds.reduce((n, r) => n + r.matchedParts, 0);
  return {
    compounds: compounds.length,
    detected,
    detectionRate: compounds.length === 0 ? NaN : detected / compounds.length,
    collapseExpected: collapsing.length,
    collapsed: collapsing.filter((r) => r.collapsed).length,
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
  const expectedOf = (r: CompoundResult) =>
    r.collapsesTo !== undefined
      ? `${r.collapsesTo} single (a write part among ${r.presets.join("+")})`
      : r.presets.length > 0
        ? r.presets.join("+")
        : "(unknown)";
  const answeredOf = (r: CompoundResult) => (r.detected ? r.answered.join("+") : (r.routed ?? NO_ROUTE));
  return [
    `compound: detected ${score.detected}/${score.compounds} (${pct(score.detectionRate)}), collapsed to its write preset ${score.collapsed}/${score.collapseExpected}, decoys split ${score.decoysSplit}/${score.decoys}, part presets ${score.matchedParts}/${score.expectedParts} (${pct(score.partAccuracy)})`,
    "",
    score.misses.length === 0 ? "misses: none" : `misses (${score.misses.length}):`,
    ...score.misses.map(
      (m) =>
        `- ${m.id}: ${m.kind}, expected ${expectedOf(m)}, answered ${answeredOf(m)} — ${m.reason} — "${snippet(m.text)}"`,
    ),
  ];
}

/** One replayed imperative example: the router's answer beside the presets
 *  that count as right. `hit` — the answer is one of them; `toWrite` — the
 *  answer is a write preset (what a look-alike must never reach). */
export interface ImperativeResult extends RouteImperativeFixture {
  routed: string | undefined;
  reason: string;
  hit: boolean;
  toWrite: boolean;
  /** Wall time of the router's decision, ms. */
  ms: number;
}

/** Ask the router about each example of the imperative set — the same seam
 *  and the same prompt as the singles and the compounds. */
export async function replayImperative(
  examples: readonly RouteImperativeFixture[],
  decide: (text: string, facts?: RouteFacts) => Promise<RouteDecision>,
  opts: { concurrency?: number; now: () => number },
): Promise<ImperativeResult[]> {
  return decideEach(
    examples,
    decide,
    opts,
    (example, decision, ms) => ({
      ...example,
      routed: decision.preset,
      reason: decision.reason,
      hit: decision.preset !== undefined && example.presets.includes(decision.preset),
      toWrite: decision.preset !== undefined && identityOf(decision.preset) === "write",
      ms,
    }),
    // The linked conversations reach the router as the count the route stage
    // puts on the user turn — never the quote, which no stage hands the router.
    (example) => (example.references === undefined ? undefined : { references: example.references }),
  );
}

/** The imperative score: the imperatives that reached the write preset, the
 *  look-alikes (decoys and review-shaped asks) that reached one — the row that
 *  must read 0 — each kind's hits, and every miss in replay order. */
export interface ImperativeScore {
  imperatives: number;
  imperativesHit: number;
  /** `imperativesHit / imperatives`; NaN with no imperatives. */
  hitRate: number;
  /** The decoys and the review-shaped asks together: everything that is not an order to change code. */
  lookalikes: number;
  lookalikesToWrite: number;
  decoys: number;
  decoysHit: number;
  reviews: number;
  reviewsHit: number;
  /** Every example whose answer is outside its expected presets. */
  misses: ImperativeResult[];
}

export function imperativeScore(results: readonly ImperativeResult[]): ImperativeScore {
  const of = (kind: RouteImperativeFixture["kind"]) => results.filter((r) => r.kind === kind);
  const imperatives = of("imperative");
  const decoys = of("decoy");
  const reviews = of("review");
  const lookalikes = [...decoys, ...reviews];
  const hits = (rs: readonly ImperativeResult[]) => rs.filter((r) => r.hit).length;
  return {
    imperatives: imperatives.length,
    imperativesHit: hits(imperatives),
    hitRate: imperatives.length === 0 ? NaN : hits(imperatives) / imperatives.length,
    lookalikes: lookalikes.length,
    lookalikesToWrite: lookalikes.filter((r) => r.toWrite).length,
    decoys: decoys.length,
    decoysHit: hits(decoys),
    reviews: reviews.length,
    reviewsHit: hits(reviews),
    misses: results.filter((r) => !r.hit),
  };
}

/** The imperative score and its misses as markdown lines, for the receipt's notes. */
export function renderImperative(
  score: ImperativeScore,
  opts: { textCap?: number; writePreset?: string } = {},
): string[] {
  const cap = opts.textCap ?? 80;
  const snippet = (text: string) => {
    const one = text.replace(/\s+/g, " ").trim();
    return one.length > cap ? `${one.slice(0, cap - 1)}…` : one;
  };
  return [
    `imperatives: ${score.imperativesHit}/${score.imperatives} to ${opts.writePreset ?? "the write preset"} (${pct(score.hitRate)}); look-alikes to a write preset ${score.lookalikesToWrite}/${score.lookalikes} (decoys ${score.decoysHit}/${score.decoys} read-only as expected, review-shaped ${score.reviewsHit}/${score.reviews} to review)`,
    "",
    score.misses.length === 0 ? "misses: none" : `misses (${score.misses.length}):`,
    ...score.misses.map(
      (m) =>
        `- ${m.id}: ${m.kind}, expected ${m.presets.join(" or ")}, routed ${m.routed ?? NO_ROUTE} — ${m.reason} — "${snippet(m.text)}"`,
    ),
  ];
}

/** One replayed command example: what the router bound beside what the
 *  fixture expects. The replay only binds and parses — nothing is invoked;
 *  the effect decision (run a read, hand back a write) is the dispatcher's. */
export type CommandReplayResult = RouteCommandExample & {
  /** The command the router called, when it called one, and the input it bound. */
  bound?: { id: string; input: CommandInput };
  /** The preset it routed to instead, when it routed. */
  routed: string | undefined;
  reason: string;
  /** A fixture: the right command was called. A decoy: no command outside
   *  `allow` was called (the any-command decoy rule). */
  commandHit: boolean;
  /** A fixture whose command was right: the bound input equals the expected
   *  one after `parseInput` on both sides. Always false on a command miss;
   *  true on a decoy (it has no input to bind). */
  inputHit: boolean;
  /** Wall time of the router's decision, ms. */
  ms: number;
};

/** `parseInput` both sides and compare structurally: the registry's parse
 *  coerces (`"7"` → 7 where the schema says number), so the comparison is over
 *  what a handler would receive, never over the raw spelling. */
function sameAfterParse(cmd: CommandDef<unknown>, expected: CommandInput, bound: CommandInput): boolean {
  const a = parseInput(cmd, expected);
  const b = parseInput(cmd, bound);
  if (!a.ok || !b.ok) return false;
  return stableJson({ args: a.args, options: a.options }) === stableJson({ args: b.args, options: b.options });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * Ask the router about each command example — the same seam as the other
 * halves, plus the fixture's `threadRepo`, which production puts in the user
 * turn as a fact ("run the tests on main" in a repository's thread). The
 * decision is only bound and parsed, never invoked.
 */
export async function replayCommands(
  examples: readonly RouteCommandExample[],
  decide: (text: string, facts?: RouteFacts) => Promise<RouteDecision>,
  opts: { concurrency?: number; now: () => number },
  commands: readonly CommandDef<unknown>[],
): Promise<CommandReplayResult[]> {
  const byId = new Map(commands.map((c) => [c.id, c]));
  return decideEach(
    examples,
    decide,
    opts,
    (example, decision, ms) => {
      const bound = "command" in decision ? decision.command : undefined;
      let commandHit: boolean;
      let inputHit: boolean;
      if (example.kind === "decoy") {
        commandHit = bound === undefined || (example.allow ?? []).includes(bound.id);
        inputHit = commandHit;
      } else {
        commandHit = bound !== undefined && bound.id === example.command;
        const def = byId.get(example.command);
        inputHit =
          commandHit && bound !== undefined && def !== undefined && sameAfterParse(def, example.input, bound.input);
      }
      return {
        ...example,
        ...(bound ? { bound } : {}),
        routed: decision.preset,
        reason: decision.reason,
        commandHit,
        inputHit,
        ms,
      };
    },
    (example) =>
      example.kind === "decoy" || example.threadRepo === undefined ? undefined : { threadRepo: example.threadRepo },
  );
}

/** The command score: the command row (every fixture bound to its command and
 *  no decoy bound outside its `allow` — bar 1.0) and the input row (bound
 *  inputs equal the expected ones after `parseInput` — bar 0.9), and every
 *  miss with the bound and the expected input. */
export interface CommandScore {
  fixtures: number;
  commandHits: number;
  decoys: number;
  /** Decoys bound to a command outside their `allow` list. */
  decoysBound: number;
  /** `(commandHits + decoys not bound) / (fixtures + decoys)`; NaN when empty. */
  commandRate: number;
  inputHits: number;
  /** `inputHits / fixtures`; NaN with no fixtures. */
  inputRate: number;
  misses: CommandReplayResult[];
}

export function commandScore(results: readonly CommandReplayResult[]): CommandScore {
  const fixtures = results.filter((r) => r.kind !== "decoy");
  const decoys = results.filter((r) => r.kind === "decoy");
  const commandHits = fixtures.filter((r) => r.commandHit).length;
  const decoysBound = decoys.filter((r) => !r.commandHit).length;
  const inputHits = fixtures.filter((r) => r.inputHit).length;
  const total = results.length;
  return {
    fixtures: fixtures.length,
    commandHits,
    decoys: decoys.length,
    decoysBound,
    commandRate: total === 0 ? NaN : (commandHits + (decoys.length - decoysBound)) / total,
    inputHits,
    inputRate: fixtures.length === 0 ? NaN : inputHits / fixtures.length,
    misses: results.filter((r) => !r.inputHit),
  };
}

/** The command score and its misses — each with the bound and the expected
 *  input — as markdown lines, for the receipt's notes. */
export function renderCommands(score: CommandScore, opts: { textCap?: number } = {}): string[] {
  const cap = opts.textCap ?? 80;
  const snippet = (text: string) => {
    const one = text.replace(/\s+/g, " ").trim();
    return one.length > cap ? `${one.slice(0, cap - 1)}…` : one;
  };
  const boundOf = (r: CommandReplayResult) =>
    r.bound ? `${r.bound.id} ${stableJson(r.bound.input)}` : (r.routed ?? NO_ROUTE);
  const expectedOf = (r: CommandReplayResult) =>
    r.kind === "decoy"
      ? `no command${r.allow ? ` (or ${r.allow.join("/")})` : ""}`
      : `${r.command} ${stableJson(r.input)}`;
  return [
    `commands: bound right ${score.commandHits}/${score.fixtures} (${pct(score.commandRate)} with decoys), inputs right ${score.inputHits}/${score.fixtures} (${pct(score.inputRate)}), decoys bound ${score.decoysBound}/${score.decoys}`,
    "",
    score.misses.length === 0 ? "misses: none" : `misses (${score.misses.length}):`,
    ...score.misses.map(
      (m) =>
        `- ${m.id}: ${m.kind}, expected ${expectedOf(m)}, bound ${boundOf(m)} — ${m.reason} — "${snippet(m.text)}"`,
    ),
  ];
}

/** The verifier's verdict on one write-class bind (record 0044): the answer,
 *  the line it was shown — the bound chat form — and the call's wall time. */
export interface BindVerdict extends VerifierAnswer {
  line: string;
  ms: number;
}

/** A command result with the verifier's verdict where it was asked: a bind
 *  whose command's blast radius is `write` or `destructive` (`verifierAsked`).
 *  A read bind, an exec bind and an example that bound nothing carry none. */
export type VerifiedCommandResult = CommandReplayResult & { verdict?: BindVerdict };

/** Whether the verifier is asked about a bind to `def`: the classes the door
 *  confirms rather than runs — `write` and `destructive` off `blastRadius`
 *  (record 0044); a read and an exec-class write run at once and are never
 *  asked. */
export function verifierAsked(def: Pick<CommandDef<unknown>, "effect" | "action" | "annotations">): boolean {
  const radius = blastRadius(def);
  return radius === "write" || radius === "destructive";
}

/** One verifier call: the sentence and the bound chat form (`chatInvocation`,
 *  the line the person would type, returned as `line`) through the same seam
 *  the router used, so the replay scores the call path the door would make;
 *  the answer read by `parseVerifierAnswer`. A call that fails is a
 *  disagreement with the failure as its reason — the conservative side,
 *  legible on the line. Invokes nothing: the line is text. */
export async function verifyBind(
  text: string,
  def: CommandDef<unknown>,
  input: CommandInput,
  model: RouteModel,
  opts: { timeoutMs?: number } = {},
): Promise<VerifierAnswer & { line: string }> {
  const line = chatInvocation(def, input);
  try {
    const answer = await model(verifierPrompt({ text, line }), {
      maxTokens: ROUTE_MIN_OUTPUT_TOKENS,
      signal: AbortSignal.timeout(opts.timeoutMs ?? ROUTE_TIMEOUT_MS),
    });
    return { ...parseVerifierAnswer(answer), line };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { agrees: false, reason: oneLine(redactAndCap(`verifier failed: ${why}`, ROUTE_REASON_CAP)), line };
  }
}

/**
 * The verifier over the command replay (record 0044; load-harness item 17):
 * asked about every bind of a write- or destructive-class command,
 * `concurrency` at a time, its verdict beside the result in replay order;
 * every other result passes through without one. The class is read off the
 * BOUND command — what would run — never off the fixture's expectation, so a
 * decoy the router bound to a write is asked and a write fixture it bound to
 * a read is not.
 */
export async function verifyCommands(
  results: readonly CommandReplayResult[],
  model: RouteModel,
  commands: readonly CommandDef<unknown>[],
  opts: { concurrency?: number; now: () => number; timeoutMs?: number },
): Promise<VerifiedCommandResult[]> {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const out: VerifiedCommandResult[] = [...results];
  const asked = results.flatMap((r, i) => {
    const def = r.bound === undefined ? undefined : byId.get(r.bound.id);
    return def !== undefined && r.bound !== undefined && verifierAsked(def) ? [{ i, def, input: r.bound.input }] : [];
  });
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const job = asked[next++];
      if (job === undefined) return;
      const result = results[job.i]!;
      const started = opts.now();
      const verdict = await verifyBind(result.text, job.def, job.input, model, opts);
      out[job.i] = { ...result, verdict: { ...verdict, ms: Math.max(0, opts.now() - started) } };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, asked.length) }, worker));
  return out;
}

/** The verifier's two counters over the command replay (record 0044): among
 *  the write-class binds it was asked about, the misbinds — a bind
 *  `commandScore` marks wrong: a wrong command, a right command with the
 *  wrong post-parse input, or a decoy bound outside its `allow` — that it
 *  rejected (**write misbinds removed**), and the correct binds it rejected
 *  (**correct binds rejected**). The two ratios are the terms of the record's
 *  bar; the bar is not judged here — no verdict row — the decision is the
 *  maintainer's. */
export interface VerifierScore {
  /** Write- or destructive-class binds the verifier was asked about. */
  asked: number;
  misbinds: number;
  misbindsRemoved: number;
  /** `misbindsRemoved / misbinds`; NaN with no misbind. */
  removedRate: number;
  correct: number;
  correctRejected: number;
  /** `correctRejected / correct`; NaN with no correct bind. */
  rejectedRate: number;
  /** Every bind the verifier rejected, misbinds and correct ones, in replay order. */
  rejected: VerifiedCommandResult[];
}

export function verifierScore(results: readonly VerifiedCommandResult[]): VerifierScore {
  const asked = results.filter((r) => r.verdict !== undefined);
  const misbinds = asked.filter((r) => !r.inputHit);
  const correct = asked.filter((r) => r.inputHit);
  const rejected = (rs: readonly VerifiedCommandResult[]) => rs.filter((r) => r.verdict?.agrees === false);
  return {
    asked: asked.length,
    misbinds: misbinds.length,
    misbindsRemoved: rejected(misbinds).length,
    removedRate: misbinds.length === 0 ? NaN : rejected(misbinds).length / misbinds.length,
    correct: correct.length,
    correctRejected: rejected(correct).length,
    rejectedRate: correct.length === 0 ? NaN : rejected(correct).length / correct.length,
    rejected: rejected(asked),
  };
}

/** Record 0044's bar for the production decision, named on the verifier's
 *  line so the reader knows what the two ratios are for — and never judged
 *  by the replay. */
export const VERIFIER_BAR = "at least half removed under one in twenty rejected";

/** The verifier's line beside the command rows — the two counters, the two
 *  ratios, the bar named — and every rejected bind with the line it was shown,
 *  what was expected when it was a misbind, and the verifier's reason, as
 *  markdown lines for the receipt's notes. */
export function renderVerifier(score: VerifierScore, opts: { textCap?: number } = {}): string[] {
  const cap = opts.textCap ?? 80;
  const snippet = (text: string) => {
    const one = text.replace(/\s+/g, " ").trim();
    return one.length > cap ? `${one.slice(0, cap - 1)}…` : one;
  };
  const expectedOf = (r: VerifiedCommandResult) =>
    r.kind === "decoy"
      ? `no command${r.allow ? ` (or ${r.allow.join("/")})` : ""}`
      : `${r.command} ${stableJson(r.input)}`;
  return [
    `verifier: removed ${score.misbindsRemoved} of ${score.misbinds} write misbinds · rejected ${score.correctRejected} of ${score.correct} correct write binds (${score.asked} write-class binds asked; removed ${pct(score.removedRate)}, rejected ${pct(score.rejectedRate)}; the bar for the production decision is ${VERIFIER_BAR} — not judged here)`,
    "",
    score.rejected.length === 0 ? "rejected: none" : `rejected (${score.rejected.length}):`,
    ...score.rejected.map(
      (r) =>
        `- ${r.id}: ${r.kind}, ${r.inputHit ? "a correct bind" : "a misbind"} — bound ${r.verdict!.line}${
          r.inputHit ? "" : `, expected ${expectedOf(r)}`
        } — ${r.verdict!.reason} — "${snippet(r.text)}"`,
    ),
  ];
}

/** Token accounting over every router call of one replay: the three usage
 *  fields summed and the calls counted, plus the answers the model spent on
 *  two tool calls — refused by `providerRouteModel` ("the route is one call"),
 *  so they show up as no-routes; the counter says how often the model, not the
 *  parse, was the reason. */
export interface RouteCallCounters {
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  twoCallAnswers: number;
}

export const emptyCounters = (): RouteCallCounters => ({
  calls: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  twoCallAnswers: 0,
});

/** The provider with the counters riding every completion: sums the usage
 *  fields the provider reports and counts the answers that carried two or more
 *  tool calls. The result is handed through untouched. */
export function tallyingProvider(inner: Provider, counters: RouteCallCounters): Provider {
  return {
    name: inner.name,
    complete: async (req) => {
      const result = await inner.complete(req);
      counters.calls++;
      counters.inputTokens += result.usage?.inputTokens ?? 0;
      counters.cacheReadTokens += result.usage?.cacheReadTokens ?? 0;
      counters.cacheWriteTokens += result.usage?.cacheWriteTokens ?? 0;
      if (result.content.filter((p) => p.type === "tool_use").length > 1) counters.twoCallAnswers++;
      return result;
    },
  };
}

/** The counters line: the mean of each usage counter over the calls — a
 *  nonzero cache-read mean from the second call on is the prompt cache working
 *  — and the two-call refusal count. */
export function renderCounters(counters: RouteCallCounters): string {
  const mean = (n: number) => (counters.calls === 0 ? "—" : String(Math.round(n / counters.calls)));
  return `model calls: ${counters.calls}; mean input tokens ${mean(counters.inputTokens)}, cache read ${mean(counters.cacheReadTokens)}, cache write ${mean(counters.cacheWriteTokens)}; two-call answers refused: ${counters.twoCallAnswers}`;
}

/** What the receipt's verdict is made of. */
export interface RouteCheckInput {
  /** The confusion table over the directive labels (`typedLabels`). */
  table: ConfusionTable;
  /** How many of those the router answered with a preset. */
  answered: number;
  /** `readToWriteRoutes(...)` over the same results, counted. */
  readToWrite: number;
  /** The checked-in compound set's score. */
  compound: CompoundScore;
  compoundBar: { detection: number };
  /** The checked-in imperative set's score. */
  imperative: ImperativeScore;
  imperativeBar: { hit: number };
  /** The offered table's write preset (`tableWritePreset`), named by the
   *  imperative bar — derived from the table, never typed by the caller's hand. */
  writePreset: string;
  /** The checked-in command set's score and its two bars (1.0 and 0.9), when
   *  the command half was replayed; absent, the rows are not emitted. */
  command?: { score: CommandScore; bars: { command: number; input: number } };
}

/** The check rows: the accuracy bar, every request answered, record 0026's
 *  read-only-to-write clause (a row of its own, so the verdict fails on it
 *  without anyone reading the table), the three compound rows (detection, the
 *  collapse of every compound with a write part onto that preset, itself a row
 *  apart from the read-to-write clause, and no decoy split) and the imperative
 *  bars. */
export function routeChecks(input: RouteCheckInput): SloCheck[] {
  const { table, answered, readToWrite, compound, compoundBar, imperative, imperativeBar, writePreset } = input;
  const breaks = readToWriteRoutes(table.misroutes).map((r) => r.id);
  return [
    {
      name: "routing accuracy ≥ 95% against the presets people typed for the message (directive labels; record 0026's bar)",
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
      name: "compound with a write part collapsed to that preset, single: every checked-in one",
      pass: compound.collapsed === compound.collapseExpected,
      actual: `${compound.collapsed}/${compound.collapseExpected}`,
      limit: `${compound.collapseExpected}`,
    },
    {
      name: "no decoy split — one ask with several steps stays one route",
      pass: compound.decoysSplit === 0,
      actual: `${compound.decoysSplit}/${compound.decoys}`,
      limit: "0",
    },
    {
      name: `terse imperatives routed to ${writePreset} on ≥ ${Math.round(imperativeBar.hit * 100)}% of the checked-in imperative asks`,
      pass: imperative.hitRate >= imperativeBar.hit,
      actual: `${imperative.imperativesHit}/${imperative.imperatives} (${pct(imperative.hitRate)})`,
      limit: `≥ ${Math.round(imperativeBar.hit * 100)}%`,
    },
    {
      name: "read-only look-alikes of an imperative routed to a write preset: 0",
      pass: imperative.lookalikesToWrite === 0,
      actual: `${imperative.lookalikesToWrite}/${imperative.lookalikes}`,
      limit: "0",
    },
    ...(input.command === undefined ? [] : commandRows(input.command.score, input.command.bars)),
  ];
}

/** The command half's two rows: the command named (every fixture bound to its
 *  command and no decoy bound outside its `allow` — the bar is 1.0) and the
 *  bound input (equal to the expected one after `parseInput` — the bar 0.9). */
function commandRows(score: CommandScore, bars: { command: number; input: number }): SloCheck[] {
  return [
    {
      name: `command named right on every fixture and no decoy bound (≥ ${Math.round(bars.command * 100)}%)`,
      pass: score.commandRate >= bars.command,
      actual: `${score.commandHits}/${score.fixtures} bound right, ${score.decoysBound}/${score.decoys} decoys bound (${pct(score.commandRate)})`,
      limit: `≥ ${Math.round(bars.command * 100)}%`,
    },
    {
      name: `bound input equals the expected after parseInput on ≥ ${Math.round(bars.input * 100)}% of the fixtures`,
      pass: score.inputRate >= bars.input,
      actual: `${score.inputHits}/${score.fixtures} (${pct(score.inputRate)})`,
      limit: `≥ ${Math.round(bars.input * 100)}%`,
    },
  ];
}
