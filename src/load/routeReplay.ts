// `load:route` (docs/reference/specs/load-harness.md item 17): the request
// router scored offline against the requests people already typed. A finished
// run whose requester chose the preset themselves — `agent:<preset>` on the
// message, or the thread's sticky preset they typed earlier — is a labelled
// example: the label is the preset the run ran on, the text is the request
// with every directive token hidden, and the router is asked what it would
// have picked. The result is a per-preset confusion table with accuracy and
// the misroutes listed. Pure over records and a `RouteDecision` function; the
// entrypoint (`scripts/load.ts`) pages the run store and picks the model.
import { AGENTS } from "../agents/registry.js";
import { stripDirectiveTokens } from "../directives.js";
import type { RouteDecision } from "../core/dispatch/route.js";
import type { RunRecord } from "../core/runRecord.js";
import type { AgentSource } from "../core/runEvents.js";

/** One labelled request: what was asked, which preset the requester chose. */
export interface ReplayRequest {
  id: string;
  label: string;
  text: string;
  /** How the label is known: the record's `run_meta.agentSource` (`directive`
   *  or `sticky`), or — for a record written before that stamp existed — the
   *  heuristic that a run on a preset other than the deployment's default was
   *  a typed choice. */
  labelSource: "directive" | "sticky" | "heuristic";
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
 * for a record written before the stamp — a preset other than `defaultPreset`
 * (a run on the default preset with no stamp is unlabelled: the requester may
 * have chosen nothing). Never labelled: a run the router chose (its `route`
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
    } else labelSource = "heuristic";
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
