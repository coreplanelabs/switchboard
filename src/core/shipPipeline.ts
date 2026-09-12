// The agent:ship pipeline (docs/reference/specs/agent-ship.md): the coding →
// review → fix loop to LGTM as ONE dispatch — one card, one run record, N
// strictly serial child rounds, every GitHub side effect executed by the bot
// process from typed artifacts. `dispatch()` forks in here (runShipBranch in
// dispatcher.ts) after agent resolution and the repo gates; this module owns
// the round loop — its caps, its endings and the `ship_round` boundaries —
// and runs the pipeline's stages, one file each under ship/: the preflight
// decisions (ship/preflight.ts), one coding round (ship/codingChild.ts), one
// review round (ship/reviewChild.ts). Every stage is parameterized on explicit
// inputs like the reviewRound units, so the dispatcher stays legible.
//
// Boundaries the pipeline enforces (spec items 1–2, 9, 11):
//   - Slack and the CLI only — single-shot adapters (HTTP /ingress, MCP) are
//     refused with a pointer to the runs page before anything starts.
//   - Compound permission gate: ship ∧ coding ∧ review (the repo leg already
//     ran in the dispatcher — the fork sits after `canUseRepo`).
//   - A target repo with auto-merge enabled is refused up front (the
//     approving LGTM triggers the org auto-approve workflow; with auto-merge
//     on, the PR would merge with no human). Unknown = refused (fail-closed).
//   - Resident-only v1: a round that cannot attach a resident worktree ends
//     the pipeline with a plain report — never a cold per-round clone.
//   - Ship's bot-process GitHub writes are exactly the round-0 branch create
//     (githubPulls.createBranchRef), the PR open/edit (githubPulls), and the
//     pinned review post (runReviewPostStep) — no merge endpoint is reachable
//     from any code path here.
//   - Thread follow-ups steer the pipeline like every agent (thread-admission
//     item 2): the dispatcher's one per-thread inbox is handed to EVERY child
//     round's runner, so a reply lands on whichever child is in flight at its
//     next step, and a reply between rounds is read by the next child. The
//     orchestrator itself never reads the inbox — it has no model turn.

import { AGENTS, type AgentDef } from "../agents/registry.js";
import type { ChatMessage } from "../providers/types.js";
import type { PullRequestFacts } from "../execution/githubPulls.js";
import type { Span } from "../core/trace/types.js";
import { formatFinding, type Finding, type FindingDisposition, type ReviewVerdict } from "./reviewVerdict.js";
import type { RunEvent, ShipRoundOutcome } from "./runEvents.js";
import { normalizeHead, sameCommit } from "./reviewedHead.js";
import type { ShipEntry } from "./ship/preflight.js";
import type { Handoff } from "./ship/handoff.js";
import {
  buildShipFixTurn,
  runShipCodingChild,
  type CodingChildDeps,
  type CodingChildGithub,
} from "./ship/codingChild.js";
import { runShipReviewChild, type ReviewChildDeps, type ReviewChildGithub } from "./ship/reviewChild.js";

// ---- config (`ship` block, docs/reference/specs/agent-ship.md item 8) -------------------

/** The `ship` config block: pipeline caps, resolved at deployment level like
 *  the sibling `review` block. `maxRounds` is the pipeline's own; `maxMinutes`
 *  is the ship preset's declared budget in this deployment — a profile field
 *  (docs/decisions/0026-capability-profiles-and-request-routing.md), so a
 *  channel or user boundary and a `budget:` directive clip it per run like any
 *  preset's, which is the per-scope layering these caps have. */
export interface ShipConfig {
  /** Review rounds per pipeline (>= 1). Default 3. */
  maxRounds?: number;
  /** The ship preset's declared wall-clock budget in minutes (>= 1). Default:
   *  the registry's `AGENTS.ship.maxMinutes` (120). */
  maxMinutes?: number;
}

/** What the round loop runs under: the rounds cap from the config block, and
 *  the wall clock from the parent run's EFFECTIVE profile — the preset's
 *  declared budget as the profile gate clipped it, never the block read again. */
export interface ShipCaps {
  maxRounds: number;
  maxMinutes: number;
}

export const SHIP_DEFAULT_MAX_ROUNDS = 3;
/** One number: the ship preset's own declared budget is the default the knob replaces. */
export const SHIP_DEFAULT_MAX_MINUTES = AGENTS.ship.maxMinutes;

export function resolveShipCaps(cfg: ShipConfig | undefined): ShipCaps {
  return {
    maxRounds: cfg?.maxRounds ?? SHIP_DEFAULT_MAX_ROUNDS,
    maxMinutes: cfg?.maxMinutes ?? SHIP_DEFAULT_MAX_MINUTES,
  };
}

/** The ship preset as this deployment declares it (docs/reference/specs/agent-ship.md
 *  item 8): the registry's def with the `ship.maxMinutes` knob as its budget —
 *  the one number the run's profile is resolved from, so a boundary clips it,
 *  a `budget:` directive narrows it, and the pipeline's wall clock is the
 *  effective profile's minutes. Always a copy; `AGENTS.ship` is never mutated. */
export function shipPresetFor(cfg: ShipConfig | undefined): AgentDef {
  return { ...AGENTS.ship, maxMinutes: resolveShipCaps(cfg).maxMinutes };
}

/** A round is dispatched only when at least this much of the pipeline budget
 *  remains (the reservation check, spec item 8): a child clipped below this
 *  cannot do useful work, so the pipeline reports the cap instead of burning
 *  an attach + model turn on a doomed round. */
export const SHIP_ROUND_RESERVE_MS = 3 * 60_000;

// ---- the interrupted pipeline's note (run-history item 36) ---------------------

/** What a ship pipeline's thread and card say when the bot died under it (run-
 *  history item 36): the work it did stands on GitHub with nobody driving it,
 *  so the note names the PR when one was opened and the exact re-issue that
 *  continues the loop — the same entry the preflight's resume-at-review takes
 *  (spec item 10). Without a PR the task itself is the re-issue: round 0 runs
 *  again on the pipeline's own deterministic branch. */
export function shipInterruptedNote(prUrl?: string): string {
  const stands = prUrl
    ? `Its work stands on GitHub: ${prUrl}.`
    : "Whatever it pushed stands on its pipeline branch; no PR was opened yet.";
  const reissue = prUrl
    ? `To continue the review loop, re-issue \`agent:ship\` in this thread with only the PR URL (${prUrl}).`
    : "To continue, re-issue `agent:ship` in this thread with the task — round 0 runs again on the same branch.";
  return `⚠️ The bot restarted while this ship pipeline was running, so the pipeline stopped. ${stands} ${reissue}`;
}

// ---- round visibility (spec item 12) ------------------------------------------

/** The card's orchestrator-owned round header for a `ship_round` boundary:
 *  `Round 0 — coding` / `Round 1 — review` / `Round 1 — fix` (a fix round
 *  shares its review round's index; a coding round above index 0 IS a fix
 *  round). Lives here so the phase derivation sits next to the round
 *  vocabulary that produces the indexes. */
export function shipRoundHeader(round: { index: number; agent: string }): string {
  const phase = round.agent === "review" ? "review" : round.index === 0 ? "coding" : "fix";
  return `Round ${round.index} — ${phase}`;
}

// ---- the round loop (spec items 3–8) ------------------------------------------

/** Every GitHub seam the pipeline writes through: each child round's slice,
 *  plus what the orchestrator uses itself. */
export interface ShipGithub extends CodingChildGithub, ReviewChildGithub {
  /** Round 0's pipeline-branch create (`refs/heads/<branch>` at the base
   *  tip): the ref must exist on origin BEFORE the first attach, or the
   *  resident refuses the binding. Idempotent — 422 already-exists is
   *  success inside the implementation. Throws on any real failure. */
  createBranchRef: (repo: string, branch: string, fromRef: string) => Promise<void>;
  /** The merge-ready re-check (spec item 9). */
  prFacts: (pr: { repo: string; number: number }) => Promise<PullRequestFacts | undefined>;
}

/** The pipeline's whole input: each child round's slice (they share what every
 *  child reads), plus what the orchestrator itself uses. */
export interface ShipPipelineInput extends CodingChildDeps, ReviewChildDeps {
  entry: ShipEntry;
  /** Round 0's message list (thread history + the task turn), built by the
   *  dispatcher; unused on a resume. Review/fix rounds synthesize their own. */
  round0Messages: ChatMessage[];
  caps: ShipCaps;
  /** Registry publish for events the pipeline owns (typed artifacts:
   *  pr_description, pr_opened; the ship_round boundaries) — the dispatcher's
   *  hook also feeds the card's round header off the `ship_round` events. */
  publish: (event: RunEvent) => void;
  /** The run's root span (docs/reference/specs/tracing.md): every round is a `ship.round`
   *  child of it, every child run's `run.agent` a child of its round. Absent
   *  (tests) → no spans. */
  span?: Span;
  github: ShipGithub;
  now?: () => number;
}

/** How the pipeline ended, as the dispatcher's shell consumes it: the truthful
 *  ending kind and the one reply the thread gets. Refusals never get here —
 *  they are preflight results. An unexpected throw propagates instead.
 *  `completed` means the pipeline delivered its outcome (merge-ready, or a
 *  report it chose to end on); `aborted` names an early ending with a reason;
 *  `capped` a round/wall-clock ceiling; `stopped_*` an operator stop. The
 *  dispatcher maps these onto the run-record vocabulary and the card close —
 *  only `completed` closes ✅ with a checked-off checklist. */
export interface ShipOutcome {
  status: "completed" | "aborted" | "capped" | "stopped_soft" | "stopped_hard";
  reply: string;
  /** The LAST coding round's handoff (docs/reference/specs/agent-ship.md item 14) —
   *  round 0's, or a fix round's, which replaces it — for the ship run's
   *  record. Rides every ending: a stop or a cap after a round that handed one
   *  back still records it. Absent when no round submitted one. */
  handoff?: Handoff;
}

/**
 * The strictly serial round loop: round 0 opens the PR
 * through the coding PR gate, then review → fix repeats until an approve
 * verdict, a cap, an abort terminal, or an operator stop. Each child runs on
 * its own agent's budgets CLIPPED to the remaining pipeline wall clock; the
 * run's `RunControl` is checked between rounds so a stop never starts one.
 */
export async function runShipPipeline(input: ShipPipelineInput): Promise<ShipOutcome> {
  // The last coding round's handoff decorates the outcome HERE, once, rather
  // than at each of the loop's endings — so a stop, a cap or an abort after a
  // round that handed one back still carries it onto the run record.
  let handoff: Handoff | undefined;
  const outcome = await runRounds(input, (h) => {
    handoff = h;
  });
  return handoff !== undefined ? { ...outcome, handoff } : outcome;
}

/** The round loop proper; `onHandoff` receives each coding round's handoff as the round settles. */
async function runRounds(input: ShipPipelineInput, onHandoff: (handoff: Handoff) => void): Promise<ShipOutcome> {
  const now = input.now ?? Date.now;
  const { entry, caps, control, github, logKey } = input;
  const deadlineAt = now() + caps.maxMinutes * 60_000;
  const remainingMs = () => deadlineAt - now();
  /** Never mutate the shared AgentDef — children run a clipped COPY. */
  const clip = (def: AgentDef): AgentDef => ({
    ...def,
    maxMinutes: Math.min(def.maxMinutes, Math.max(remainingMs(), 0) / 60_000),
  });
  /** The pipeline state every child round is handed (ship/childRound.ts). */
  const childCtx = { entry, clip, now };

  /** Findings per review round and dispositions per fix round, both keyed by
   *  the REVIEW round they belong to. Finding ids are only unique WITHIN one
   *  round — a later review may reuse an id for a brand-new finding — so one
   *  flat map would let a stale disposition claim a finding it never
   *  addressed. Earlier rounds' records stay for lookback (and any history
   *  line a report wants). */
  const findingsByRound = new Map<number, Finding[]>();
  const dispositionsByRound = new Map<number, Map<string, FindingDisposition>>();
  /** The same finding across rounds: matching id plus the content that
   *  identifies it (severity/file/title — line excluded, fixes shift lines).
   *  A reused id over different content is a different finding. */
  const sameFinding = (a: Finding, b: Finding) => a.severity === b.severity && a.file === b.file && a.title === b.title;
  /** The disposition that answers `finding` as review round `round` listed
   *  it: that round's own fix-round record when one exists, else walk earlier
   *  rounds while the finding was carried forward unchanged — never across a
   *  reused id, which inherits nothing. */
  const dispositionFor = (finding: Finding, round: number): FindingDisposition | undefined => {
    let cur = finding;
    for (let r = round; r >= 1; r--) {
      const d = dispositionsByRound.get(r)?.get(cur.id);
      if (d) return d;
      const carriedFrom = findingsByRound.get(r - 1)?.find((p) => p.id === cur.id && sameFinding(p, cur));
      if (!carriedFrom) return undefined;
      cur = carriedFrom;
    }
    return undefined;
  };
  let lastFindings: Finding[] = [];
  let reviewRounds = 0;
  let prNumber = entry.resume?.pr;
  let prUrl =
    entry.resume?.url ?? (prNumber !== undefined ? `https://github.com/${entry.repo}/pull/${prNumber}` : undefined);
  let lastReviewHead: string | undefined = entry.resume?.headSha;

  const roundsLine = () => `${reviewRounds} review round${reviewRounds === 1 ? "" : "s"}`;
  const reissue = () =>
    `To continue, re-issue \`agent:ship\` in this thread${prUrl ? ` and include the PR URL (${prUrl})` : " — include the PR URL if a PR exists"}.`;
  // The round boundary (spec item 12): one `started` event when a round's
  // child is dispatched, one settle event when its outcome is known —
  // published on the one stream, so per-round cost is derivable by slicing
  // `turn` events between boundaries (the dispatcher's publish hook also
  // drives the card's round header off these).
  const emitRound = (index: number, agentName: "coding" | "review", outcome: ShipRoundOutcome) => {
    console.log(`[ship] ${logKey} round ${index} (${agentName}) ${outcome}`);
    input.publish({ type: "ship_round", index, agent: agentName, outcome, at: now() });
  };

  const stoppedOutcome = (tail?: string): ShipOutcome => {
    const mode = control.requested === "hard" ? "hard" : "soft";
    return {
      status: mode === "hard" ? "stopped_hard" : "stopped_soft",
      reply: [
        `${mode === "hard" ? "⛔" : "⏹"} Ship stopped by operator (${mode} stop) after ${roundsLine()}.${prUrl ? ` PR: ${prUrl}` : ""}`,
        tail,
        reissue(),
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  };

  const residentOutcome = (note: string): ShipOutcome => ({
    status: "aborted",
    reply:
      `📦 Ship needs a warm resident worktree for \`${entry.repo}\` and none is available (${note}). ` +
      `Ship v1 never falls back to cold per-round clones — onboard the repo as a resident (\`repo onboard ${entry.repo}\`) and re-issue ship.\n\n${reissue()}`,
  });

  const abortOutcome = (reason: string, tail?: string): ShipOutcome => ({
    status: "aborted",
    reply: [reason, tail, `⚠️ Ship aborted after ${roundsLine()}.`, reissue()].filter(Boolean).join("\n\n"),
  });

  /** The cap report's declined-vs-unaddressed split over the LAST review
   *  round's open findings (spec item 8), each answered only by a disposition
   *  recorded FOR it — its own round's, or one carried forward unchanged
   *  (`dispositionFor`): declined = a `declined` disposition; unaddressed =
   *  none; a finding claimed fixed but still flagged is named as such. */
  const splitReport = (): string => {
    // No review round ran → there are no findings to split; three "none"
    // lists under "Open findings from the last review (0)" would read as a
    // review that found nothing rather than a review that never happened.
    if (reviewRounds === 0) return "No review round ran before the cap — there are no findings to report.";
    const withDisposition = (f: Finding) => dispositionFor(f, reviewRounds);
    const declined = lastFindings.filter((f) => withDisposition(f)?.disposition === "declined");
    const unaddressed = lastFindings.filter((f) => !withDisposition(f));
    const claimedFixed = lastFindings.filter((f) => withDisposition(f)?.disposition === "fixed");
    const list = (items: Finding[], note?: (f: Finding) => string) =>
      items.length > 0
        ? items.map((f) => `  - ${formatFinding(f)}${note ? ` — ${note(f)}` : ""}`).join("\n")
        : "  - none";
    const lines = [
      `Open findings from the last review (${lastFindings.length}):`,
      `Declined (disposition recorded):\n${list(declined, (f) => withDisposition(f)?.note || "no note")}`,
      `Unaddressed (no disposition):\n${list(unaddressed)}`,
    ];
    if (claimedFixed.length > 0)
      lines.push(
        `Claimed fixed but still flagged:\n${list(claimedFixed, (f) => withDisposition(f)?.note || "no note")}`,
      );
    return lines.join("\n");
  };

  const capOutcome = (reason: string): ShipOutcome => ({
    status: "capped",
    reply: [
      `🧢 Ship stopped at a cap: ${reason} — no approval after ${roundsLine()}.${prUrl ? ` PR: ${prUrl}` : ""}`,
      splitReport(),
      reissue(),
    ].join("\n\n"),
  });
  const wallClockCap = () =>
    capOutcome(
      `the remaining pipeline time (~${Math.max(0, Math.round(remainingMs() / 60_000))} min of the ${caps.maxMinutes}-minute budget) cannot hold another round`,
    );

  /** One round as a `ship.round` span (docs/reference/specs/tracing.md), when traced. */
  const round = <T>(index: number, agentName: "coding" | "review", fn: (span: Span | undefined) => Promise<T>) =>
    input.span ? input.span.span("ship.round", fn, { attrs: { index, agent: agentName } }) : fn(undefined);

  const mergeReady = async (verdict: ReviewVerdict): Promise<ShipOutcome> => {
    // Re-check the PR (spec item 9) — the LGTM already triggered the org
    // auto-approve workflow, so the report must say what is left. Three
    // honest answers: still open (a human merge remains), no longer open
    // (nothing left), and UNKNOWN — a failed lookup is reported as
    // unverified, never as a closed PR (they mean opposite things to the
    // person holding the merge button).
    const facts = await github.prFacts({ repo: entry.repo, number: prNumber! }).catch(() => undefined);
    const where = prUrl ?? `${entry.repo}#${prNumber}`;
    // The declined findings this approval ratified: the fix round BEFORE the
    // approving review recorded them (an approve with no fix round — round 1,
    // or a resume straight to LGTM — has none). Never the flat all-rounds
    // set, where a reused finding id would resurrect a stale decline.
    const declined = [...(dispositionsByRound.get(reviewRounds - 1)?.values() ?? [])].filter(
      (d) => d.disposition === "declined",
    );
    return {
      status: "completed",
      reply: [
        `✅ Merge-ready after ${roundsLine()}: ${where}`,
        `Verdict: LGTM${verdict.summary ? ` — ${verdict.summary}` : ""}`,
        `Declined findings: ${declined.length > 0 ? declined.map((d) => `${d.findingId}${d.note ? ` — ${d.note}` : ""}`).join("; ") : "none"}`,
        facts === undefined
          ? `Note: approved and posted, but the PR's current state could not be re-verified — check ${where}.`
          : facts.state === "open"
            ? "Remaining gate: a human merge — ship never merges and never approves."
            : "Note: the PR is no longer open (merged or closed since the approval) — nothing is left to merge.",
      ].join("\n"),
    };
  };

  // ---- round 0 ---------------------------------------------------------------
  if (!entry.resume) {
    if (control.requested) return stoppedOutcome();
    if (remainingMs() < SHIP_ROUND_RESERVE_MS) return wallClockCap();
    // The pipeline branch must exist on origin BEFORE the first attach:
    // the resident refuses to bind a thread to a ref GitHub does not
    // have, and the executor factory's sandbox fallback would then misreport
    // "onboard the repo" on every fresh pipeline. The BOT creates the ref
    // from the PR base (422 already-exists is success inside createBranchRef
    // — a restarted pipeline reuses its own deterministic branch).
    if (entry.base === undefined) {
      return abortOutcome(
        `⚠️ No base branch is known for \`${entry.repo}\` (none resolved at dispatch, and the repository lookup answered no default), ` +
          `so the pipeline branch \`${entry.branch}\` could not be created and round 0 never started.`,
      );
    }
    try {
      await github.createBranchRef(entry.repo, entry.branch, entry.base);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return abortOutcome(
        `⚠️ Could not create the pipeline branch \`${entry.branch}\` from \`${entry.base}\` on \`${entry.repo}\`: ${reason} — round 0 never started.`,
      );
    }
    emitRound(0, "coding", "started");
    const r0 = await round(0, "coding", (span) =>
      runShipCodingChild(input, childCtx, { messages: input.round0Messages }, span),
    );
    // Submitted is a fact no ending erases: recorded before the checks below.
    if (r0.handoff) onHandoff(r0.handoff);
    if (r0.residentUnavailable) {
      emitRound(0, "coding", "aborted");
      return residentOutcome(r0.residentUnavailable);
    }
    if (r0.refusal) {
      emitRound(0, "coding", "aborted");
      return abortOutcome(r0.refusal);
    }
    if (r0.opened) {
      // Record the PR FIRST so a stop or terminal below reports its URL.
      prNumber = r0.opened.number;
      prUrl = r0.opened.url;
      lastReviewHead = r0.headSha;
    }
    if (control.requested) {
      emitRound(0, "coding", "stopped");
      return stoppedOutcome(r0.answer);
    }
    if (!r0.opened) {
      // Round-0 terminal other than "PR opened" (spec item 4): the child's
      // final text leads the reply — a clarifying question keeps the thread
      // alive (the user answers and re-enters) — and the terminal is named.
      emitRound(0, "coding", "aborted");
      const terminal = r0.description
        ? "a PR description was submitted but no PR could be opened (the note above says why)"
        : "the coding round ended without submitting a PR description (a clarifying question, a budget write-up, or an unproven push ends the pipeline here)";
      return {
        status: "aborted",
        reply: [
          r0.answer,
          r0.prNote,
          r0.handoffNote,
          `⚠️ Ship ended at round 0: ${terminal}. No review round ran.`,
          reissue(),
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
    }
    emitRound(0, "coding", "pr_opened");
    if (r0.prNote) await input.reply(r0.prNote).catch(() => {});
    // Where the handoff went (or why it did not) is a fact of the round the
    // thread sees, like the post-step's note.
    if (r0.handoffNote) await input.reply(r0.handoffNote).catch(() => {});
  }

  // ---- review → fix loop ------------------------------------------------------
  for (;;) {
    if (control.requested) return stoppedOutcome();
    if (reviewRounds >= caps.maxRounds) return capOutcome(`the ${caps.maxRounds}-round cap`);
    if (remainingMs() < SHIP_ROUND_RESERVE_MS) return wallClockCap();
    reviewRounds += 1;
    emitRound(reviewRounds, "review", "started");
    const rv = await round(reviewRounds, "review", (span) =>
      runShipReviewChild(
        input,
        childCtx,
        {
          index: reviewRounds,
          pr: prNumber!,
          // The PREVIOUS review round's findings with THAT round's
          // dispositions — never an accumulated flat set, where a
          // reused finding id would drag an old disposition along.
          prior:
            reviewRounds > 1
              ? {
                  findings: findingsByRound.get(reviewRounds - 1) ?? [],
                  dispositions: [...(dispositionsByRound.get(reviewRounds - 1)?.values() ?? [])],
                }
              : undefined,
        },
        span,
      ),
    );
    // A stop short-circuits here only when the round settled NO verdict: a
    // verdict that was already posted to the PR is a fact no stop can
    // un-post, so it settles first below and the stop is honored around it.
    if (control.requested && !rv.verdict) {
      emitRound(reviewRounds, "review", "stopped");
      return stoppedOutcome(rv.answer);
    }
    if (rv.residentUnavailable) {
      emitRound(reviewRounds, "review", "aborted");
      return residentOutcome(rv.residentUnavailable);
    }
    if (rv.refusal) {
      emitRound(reviewRounds, "review", "aborted");
      return abortOutcome(rv.refusal);
    }
    if (!rv.verdict) {
      // Spec item 5: a review child that ends without submit_verdict aborts the
      // pipeline — never converted into a request_changes it did not make.
      emitRound(reviewRounds, "review", "no_verdict");
      return abortOutcome(
        `⚠️ Review round ${reviewRounds} ended without a submitted verdict (budget, refusal, or stop) — ship never converts that into a request for changes, so no fix round ran.`,
        rv.answer ? `Review round's final message:\n\n${rv.answer}` : undefined,
      );
    }
    lastFindings = rv.verdict.findings ?? [];
    findingsByRound.set(reviewRounds, lastFindings);
    lastReviewHead = rv.reviewHead ?? lastReviewHead;
    emitRound(reviewRounds, "review", rv.verdict.verdict);
    if (rv.verdict.verdict === "approve") {
      // Merge-ready stands on the POSTED LGTM (spec item 9): an approval
      // whose post failed or was refused left no approving review on the PR,
      // so the pipeline must not report merge-ready over it.
      if (rv.reviewPost !== undefined && !rv.reviewPost.posted) {
        return abortOutcome(
          `⚠️ The review approved, but the approval could not be posted: ${rv.reviewPost.reason} — the PR carries no approving review. ` +
            `Re-run ship in this thread with the PR URL to retry the approval.`,
        );
      }
      return await mergeReady(rv.verdict);
    }
    // request_changes with a stop flagged during the round: the verdict above
    // settled (and posted) — now the stop short-circuits the fix round, and
    // the stopped report says a review is standing on the PR.
    if (control.requested) {
      return stoppedOutcome(
        [
          rv.answer,
          rv.reviewPost?.posted
            ? "ℹ️ A changes-requested review was posted this round before the stop — its findings stand on the PR."
            : undefined,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }
    // request_changes → a fix round, only if its re-review could still run.
    if (reviewRounds >= caps.maxRounds) return capOutcome(`the ${caps.maxRounds}-round cap`);
    if (remainingMs() < SHIP_ROUND_RESERVE_MS) return wallClockCap();
    emitRound(reviewRounds, "coding", "started");
    const fx = await round(reviewRounds, "coding", (span) =>
      runShipCodingChild(
        input,
        childCtx,
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: buildShipFixTurn({
                    where: `${entry.repo}#${prNumber}`,
                    findings: lastFindings,
                    review: rv.answer ?? "",
                  }),
                },
              ],
            },
          ],
          knownFindingIds: lastFindings.map((f) => f.id),
          attachHeadSha: lastReviewHead,
        },
        span,
      ),
    );
    if (fx.handoff) onHandoff(fx.handoff);
    if (fx.residentUnavailable) {
      emitRound(reviewRounds, "coding", "aborted");
      return residentOutcome(fx.residentUnavailable);
    }
    if (fx.refusal) {
      emitRound(reviewRounds, "coding", "aborted");
      return abortOutcome(fx.refusal);
    }
    // The round's dispositions answer THIS review round's findings — keyed by
    // the round, replace semantics (the tool's contract: a later call within
    // the round replaces the earlier one). Recorded before the stop check:
    // they were submitted, a fact a stop does not erase.
    if (fx.dispositions) dispositionsByRound.set(reviewRounds, new Map(fx.dispositions.map((d) => [d.findingId, d])));
    if (control.requested) {
      emitRound(reviewRounds, "coding", "stopped");
      return stoppedOutcome(fx.answer);
    }
    // A fix round that opened a NEW PR (the old one was closed out from under
    // the pipeline) is the pipeline's PR from here on: later review rounds
    // and every report target it.
    if (fx.opened?.created) {
      prNumber = fx.opened.number;
      prUrl = fx.opened.url;
    }
    // The post-step's note is a fact of the round the thread must see,
    // exactly like round 0's — a failed repush or PR edit must not vanish
    // into the log while the pipeline sails on.
    if (fx.prNote) await input.reply(fx.prNote).catch(() => {});
    if (fx.handoffNote) await input.reply(fx.handoffNote).catch(() => {});
    // Nothing repushed → usually nothing to re-review: a branch still at the
    // head the review already read would burn a review round on the very same
    // diff. ONE exception, by contract (spec item 7): a round that DECLINED
    // every finding of the last review changes no code on purpose — the
    // re-review exists to verify those arguments and may concede, so it still
    // runs (over the same head; the re-review-delta skill covers exactly
    // this). Anything else that moved no head — fixes claimed, findings left
    // unanswered — aborts, carrying the post-step's reason for why nothing
    // landed. (An unobservable fix-round head proves nothing and proceeds as
    // before.)
    const fixHead = normalizeHead(fx.headSha);
    const reviewedAt = normalizeHead(lastReviewHead);
    if (fixHead !== undefined && reviewedAt !== undefined && sameCommit(fixHead, reviewedAt)) {
      const roundDispositions = dispositionsByRound.get(reviewRounds);
      const allDeclined =
        lastFindings.length > 0 && lastFindings.every((f) => roundDispositions?.get(f.id)?.disposition === "declined");
      if (!allDeclined) {
        emitRound(reviewRounds, "coding", "aborted");
        return abortOutcome(
          `⚠️ Fix round ${reviewRounds} produced no new head — the branch still sits at \`${fixHead.slice(0, 7)}\`, the commit the review already read, and not every finding was declined on the record, so there is nothing new to re-review.`,
          fx.prNote,
        );
      }
    }
    emitRound(reviewRounds, "coding", fx.opened ? "pr_opened" : "completed");
  }
}
