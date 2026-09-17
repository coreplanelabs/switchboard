// The review run's verdict turn (docs/reference/specs/agent-review.md item 5):
// the prompt requires `submit_verdict` before the final message, and the
// posted body is built fail-closed — no call, and the review posts as
// `No verdict submitted — not approving.` whatever its prose concluded. A
// prompt rule alone can be skipped: a run has written `Verdict: approve` in
// its write-up and never called the tool, so the auto-approve workflow (which
// keys on the `LGTM:` token the tool produces) sat out a review that approved
// in words. So when a review run's model loop ends on a pull request with no
// verdict submitted, the run loop gives the same run ONE more bounded model
// turn asking for the call — after the head settle (whose re-review turn asks
// for a fresh verdict itself, so a moved head is never nudged twice) and
// before the post step reads the verdict. Mirrors the coding run's description turn
// (descriptionTurn.ts): one more `prompt` on the run's own pi session
// (docs/reference/specs/harness-pi.md item 14), through the seam the run stage
// hands over (`followUp`), on the same tool context — so the verdict arrives
// through the same `onVerdict` hook the loop fed, and the ledger row sees it —
// and its tool events join the run record like any other. The turn asks for
// the verdict alone: the write-up stands, the diff is not re-read, and the
// turn's own reply is dropped. Fail-closed is untouched: a turn that still
// submits nothing posts the no-verdict line as before. A run with no session
// to prompt — a `finish` plan, whose loop answered in a previous bot
// generation and whose pi is gone — runs no turn and reports nothing.

import type { AgentDef } from "../agents/registry.js";
import type { ToolContext } from "../tools/runnableTool.js";
import type { FollowUpTurn } from "./harness/contract.js";
import type { ReviewVerdict } from "./reviewVerdict.js";
import { postStepLease } from "./budgets.js";
import type { RunEvent } from "./runEvents.js";
import { systemClock } from "./trace/clock.js";
import type { Span } from "./trace/types.js";

/** The turn's turn guard, well under the review agent's own: one
 *  `git rev-parse HEAD`, one submit, one line back. Its minutes are the review
 *  post-step's allowance carved from the lease's remainder (`postStepLease`,
 *  decision 0046). */
export const VERDICT_TURN_MAX_TURNS = 4;
/** The tools the turn may call (model-proxy item 6): read the head, submit
 *  the verdict, report on the card — nothing that writes. */
export const VERDICT_TURN_TOOLS: readonly string[] = ["bash", "read", "submit_verdict", "update_status"];

/** The pull request the review was of — what the turn names. */
export interface VerdictTurnTarget {
  repo: string;
  number: number;
}

/** The user turn appended to the run's messages: what is missing, what the
 *  call must carry, and what the turn must not do. */
export function verdictFollowUp(t: VerdictTurnTarget): string {
  return [
    `Your review of ${t.repo}#${t.number} ended without calling submit_verdict. Switchboard writes the verdict as the first line of the posted review from that call alone — without it the review posts as "No verdict submitted — not approving", whatever your write-up concluded.`,
    "Call submit_verdict now, exactly once, with the verdict your write-up already states: `approve` when you found no blocking issue (nits alone are not blocking), otherwise `request_changes`; a one-line summary; `head` = the output of `git rev-parse HEAD` in the checkout you reviewed; and `findings` — one structured entry per issue your write-up reports, with the ids you used (F1, F2, …), a severity of exactly blocking|major|minor|nit, the file (plus line when it points at one) and a one-line title.",
    "Do not re-read the diff and do not rewrite the review — your write-up stands as the review's text; only the verdict is missing. Then reply in one line.",
  ].join("\n");
}

/** Everything a second model turn on this run needs — the same shape the
 *  description turn takes (descriptionTurn.ts CodingTurnSpec). */
export interface ReviewVerdictTurnSpec {
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
 * Run the verdict turn: publish the `verdict_turn` run note and prompt the
 * run's pi session once more with the follow-up (`followUp`), under a clip
 * below the agent's own budgets (`VERDICT_TURN_MAX_TURNS`; the review
 * post-step's minutes, carved from the lease's remainder). The verdict arrives through the tool context's
 * `onVerdict` hook — the same one the loop fed — and is ALSO returned, so the
 * caller can tell "submitted" from "the turn ran and still submitted nothing"
 * without reaching into its own state. Never throws past a turn failure: a
 * turn that fails is logged and reported as having submitted nothing, and the
 * post step's fail-closed line stands. Without a session to prompt (a `finish`
 * plan) the note says so and nothing is submitted.
 */
export async function runVerdictTurn(input: {
  span?: Span;
  target: VerdictTurnTarget;
  turn: ReviewVerdictTurnSpec;
  logKey: string;
}): Promise<{ verdict: ReviewVerdict | undefined }> {
  const { target: t, turn, logKey } = input;
  const where = `${t.repo}#${t.number}`;
  if (!turn.followUp) {
    const summary = `the review of ${where} ended without submit_verdict — no session to ask on (the loop answered before a restart), so it posts as not approving`;
    console.log(`[verdict-turn] ${logKey} ${summary}`);
    turn.onEvent({ type: "run_note", kind: "verdict_turn", summary, at: systemClock() });
    return { verdict: undefined };
  }
  const summary = `the review of ${where} ended without submit_verdict — asking for the verdict (one turn)`;
  console.log(`[verdict-turn] ${logKey} ${summary}`);
  turn.onEvent({ type: "run_note", kind: "verdict_turn", summary, at: systemClock() });
  turn.onProgress(`asking for the verdict on ${where}`);
  let submitted: ReviewVerdict | undefined;
  const toolContext: ToolContext = {
    ...turn.toolContext,
    onVerdict: (v) => {
      submitted = v;
      turn.toolContext.onVerdict?.(v);
    },
  };
  try {
    // The turn's own one-line reply is deliberately dropped: the run's answer
    // stays the loop's write-up, and the posted body's first line — built from
    // the verdict — is what tells the reader the outcome. The verdict, the
    // turn's only deliverable, arrives through the hook.
    await turn.followUp({
      text: verdictFollowUp(t),
      maxTurns: Math.min(turn.agent.maxTurns, VERDICT_TURN_MAX_TURNS),
      maxMinutes: Math.min(turn.agent.maxMinutes, postStepLease("review", turn.remainingMs?.())),
      tools: VERDICT_TURN_TOOLS,
      toolContext,
      ...(input.span ? { span: input.span } : {}),
    });
  } catch (err) {
    console.error(`[verdict-turn] ${logKey} turn failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(
    `[verdict-turn] ${logKey} ${submitted ? `verdict submitted (${submitted.verdict})` : "still no verdict"} for ${where}`,
  );
  return { verdict: submitted };
}
