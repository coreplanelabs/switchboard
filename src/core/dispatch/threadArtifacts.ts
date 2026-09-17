// The thread's artifacts since the agent's previous run (docs/reference/specs/
// session-log.md item 9; record 0034 "The session", as amended): what a
// follow-up is handed beside its seed. A run's record carries typed artifacts
// (run-history item 2) — the pull request it opened or edited, the verdict a
// review submitted with its findings by id, the dispositions a coding run
// recorded against a review's findings, the handoff, the description it
// submitted, how the review post ended — and until this block only the ship
// runner read them for another run (coordinator/briefs.ts hands a re-review
// the prior findings and dispositions, and the findings step hands the coding
// session the review's findings). In a thread where a person asked for a
// review, then a fix, then a re-review, the review agent's session held its
// own prior verdict and never the coding run's dispositions, and a coding
// follow-up saw a review's findings only when a person pasted them. This
// module renders those records as data, in one block of the system prompt
// right after the agent's notes — the block rides the prompt, never the
// conversation, so the seed's four sources are what they were.
//
// Pure over the records: `runArtifacts` renders one, `threadArtifactsBlock`
// the newest runs within a budget, in the spirit of the session tail read
// (whole runs only, a cut said out loud). `threadArtifactsFor` is the one
// read: the candidates off the thread's page (dispatch/thread.ts), each
// record through the runs service — the store read the coordinator's
// `readRunFacts` makes. The runner's own carry stays as it is: it matches
// dispositions to the round's ids and names the dropped ones; this block
// hands the records over as they are.
import type { RunEvent } from "../runEvents.js";
import { utf8ByteLength, type RunRecord } from "../runRecord.js";
import type { RunsService, RunView } from "../runsService.js";
import { formatDisposition, formatFinding } from "../reviewVerdict.js";
import { handoffLines } from "../ship/handoff.js";
import { previousRunOf, runsSince } from "./thread.js";

/** The most runs the block carries: the page a thread read brings back is
 *  eight runs (`THREAD_READ_LIMIT`), one of which is the run being continued. */
export const THREAD_ARTIFACTS_MAX_RUNS = 6;
/** The block's byte budget, in tokens at the four characters a token the seed
 *  budget assumes (record 0035): a tenth of the seed budget, for data a run
 *  reads once before acting. */
export const THREAD_ARTIFACTS_BUDGET_TOKENS = 6_000;
export const THREAD_ARTIFACTS_BUDGET_BYTES = THREAD_ARTIFACTS_BUDGET_TOKENS * 4;

/** The fields of a run's record the block reads (run-history item 2): a full
 *  `RunRecord`, or the runs service's view of one with its events. */
export type ArtifactRecord = Pick<
  RunRecord,
  "id" | "agent" | "pr" | "verdict" | "dispositions" | "handoff" | "reviewPost"
> &
  Partial<Pick<RunRecord, "events">>;

/** Whether a view of a run names any artifact the block renders — the check
 *  made on the thread's page before a record is read, so a run that carried
 *  none (a chat, a research run) costs no store read. */
export function carriesArtifacts(
  view: Pick<RunView, "verdict" | "dispositions" | "handoff" | "pr" | "reviewPost">,
): boolean {
  return (
    view.verdict !== undefined ||
    view.dispositions !== undefined ||
    view.handoff !== undefined ||
    view.pr !== undefined ||
    view.reviewPost !== undefined
  );
}

/** The TL;DR of the description a coding run last submitted (the last
 *  `pr_description` event; pr-description.md item 5), or nothing. */
export function tldrOf(events: readonly RunEvent[] | undefined): string | undefined {
  if (!events) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "pr_description") continue;
    const tldr = e.description.tldr.trim();
    return tldr.length ? tldr : undefined;
  }
  return undefined;
}

const indent = (lines: readonly string[]): string => lines.map((l) => `  - ${l}`).join("\n");

const GITHUB_PULL_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+$/;

/** The pull request as the rest of the pipeline names it, `owner/repo#n`, read
 *  off its GitHub URL (the record carries the number and the URL, not the
 *  repository); a URL of another shape names the number and the URL as they are. */
function prName(pr: NonNullable<ArtifactRecord["pr"]>): string {
  const m = GITHUB_PULL_URL.exec(pr.url);
  return m ? `${m[1]}#${pr.number} (${pr.url})` : `pull request ${pr.number} at ${pr.url}`;
}

/** One run's artifacts as data, in one order — the pull request, the verdict
 *  with its findings by id, the dispositions by finding id, the handoff, the
 *  description's TL;DR, the review post — each only when the record carries
 *  it, and what a carried artifact lacks said out loud. Undefined for a record
 *  carrying none. */
export function runArtifacts(record: ArtifactRecord): string | undefined {
  const lines: string[] = [];
  if (record.pr) {
    const head = record.pr.head ? `, head branch ${record.pr.head}` : "";
    lines.push(`- pull request opened or edited: ${prName(record.pr)}${head}`);
  }
  if (record.verdict) {
    lines.push(`- verdict: ${record.verdict.verdict} — ${record.verdict.summary}`);
    const findings = record.verdict.findings ?? [];
    lines.push(findings.length ? `- findings:\n${indent(findings.map(formatFinding))}` : "- findings: none recorded");
  }
  if (record.dispositions) {
    lines.push(
      record.dispositions.length
        ? `- dispositions:\n${indent(record.dispositions.map(formatDisposition))}`
        : "- dispositions: none recorded",
    );
  }
  if (record.handoff) {
    const entries = handoffLines(record.handoff);
    lines.push(
      entries.length ? `- handoff:\n${indent(entries)}` : "- handoff: nothing to hand off (three empty lists)",
    );
  }
  // The description describes the pull request the record names; a description
  // submitted for a pull request that never opened describes nothing a reader
  // can open.
  const tldr = record.pr ? tldrOf(record.events) : undefined;
  if (tldr !== undefined) lines.push(`- description TL;DR: ${tldr}`);
  if (record.reviewPost) {
    const post = record.reviewPost;
    lines.push(
      post.posted
        ? `- review post: posted to ${post.target.repo}#${post.target.number} at ${post.head}${post.verdict ? ` (${post.verdict})` : ""}`
        : `- review post: not posted — ${post.reason}`,
    );
  }
  if (lines.length === 0) return undefined;
  return [`### run ${record.id} (${record.agent ?? "agent unknown"})`, ...lines].join("\n");
}

export interface ThreadArtifactsBlock {
  /** The block as the prompt carries it: the heading, a cut line when runs were cut, the runs oldest first. */
  text: string;
  /** The ids of the runs rendered, oldest first. */
  runs: string[];
  /** How many runs that carried artifacts were cut by the run cap or the byte budget. */
  cut: number;
  /** How many of the records carried artifacts at all. */
  total: number;
}

const WHAT =
  "what other runs of this thread recorded, as data off their records: a pull request opened or edited, a review verdict with its findings by id, dispositions by finding id, a handoff, a description's TL;DR, a review post's outcome; the runs' own words are on their pages";

/**
 * The block for a set of records in time order, oldest first: the newest runs
 * whose rendered artifacts fit the budget, at most `maxRuns`, whole runs only
 * — as the session tail read keeps whole turns — and a cut said out loud.
 * When even the newest run's block is over the budget the block names that
 * run and renders none, so the reader knows where to look. Undefined when no
 * record carries an artifact.
 */
export function threadArtifactsBlock(
  records: readonly ArtifactRecord[],
  opts: { sincePrevious: boolean; maxRuns?: number; maxBytes?: number },
): ThreadArtifactsBlock | undefined {
  const maxRuns = opts.maxRuns ?? THREAD_ARTIFACTS_MAX_RUNS;
  const maxBytes = opts.maxBytes ?? THREAD_ARTIFACTS_BUDGET_BYTES;
  const rendered = records.flatMap((r) => {
    const text = runArtifacts(r);
    return text === undefined ? [] : [{ id: r.id, text }];
  });
  if (rendered.length === 0) return undefined;
  // Newest first: keep whole runs while they fit, stop at the first that does not.
  const kept: typeof rendered = [];
  let bytes = 0;
  for (let i = rendered.length - 1; i >= 0 && kept.length < maxRuns; i--) {
    const size = utf8ByteLength(rendered[i].text);
    if (bytes + size > maxBytes) break;
    kept.unshift(rendered[i]);
    bytes += size;
  }
  const heading = `ARTIFACTS OF THIS THREAD'S RUNS${opts.sincePrevious ? " SINCE YOUR PREVIOUS RUN HERE" : ""} (${WHAT}):`;
  const cut = rendered.length - kept.length;
  const parts: string[] = [heading];
  if (kept.length === 0) {
    parts.push(
      `(the newest run's artifacts alone exceed the ${maxBytes}-byte budget — read them on its run page: run ${rendered[rendered.length - 1].id})`,
    );
  } else if (cut > 0) {
    parts.push(
      `(cut to the newest ${kept.length} of ${rendered.length} runs that carried artifacts; the earlier records are on the runs' pages)`,
    );
  }
  parts.push(...kept.map((k) => k.text));
  return { text: parts.join("\n\n"), runs: kept.map((k) => k.id), cut, total: rendered.length };
}

/**
 * The block for a follow-up, read off the thread's page: the finished runs
 * newer than the agent's previous run (`runsSince`), those whose view names an
 * artifact read whole through the runs service, then rendered. A record that
 * cannot be read is left out with a note; the note that a block rides names
 * the runs and any cut. Every note is a `seed` run note on the record.
 */
export async function threadArtifactsFor(input: {
  runs: Pick<RunsService, "getRun">;
  thread: readonly RunView[];
  agent: string;
}): Promise<{ block?: ThreadArtifactsBlock; notes: string[] }> {
  const candidates = runsSince(input.thread, input.agent).filter(carriesArtifacts);
  if (candidates.length === 0) return { notes: [] };
  const notes: string[] = [];
  const reads = await Promise.all(
    candidates.map(async (view): Promise<ArtifactRecord | undefined> => {
      try {
        const res = await input.runs.getRun(view.id, { include: "messages" });
        if (res.ok) return res.value;
        notes.push(`thread artifacts: the record of run ${view.id} could not be read (${res.error}) — left out`);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        notes.push(`thread artifacts: the record of run ${view.id} could not be read (${why}) — left out`);
      }
      return undefined;
    }),
  );
  const records = reads.filter((r): r is ArtifactRecord => r !== undefined);
  const sincePrevious = previousRunOf(input.thread, input.agent) !== undefined;
  const block = threadArtifactsBlock(records, { sincePrevious });
  if (!block) return { notes };
  const n = block.runs.length;
  if (n === 0) {
    notes.push(
      `thread artifacts: the newest run's artifacts alone exceed the ${THREAD_ARTIFACTS_BUDGET_BYTES}-byte budget — none ride the prompt (${block.total} run${block.total === 1 ? "" : "s"} with artifacts)`,
    );
  } else {
    const window = sincePrevious ? "since the previous run" : "of the thread";
    const cut =
      block.cut > 0
        ? `; ${block.cut} older run${block.cut === 1 ? "" : "s"} cut by the run cap or the byte budget`
        : "";
    notes.push(
      `thread artifacts: ${n} run${n === 1 ? "" : "s"} ${window} ride${n === 1 ? "s" : ""} the prompt (${block.runs.join(", ")})${cut}`,
    );
  }
  return { block, notes };
}
