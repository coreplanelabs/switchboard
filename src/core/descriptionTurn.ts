// The coding run's description turn (docs/reference/specs/pr-description.md item 5,
// agent-coding.md item 3): the prompt requires a resubmitted PR description
// after EVERY push to a PR that already exists, whoever opened it. A prompt
// rule can be rationalized away ("it is dependabot's PR, its body should
// stay") and the system cannot author the description itself — so when a
// coding run's model loop ends with a proven push onto a branch that already
// heads an open PR and no `submit_pr_description` call, the dispatcher runs
// ONE more bounded model turn asking for it, before the answer lands and
// before the workspace is released. Mirrors the review agent's re-review turn
// (reviewRound.ts settleReviewedHead): the turn is appended to the run's own
// message list (the seed, the run's answer, this follow-up), runs on the same
// tool context — so the description arrives through the same
// `onPrDescription` hook the first turn used — and its tool events join the
// run record like any other. What it may cost is capped below the agent's own
// budgets; what it must not do (push again, open a PR) is said in the prompt.
//
// Two pieces, so each is testable alone: `descriptionTurnTarget` decides — no
// description, a push the remote proves, a branch that is not the base, an
// open PR heading it (the same lookup open-or-edit starts with; a failed
// lookup means no turn, never a throw) — and `runDescriptionTurn` runs the
// turn and reports what it submitted.

import type { AgentDef } from "../agents/registry.js";
import type { Effort } from "../effort.js";
import { resolveBaseRef, type OpenPrRef } from "../execution/githubPulls.js";
import type { ChatMessage, Provider } from "../providers/types.js";
import { runAgent } from "../runner.js";
import type { RunnableTool, ToolContext } from "../tools/workspace.js";
import type { CodingPrTarget, WorkspaceObservation } from "./codingPrPostStep.js";
import type { PrDescription } from "./prDescription.js";
import { normalizeHead, sameCommit } from "./reviewedHead.js";
import type { RunControl } from "./runRegistry.js";
import type { RunEvent } from "./runEvents.js";
import type { Backend } from "./trace/attrs.js";
import { systemClock } from "./trace/clock.js";
import type { Span } from "./trace/types.js";

/** The turn's budget, below the coding agent's own (60 turns / 45 min): one
 *  read of the PR, one look at the diff, one submit, one line back. */
export const DESCRIPTION_TURN_MAX_TURNS = 8;
export const DESCRIPTION_TURN_MAX_MINUTES = 5;

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
    `3. Call submit_pr_description with the object that describes the PR as it is NOW: carry forward what the existing body says that is still true (a dependency bump's release notes belong in whatWhy), add what you pushed, and anchor the Tour at \`${t.headSha}\`.`,
    `Do not push again and do not open a PR — Switchboard re-renders the PR's title and body from your object at ${short}. Then reply in one line.`,
  ].join("\n");
}

/** Everything a second model turn on this run needs — the same shape the
 *  re-review turn takes (reviewRound.ts ReviewTurnSpec). */
export interface CodingTurnSpec {
  /** Where the turn's commands execute (docs/reference/specs/tracing.md). */
  backend?: Backend;
  provider: Provider;
  model: string;
  agent: AgentDef;
  effort?: Effort;
  toolContext: ToolContext;
  /** This run's per-run tools (bridged MCP tools) — the turn sees exactly what
   *  the first turn saw (docs/reference/specs/mcp-tools.md item 12). */
  extraTools?: RunnableTool[];
  onProgress: (note: string) => void;
  onEvent: (event: RunEvent) => void;
  control: RunControl;
}

/**
 * Run the description turn: publish the `description_turn` run note, append
 * the run's answer and the follow-up to its messages IN PLACE, and run the
 * agent once more on a clipped COPY of its def (never the shared AgentDef).
 * The description arrives through the tool context's `onPrDescription` hook
 * — the same one the first turn fed — and is ALSO returned, so the caller can
 * tell "submitted" from "the turn ran and still submitted nothing" without
 * reaching into its own state. Never throws past a runner failure: a turn
 * that fails is logged and reported as having submitted nothing.
 */
export async function runDescriptionTurn(input: {
  span?: Span;
  target: DescriptionTurnTarget;
  /** The run's answer so far — appended as the assistant turn before the follow-up. */
  answer: string;
  /** The run's message list — the turn appends to it IN PLACE. */
  messages: ChatMessage[];
  system: string | undefined;
  turn: CodingTurnSpec;
  logKey: string;
}): Promise<{ description: PrDescription | undefined }> {
  const { target: t, turn, logKey } = input;
  const summary = `pushed ${t.branch} onto the open ${t.repo}#${t.pr.number} without resubmitting its description — asking for it (one turn)`;
  console.log(`[description-turn] ${logKey} ${summary}`);
  turn.onEvent({ type: "run_note", kind: "description_turn", summary, at: systemClock() });
  turn.onProgress(`re-evaluating the description of ${t.repo}#${t.pr.number} at ${t.headSha.slice(0, 7)}`);
  let submitted: PrDescription | undefined;
  input.messages.push(
    { role: "assistant", content: [{ type: "text", text: input.answer }] },
    { role: "user", content: [{ type: "text", text: descriptionFollowUp(t) }] },
  );
  const agent: AgentDef = {
    ...turn.agent,
    maxTurns: Math.min(turn.agent.maxTurns, DESCRIPTION_TURN_MAX_TURNS),
    maxMinutes: Math.min(turn.agent.maxMinutes, DESCRIPTION_TURN_MAX_MINUTES),
  };
  try {
    // The turn's own one-line reply is deliberately dropped: the run's answer
    // stays the first loop's, and the post-step's "PR updated: … body
    // re-rendered at <sha>" note is what tells the reader the outcome. The
    // description — the turn's only deliverable — arrives through the hook.
    await runAgent({
      provider: turn.provider,
      model: turn.model,
      agent,
      messages: input.messages,
      ...(input.system !== undefined ? { system: input.system } : {}),
      ...(turn.effort !== undefined ? { effort: turn.effort } : {}),
      ...(input.span ? { span: input.span } : {}),
      ...(turn.backend ? { backend: turn.backend } : {}),
      toolContext: {
        ...turn.toolContext,
        onPrDescription: (d) => {
          submitted = d;
          turn.toolContext.onPrDescription?.(d);
        },
      },
      ...(turn.extraTools && turn.extraTools.length > 0 ? { extraTools: turn.extraTools } : {}),
      onProgress: turn.onProgress,
      onEvent: turn.onEvent,
      control: turn.control,
    });
  } catch (err) {
    console.error(`[description-turn] ${logKey} turn failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(
    `[description-turn] ${logKey} ${submitted ? "description resubmitted" : "still no description"} for ${t.repo}#${t.pr.number}`,
  );
  return { description: submitted };
}
