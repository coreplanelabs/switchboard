import type { DispositionKind, FindingSeverity } from "./reviewVerdict.js";
import type { RunView } from "./runsService.js";

// The findings ledger per pull request (docs/reference/specs/agent-ship.md
// item 18): a read over the run records that name one pull request, joined by
// finding id. A review run's verdict lists findings with ids stable across
// rounds (item 6); a coding run's dispositions answer them by id; the next
// review re-raises the id when a fix did not hold and concedes a declined one
// that holds (the `re-review-delta` skill). This module is the pure half — no
// store, no clock: given the runs, one row per id whose status is a function
// of the recorded sequence alone. `RunsService.listFindings` gathers the runs
// and hands them here.

/** What the ledger reads off a run: the review's verdict and the head it read,
 *  the coding run's dispositions, and — when a unit row supplied it — the round
 *  the run belonged to (`UnitRun.round`). A `RunRecord` and a finished `RunView`
 *  both fit; a run without `finishedAt` is live and contributes nothing yet. */
export type LedgerRun = Pick<RunView, "id" | "startedAt" | "finishedAt" | "verdict" | "reviewHead" | "dispositions"> & {
  round?: number;
};

/** Where a finding was seen: the review run, the head it read, its round when known. */
export interface FindingSighting {
  runId: string;
  head?: string;
  round?: number;
}

/** The latest disposition a coding run recorded against the id. */
export interface FindingDispositionRef {
  kind: DispositionKind;
  note: string;
  runId: string;
  round?: number;
}

/** The vocabulary, each derived from what is recorded:
 *  - `open` — raised by the newest review, no disposition recorded after it;
 *  - `awaiting re-review` — a disposition recorded, no review after it yet;
 *  - `fixed` — disposition `fixed`, and the newest later review did not re-raise the id;
 *  - `conceded` — disposition `declined`, and the newest later review did not re-raise it;
 *  - `re-raised` — a review after the disposition listed the id again (`reRaisedAfter` says which kind it answered);
 *  - `not re-raised` — raised at an older head, absent from the newest review, and no disposition was recorded, so the record does not say whether it was fixed or conceded;
 *  - `unknown id` — a disposition names an id no review issued (recorded, as `submit_dispositions` records it). */
export type FindingStatus =
  "open" | "awaiting re-review" | "fixed" | "conceded" | "re-raised" | "not re-raised" | "unknown id";

export const FINDING_STATUSES: readonly FindingStatus[] = [
  "open",
  "awaiting re-review",
  "fixed",
  "conceded",
  "re-raised",
  "not re-raised",
  "unknown id",
];

/** One finding id across every round: the words of the latest review that
 *  listed it, where it was first raised and last seen, the latest disposition
 *  after it was raised, and its status. An `unknown id` row carries the
 *  disposition alone. */
export interface FindingRow {
  id: string;
  severity?: FindingSeverity;
  file?: string;
  line?: number;
  title?: string;
  raised?: FindingSighting;
  lastSeen?: FindingSighting;
  disposition?: FindingDispositionRef;
  status: FindingStatus;
  /** On a `re-raised` row: the disposition kind the re-raising review answered. */
  reRaisedAfter?: DispositionKind;
}

/** A review as the ledger walks it: its position in the finishing order, where
 *  it was, and what it listed. */
interface ReviewStep {
  order: number;
  sighting: FindingSighting;
  listed: Map<string, { severity: FindingSeverity; file: string; line?: number; title: string }>;
}

interface DispositionStep extends FindingDispositionRef {
  order: number;
}

const byFinish = (a: LedgerRun, b: LedgerRun): number =>
  (a.finishedAt ?? 0) - (b.finishedAt ?? 0) || a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** One row per finding id over the runs that name a pull request. The runs are
 *  ordered by `finishedAt` here (then `startedAt`, then id), so the caller's
 *  order does not matter; a run without `finishedAt` is left out. Rows come in
 *  the order ids were first raised, `unknown id` rows last in the order their
 *  dispositions were recorded. */
export function ledgerOf(runs: readonly LedgerRun[]): FindingRow[] {
  const reviews: ReviewStep[] = [];
  const dispositions = new Map<string, DispositionStep>();
  const dispositionOrder: string[] = [];
  const finished = runs.filter((r) => r.finishedAt !== undefined).sort(byFinish);
  finished.forEach((run, order) => {
    if (run.verdict) {
      const head = run.reviewHead ?? run.verdict.head;
      const listed = new Map<string, { severity: FindingSeverity; file: string; line?: number; title: string }>();
      for (const f of run.verdict.findings ?? []) {
        listed.set(f.id, {
          severity: f.severity,
          file: f.file,
          ...(f.line !== undefined ? { line: f.line } : {}),
          title: f.title,
        });
      }
      reviews.push({
        order,
        sighting: {
          runId: run.id,
          ...(head !== undefined ? { head } : {}),
          ...(run.round !== undefined ? { round: run.round } : {}),
        },
        listed,
      });
    }
    if (run.dispositions) {
      // The last entry for an id wins, within one run and across runs.
      for (const d of run.dispositions) {
        if (!dispositions.has(d.findingId)) dispositionOrder.push(d.findingId);
        dispositions.set(d.findingId, {
          order,
          kind: d.disposition,
          note: d.note,
          runId: run.id,
          ...(run.round !== undefined ? { round: run.round } : {}),
        });
      }
    }
  });

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const review of reviews)
    for (const id of review.listed.keys())
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
  const rows = ids.map((id) => rowOf(id, reviews, dispositions.get(id)));
  for (const id of dispositionOrder) {
    if (seen.has(id)) continue;
    const { order: _order, ...disposition } = dispositions.get(id)!;
    rows.push({ id, disposition, status: "unknown id" });
  }
  return rows;
}

function rowOf(id: string, reviews: readonly ReviewStep[], latest: DispositionStep | undefined): FindingRow {
  const sightings = reviews.filter((r) => r.listed.has(id));
  const first = sightings[0];
  const last = sightings[sightings.length - 1];
  const words = last.listed.get(id)!;
  const newest = reviews[reviews.length - 1];
  // A disposition recorded before the id was first raised answers nothing here.
  const answer = latest !== undefined && latest.order > first.order ? latest : undefined;
  const row: FindingRow = {
    id,
    severity: words.severity,
    file: words.file,
    ...(words.line !== undefined ? { line: words.line } : {}),
    title: words.title,
    raised: first.sighting,
    lastSeen: last.sighting,
    status: "open",
  };
  if (answer === undefined) {
    row.status = last === newest ? "open" : "not re-raised";
    return row;
  }
  const { order, ...disposition } = answer;
  row.disposition = disposition;
  const after = reviews.filter((r) => r.order > order);
  if (after.length === 0) {
    row.status = "awaiting re-review";
  } else if (after[after.length - 1].listed.has(id)) {
    row.status = "re-raised";
    row.reRaisedAfter = disposition.kind;
  } else {
    row.status = disposition.kind === "fixed" ? "fixed" : "conceded";
  }
  return row;
}

// ---- the pull request reference a command takes ---------------------------------------------

/** `owner/repo#N`, or the pull request's GitHub URL (`https://github.com/owner/repo/pull/N`, a trailing path allowed). */
export const PULL_REQUEST_REF_PATTERN =
  /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#|\/pull\/)([1-9]\d*)(?:\/[^\s]*)?$/;

/** The repository and number a reference names, or undefined when it is not one. */
export function parsePullRequestRef(text: string): { repo: string; number: number } | undefined {
  const m = PULL_REQUEST_REF_PATTERN.exec(text);
  if (!m) return undefined;
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number)) return undefined;
  return { repo: `${m[1]}/${m[2]}`, number };
}
