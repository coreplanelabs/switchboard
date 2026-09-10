import { COMPARE_DIFF_MAX_CHARS, GithubApiError, type GithubApi } from "../execution/githubApi.js";
import type { MeatRun, MeatRunResult } from "./meatProcess.js";
import { capDiff, resolveReadingDiff, sanitizeArtifactText, type ReadingDiffConfig } from "./readingDiff.js";
import { redactSecrets, type RunEvent } from "./runEvents.js";
import { fitRecordToBudget, storedEventSeqs, type RunRecord } from "./runRecord.js";
import type { RunStore } from "./runStore.js";

// The abridged reading diff, produced on the BOT HOST after a review has
// finished (docs/reference/specs/reading-diff.md items 5–8). ONE path:
// `ReviewAbridger.abridge` is what the `review abridge` command and the
// `provider: meat` auto mode both call, with the same inputs, so a review's
// abridged diff is the same whichever way it was asked for (meat caches by the
// hash of model + diff on top). The pipeline never waits on it: it runs over
// the STORED record, once the record is durable.
//
// Input completeness: the recorded git artifact is capped at READING_DIFF_CAP
// and may be `truncated`, so it cannot be meat's primary input — a cut diff
// would mislead the abridging, and refusing on it would make the feature dead
// exactly on the large PRs that need it. meat reads the complete unified diff
// GitHub renders for `base...head` (the run's `run_meta` names repo and head,
// the git artifact its base), fetched with the bot's read credential; the
// recorded diff serves only when that fetch fails AND it is whole. Otherwise
// the production fails BY NAME, spending nothing.
//
// The state machine, per run id: `absent → running → done | failed`;
// `--force` moves `done` or `failed` back to `running`. `running` and `failed`
// live in this process (a restart forgets them: a lost job is `absent` again
// and re-runnable; a lost failure is retried on the next ask); `done` IS the
// stored artifact, so it survives restarts and answers idempotently.

export type AbridgeInput = "github-compare" | "recorded";

/** The `review_artifact` event variant. */
export type ReviewArtifactEvent = Extract<RunEvent, { type: "review_artifact" }>;

/** What a done state carries about the stored artifact — everything but the diff
 *  itself, which lives on the record (`runs events`). */
export interface AbridgeArtifactSummary {
  model?: string;
  summary?: string;
  input?: AbridgeInput;
  inputBytes?: number;
  diffChars: number;
  truncated: boolean;
  meatTokens?: { input: number; output: number };
}

export type AbridgeState =
  | { state: "absent" }
  | { state: "running"; startedAt: number }
  | { state: "done"; reused: boolean; artifact: AbridgeArtifactSummary }
  | { state: "failed"; reason: string; at: number };

export interface AbridgeRequest {
  runId: string;
  /** meat's `-model`; default the configured `meatModel`, else `claude-opus-5`. */
  model?: string;
  /** Recompute a `done` run (replacing its meat artifact) or retry a `failed` one. */
  force?: boolean;
}

/** A refusal the caller words: the run is unknown (`not_found`) or is not a
 *  review that recorded a reading diff (`conflict`). Never a failure of the
 *  production itself — those are the `failed` state. */
export class AbridgeRefusal extends Error {
  constructor(
    readonly code: "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "AbridgeRefusal";
  }
}

/** Where the complete diff comes from: GitHub's compare endpoint on the seam
 *  the github tools already use. Undefined when the process holds no GitHub
 *  credential. */
export type DiffSource = Pick<GithubApi, "compareDiff">;

export interface AbridgerDeps {
  store: RunStore;
  github: () => DiffSource | undefined;
  /** meat itself — `meatOnHost(...)` in production, a fake in tests. */
  meat: (run: MeatRun) => Promise<MeatRunResult>;
  defaultModel: () => string;
  timeoutMs: () => number;
  clock: () => number;
  warn: (message: string) => void;
  /** Injectable for tests; default `COMPARE_DIFF_MAX_CHARS`. */
  compareMaxChars?: number;
}

export function meatArtifactOf(record: RunRecord): ReviewArtifactEvent | undefined {
  return record.events.find((e): e is ReviewArtifactEvent => e.type === "review_artifact" && e.poweredBy === "meat");
}

export function gitArtifactOf(record: RunRecord): ReviewArtifactEvent | undefined {
  return record.events.find((e): e is ReviewArtifactEvent => e.type === "review_artifact" && e.poweredBy === "git");
}

function summarize(a: ReviewArtifactEvent): AbridgeArtifactSummary {
  return {
    ...(a.model !== undefined ? { model: a.model } : {}),
    ...(a.summary !== undefined ? { summary: a.summary } : {}),
    ...(a.input !== undefined ? { input: a.input } : {}),
    ...(a.inputBytes !== undefined ? { inputBytes: a.inputBytes } : {}),
    diffChars: a.diff.length,
    truncated: a.truncated,
    ...(a.meatTokens !== undefined ? { meatTokens: a.meatTokens } : {}),
  };
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class ReviewAbridger {
  private readonly jobs = new Map<string, { startedAt: number; done: Promise<AbridgeState> }>();
  private readonly failures = new Map<string, { reason: string; at: number }>();
  /** The last production's final state per run — what `wait` answers once the job is gone. */
  private readonly outcomes = new Map<string, AbridgeState>();
  /** The decision in flight per run (an `abridge` reading its record before it
   *  has a job): registered SYNCHRONOUSLY before the first await, so a second
   *  call for the same run joins it instead of racing it — the check-then-act
   *  that would otherwise start two productions (two Opus calls) for one run. */
  private readonly deciding = new Map<string, Promise<AbridgeState>>();

  constructor(private readonly deps: AbridgerDeps) {}

  /** THE abridge path. Starts a production when there is none and answers the
   *  in-progress marker; answers the stored artifact when one exists (no
   *  spend) and the remembered failure when the last attempt failed — both
   *  until `force`. Concurrent calls for one run share one decision and one
   *  outcome (a joiner's `force` is not a second start: one production per run
   *  at a time). Refuses by name (`AbridgeRefusal`) for an unknown run or a
   *  run with no git reading diff; never throws for a production failure. */
  abridge(req: AbridgeRequest): Promise<AbridgeState> {
    const joined = this.deciding.get(req.runId);
    if (joined) return joined;
    const decision = this.decide(req).finally(() => this.deciding.delete(req.runId));
    this.deciding.set(req.runId, decision);
    return decision;
  }

  private async decide(req: AbridgeRequest): Promise<AbridgeState> {
    const job = this.jobs.get(req.runId);
    if (job) return { state: "running", startedAt: job.startedAt };
    const record = await this.deps.store.get(req.runId);
    if (!record) throw new AbridgeRefusal("not_found", "run not found");
    const existing = meatArtifactOf(record);
    if (existing && !req.force) return { state: "done", reused: true, artifact: summarize(existing) };
    const failed = this.failures.get(req.runId);
    if (failed && !req.force) return { state: "failed", ...failed };
    const git = gitArtifactOf(record);
    if (!git)
      throw new AbridgeRefusal(
        "conflict",
        `run ${req.runId} carries no reading diff — only PR review runs record one`,
      );
    const startedAt = this.deps.clock();
    const model = req.model ?? this.deps.defaultModel();
    this.failures.delete(req.runId);
    const done = this.produce(record, git, model).finally(() => this.jobs.delete(req.runId));
    this.jobs.set(req.runId, { startedAt, done });
    return { state: "running", startedAt };
  }

  /** The state without starting anything. */
  async status(runId: string): Promise<AbridgeState> {
    const job = this.jobs.get(runId);
    if (job) return { state: "running", startedAt: job.startedAt };
    const failed = this.failures.get(runId);
    if (failed) return { state: "failed", ...failed };
    const record = await this.deps.store.get(runId);
    const existing = record ? meatArtifactOf(record) : undefined;
    return existing ? { state: "done", reused: true, artifact: summarize(existing) } : { state: "absent" };
  }

  /** The running job's final state, or the current state when none runs. */
  wait(runId: string): Promise<AbridgeState> {
    // A production that already finished answers its OWN outcome (`reused:
    // false`), not the store's view of it — `--wait` and chat's `settle` ask
    // right after a `running` marker, and a fast production must not read as
    // "already stored" because it beat the caller to the store.
    const job = this.jobs.get(runId);
    if (job) return job.done;
    const outcome = this.outcomes.get(runId);
    return outcome ? Promise.resolve(outcome) : this.status(runId);
  }

  /** Run ids with a production in flight. */
  running(): string[] {
    return [...this.jobs.keys()];
  }

  /** Resolves once every decision and production in flight has settled (tests, the drain). */
  async settled(): Promise<void> {
    while (this.jobs.size > 0 || this.deciding.size > 0) {
      await Promise.allSettled([...this.deciding.values(), ...[...this.jobs.values()].map((j) => j.done)]);
    }
  }

  /** The unattended caller (`provider: meat`): the same path, refusals silent —
   *  every non-review run persists through the same hook — a failure warned. */
  async autoAbridge(runId: string): Promise<void> {
    try {
      const state = await this.abridge({ runId });
      const final = state.state === "running" ? await this.wait(runId) : state;
      if (final.state === "failed") this.deps.warn(`[reading-diff] ${runId} meat did not land: ${final.reason}`);
    } catch (err) {
      if (!(err instanceof AbridgeRefusal)) this.deps.warn(`[reading-diff] ${runId} abridge failed: ${describe(err)}`);
    }
  }

  private async produce(record: RunRecord, git: ReviewArtifactEvent, model: string): Promise<AbridgeState> {
    const at = () => this.deps.clock();
    try {
      const input = await this.input(record, git);
      const meat = await this.deps.meat({ diff: input.diff, model, timeoutMs: this.deps.timeoutMs() });
      if (!meat.ok) throw new Error(meat.reason);
      const capped = capDiff(sanitizeArtifactText(meat.result.diff));
      const artifact: Omit<ReviewArtifactEvent, "type" | "artifact" | "seq" | "at"> = {
        poweredBy: "meat",
        baseRef: git.baseRef,
        diff: capped.diff,
        truncated: capped.truncated,
        // meat's summary is model prose generated FROM the diff — same hygiene.
        ...(meat.result.summary ? { summary: sanitizeArtifactText(meat.result.summary) } : {}),
        ...(meat.result.inputTokens !== undefined && meat.result.outputTokens !== undefined
          ? { meatTokens: { input: meat.result.inputTokens, output: meat.result.outputTokens } }
          : {}),
        input: input.source,
        inputBytes: input.bytes,
        model,
      };
      const stored = await appendReviewArtifact(this.deps.store, record.id, artifact, at());
      return this.conclude(record.id, { state: "done", reused: false, artifact: summarize(stored) });
    } catch (err) {
      const failed = { reason: redactSecrets(describe(err)), at: at() };
      this.failures.set(record.id, failed);
      return this.conclude(record.id, { state: "failed", ...failed });
    }
  }

  private conclude(runId: string, state: AbridgeState): AbridgeState {
    this.outcomes.set(runId, state);
    return state;
  }

  /** The complete diff: GitHub's compare of base...head first; the recorded
   *  git diff only when that fails AND it is whole. */
  private async input(
    record: RunRecord,
    git: ReviewArtifactEvent,
  ): Promise<{ diff: string; source: AbridgeInput; bytes: number }> {
    const meta = record.events.find((e) => e.type === "run_meta");
    let compareFailure: string;
    if (!meta?.repo || !meta.headSha) compareFailure = "the run records no repo and head to compare";
    else {
      const github = this.deps.github();
      if (!github) compareFailure = "no GitHub credential";
      else {
        const max = this.deps.compareMaxChars ?? COMPARE_DIFF_MAX_CHARS;
        try {
          const r = await github.compareDiff(meta.repo, git.baseRef, meta.headSha, max);
          if (!r.complete) compareFailure = `GitHub compare diff exceeds ${max} chars`;
          else if (r.diff.trim() === "") compareFailure = "GitHub compare returned an empty diff";
          else return { diff: r.diff, source: "github-compare", bytes: Buffer.byteLength(r.diff) };
        } catch (err) {
          compareFailure = `GitHub compare failed (${err instanceof GithubApiError ? err.status : describe(err)})`;
        }
      }
    }
    if (git.truncated) throw new Error(`diff unavailable: ${compareFailure} and the recorded diff is truncated`);
    this.deps.warn(`[reading-diff] ${record.id} using the recorded diff: ${compareFailure}`);
    return { diff: git.diff, source: "recorded", bytes: Buffer.byteLength(git.diff) };
  }
}

/** Finished records gain events by exactly one path (run-history.md item 43):
 *  a whole-record rewrite through `put` that only a `review_artifact` uses.
 *  Re-read (the record may have moved), drop a previous meat artifact (a force
 *  replaces, never accumulates), stamp the next `seq` after every existing
 *  one, refit the byte budget, and refuse by name when the record is gone,
 *  when the artifact would not fit, or when the store did not keep it. */
async function appendReviewArtifact(
  store: RunStore,
  runId: string,
  artifact: Omit<ReviewArtifactEvent, "type" | "artifact" | "seq" | "at">,
  at: number,
): Promise<ReviewArtifactEvent> {
  const record = await store.get(runId);
  if (!record) throw new Error("the run's record is gone — nothing to append to");
  const kept = record.events.filter((e) => !(e.type === "review_artifact" && e.poweredBy === "meat"));
  const replaced = kept.length !== record.events.length;
  const seq = Math.max(0, ...storedEventSeqs(record.events), ...record.events.map((e) => e.seq ?? 0)) + 1;
  const event: ReviewArtifactEvent = { type: "review_artifact", artifact: "reading_diff", ...artifact, at, seq };
  const next = fitRecordToBudget({
    ...record,
    events: [...kept, event],
    eventCount: record.eventCount + (replaced ? 0 : 1),
    storedEventCount: kept.length + 1,
  });
  if (!next.events.includes(event)) throw new Error("the record has no room for the abridged diff within its byte budget");
  const put = await store.put(next);
  if (!put.stored) throw new Error("the run's record fell outside the retention window; nothing was stored");
  return event;
}

/** The `onPersisted` hook for `review.readingDiff.provider: meat`: once a run's
 *  final record is durable, abridge it through the one path — a detached host
 *  task the pipeline never waits on. `git` (the default) and `off` do nothing:
 *  the abridged diff is then on demand only. */
export function autoAbridgeOnPersist(
  abridger: () => ReviewAbridger | undefined,
  cfg: () => ReadingDiffConfig | undefined,
  env: Record<string, string | undefined>,
): (runId: string) => void {
  return (runId) => {
    if (resolveReadingDiff(cfg(), env)?.provider !== "meat") return;
    void abridger()?.autoAbridge(runId);
  };
}
