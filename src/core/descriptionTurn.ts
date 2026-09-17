// The coding run's description turn (docs/reference/specs/pr-description.md item 5,
// agent-coding.md item 3): the prompt requires a resubmitted PR description
// after EVERY push to a PR that already exists, whoever opened it. A prompt
// rule can be rationalized away ("it is dependabot's PR, its body should
// stay") and the system cannot author the description itself — so when a
// coding run's model loop ends with a proven push onto a branch that already
// heads an open PR and no `submit_pr_description` call, the dispatcher runs
// ONE more bounded model turn asking for it, before the answer lands and
// before the workspace is released. Mirrors the review agent's re-review turn
// (reviewRound.ts settleReviewedHead): the turn is one more `prompt` on the
// run's own pi session (docs/reference/specs/harness-pi.md item 14), through
// the seam the run stage hands over (`followUp`), on the same tool context —
// so the description arrives through the same `onPrDescription` hook the
// first turn used — and its tool events join the run record like any other.
// What it may cost is capped below the agent's own budgets; what it must not
// do (push again, open a PR) is said in the prompt. A run with no session to
// prompt — a `finish` plan, whose loop answered in a previous bot generation
// and whose pi is gone — runs no turn and reports nothing submitted; the
// post-step's note then says the description was not resubmitted.
//
// Two pieces, so each is testable alone: `descriptionTurnTarget` decides — no
// description, a push the remote proves, a branch that is not the base, an
// open PR heading it (the same lookup open-or-edit starts with; a failed
// lookup means no turn, never a throw) — and `runDescriptionTurn` runs the
// turn and reports what it submitted.

import type { AgentDef } from "../agents/registry.js";
import { resolveBaseRef, type OpenPrRef } from "../execution/githubPulls.js";
import type { ToolContext } from "../tools/runnableTool.js";
import { postStepLease } from "./budgets.js";
import type { CodingPrTarget, WorkspaceObservation } from "./codingPrPostStep.js";
import type { FollowUpTurn } from "./harness/contract.js";
import type { PrDescription } from "./prDescription.js";
import { normalizeHead, sameCommit } from "./reviewedHead.js";
import type { RunEvent } from "./runEvents.js";
import { systemClock } from "./trace/clock.js";
import type { Span } from "./trace/types.js";

/** The turn's turn guard, well under the coding agent's own: one read of the
 *  PR, one look at the diff, one submit, one line back. Its minutes are the
 *  coding post-step's allowance carved from the lease's remainder
 *  (`postStepLease`, decision 0046). */
export const DESCRIPTION_TURN_MAX_TURNS = 8;

/** What the turn is about: the pushed branch, its proven head, and the open
 *  PR that branch heads. */
export interface DescriptionTurnTarget {
  repo: string;
  branch: string;
  /** The pushed head — the commit the remote holds for `branch`. */
  headSha: string;
  pr: OpenPrRef;
}

/**
 * Whether a description turn is due, and for what. Due when ALL hold: no
 * description was submitted; a repo is known; the pushed branch is observed
 * and the remote holds it at the observed head (pushed is proven, never
 * inferred — codingPrPostStep.ts); the branch is not the base (nothing was
 * pushed to open a PR from otherwise); and an open PR heads the branch. The
 * base is resolved from the target's three signals only — no GitHub fetch:
 * with no signal at all, an unknown base cannot equal the branch, so the
 * branch counts as pushed, exactly as the post-step reads it. A lookup that
 * throws is logged and means no turn: the post-step then reports the push as
 * it does today.
 */
export async function descriptionTurnTarget(input: {
  observed: WorkspaceObservation;
  description: PrDescription | undefined;
  target: CodingPrTarget;
  findOpenPr: (repo: string, branch: string) => Promise<OpenPrRef | null>;
  logKey: string;
}): Promise<DescriptionTurnTarget | undefined> {
  const { observed, target } = input;
  if (input.description !== undefined) return undefined;
  const repo = target.repo ?? observed.remoteRepo;
  const branch = observed.branch;
  const headSha = normalizeHead(observed.head);
  const remoteHead = normalizeHead(observed.remoteHead);
  if (repo === undefined || branch === undefined || headSha === undefined || remoteHead === undefined) return undefined;
  if (!sameCommit(remoteHead, headSha)) return undefined;
  const base = resolveBaseRef([target.baseRef, target.bindingRef, target.resolvedRef], undefined);
  if (branch === base) return undefined;
  const pr = await input.findOpenPr(repo, branch).catch((err: unknown) => {
    console.error(
      `[description-turn] ${input.logKey} open-PR lookup failed for ${repo} ${branch}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  });
  if (!pr) return undefined;
  return { repo, branch, headSha, pr };
}

/** The user turn appended to the run's messages: what happened, what is
 *  missing, the three steps, and the two things the turn must not do. */
export function descriptionFollowUp(t: DescriptionTurnTarget): string {
  const short = t.headSha.slice(0, 7);
  return [
    `You pushed \`${t.branch}\` at \`${short}\` — that branch is the head of the open pull request ${t.pr.htmlUrl} (${t.repo}#${t.pr.number}) — but you did not call submit_pr_description, so the PR's title and body were not re-evaluated against what you pushed. A PR describing an earlier state of its branch is a bug, whoever opened it. Do this now, in this turn:`,
    `1. Read the PR's current title and body: call github_issue_get with repo \`${t.repo}\` and number ${t.pr.number} (it takes a pull request number).`,
    `2. Compare them with the change as it now stands at \`${short}\` (diff_digest where available; otherwise git diff against the base).`,
    `3. Call submit_pr_description with the object that describes the PR as it is NOW: carry forward what the existing body says that is still true (a dependency bump's release notes belong in why), add what you pushed, and anchor the pointers at \`${t.headSha}\`.`,
    `Do not push again and do not open a PR — Switchboard re-renders the PR's title and body from your object at ${short}. Then reply in one line.`,
  ].join("\n");
}

/** Everything a second model turn on this run needs — the same shape the
 *  re-review turn takes (reviewRound.ts ReviewTurnSpec). */
export interface CodingTurnSpec {
  /** The preset with its effective budget; the turn's clip is taken from it. */
  agent: AgentDef;
  toolContext: ToolContext;
  onProgress: (note: string) => void;
  onEvent: (event: RunEvent) => void;
  /** One more turn on the run's own pi session (harness-pi item 14). Absent —
   *  a `finish` plan, whose session ended with the previous generation — the
   *  turn is not run and nothing is submitted. */
  followUp?: FollowUpTurn;
  /** What the run's lease still holds, read at the call (`HarnessSession.remainingMs`):
   *  the turn's minutes are carved from it. Absent, the allowance stands. */
  remainingMs?: () => number;
}

/**
 * Run the description turn: publish the `description_turn` run note and prompt
 * the run's pi session once more with the follow-up (`followUp`), under a clip
 * below the agent's own budgets (`DESCRIPTION_TURN_MAX_TURNS`; the coding
 * post-step's minutes, carved from the lease's remainder). The description arrives through the tool
 * context's `onPrDescription` hook — the same one the first turn fed — and is
 * ALSO returned, so the caller can tell "submitted" from "the turn ran and
 * still submitted nothing" without reaching into its own state. Never throws
 * past a turn failure: a turn that fails is logged and reported as having
 * submitted nothing. Without a session to prompt (a `finish` plan) the note
 * says so and nothing is submitted.
 */
export async function runDescriptionTurn(input: {
  span?: Span;
  target: DescriptionTurnTarget;
  turn: CodingTurnSpec;
  logKey: string;
}): Promise<{ description: PrDescription | undefined }> {
  const { target: t, turn, logKey } = input;
  if (!turn.followUp) {
    const summary = `pushed ${t.branch} onto the open ${t.repo}#${t.pr.number} without resubmitting its description — no session to ask on (the loop answered before a restart), so the description stands as it was`;
    console.log(`[description-turn] ${logKey} ${summary}`);
    turn.onEvent({ type: "run_note", kind: "description_turn", summary, at: systemClock() });
    return { description: undefined };
  }
  const summary = `pushed ${t.branch} onto the open ${t.repo}#${t.pr.number} without resubmitting its description — asking for it (one turn)`;
  console.log(`[description-turn] ${logKey} ${summary}`);
  turn.onEvent({ type: "run_note", kind: "description_turn", summary, at: systemClock() });
  turn.onProgress(`re-evaluating the description of ${t.repo}#${t.pr.number} at ${t.headSha.slice(0, 7)}`);
  let submitted: PrDescription | undefined;
  const followUpText = descriptionFollowUp(t);
  const toolContext: ToolContext = {
    ...turn.toolContext,
    onPrDescription: (d) => {
      submitted = d;
      turn.toolContext.onPrDescription?.(d);
    },
  };
  try {
    // The turn's own one-line reply is deliberately dropped: the run's answer
    // stays the first loop's, and the post-step's "PR updated: … body
    // re-rendered at <sha>" note is what tells the reader the outcome. The
    // description — the turn's only deliverable — arrives through the hook.
    await turn.followUp({
      text: followUpText,
      maxTurns: Math.min(turn.agent.maxTurns, DESCRIPTION_TURN_MAX_TURNS),
      maxMinutes: Math.min(turn.agent.maxMinutes, postStepLease("coding", turn.remainingMs?.())),
      toolContext,
      ...(input.span ? { span: input.span } : {}),
    });
  } catch (err) {
    console.error(`[description-turn] ${logKey} turn failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(
    `[description-turn] ${logKey} ${submitted ? "description resubmitted" : "still no description"} for ${t.repo}#${t.pr.number}`,
  );
  return { description: submitted };
}
