// One review child of the ship pipeline (docs/reference/specs/agent-ship.md
// items 5, 9): the pinned-head review over the extracted units the plain
// review run uses. It pins the PR head, refuses an unknown one with the one
// wording, attaches the resident worktree at that head and guards it, runs the
// review child clipped to the pipeline's remaining wall clock on the
// synthesized review turn, settles the reviewed head, and posts the verdict
// pinned to it. Every way the round can end is a `ReviewRoundResult`; the
// loop in shipPipeline.ts decides what each one means — above all, that
// merge-ready stands on a POSTED approval.

import type { ChatMessage } from "../../providers/types.js";
import type { ReviewCommentTarget } from "../../execution/githubComments.js";
import type { ToolContext } from "../../tools/workspace.js";
import type { Span } from "../trace/types.js";
import { runAgent } from "../../runner.js";
import { formatFinding, type Finding, type FindingDisposition, type ReviewVerdict } from "../reviewVerdict.js";
import type { DigestReport } from "../diffDigest.js";
import { normalizeHead } from "../reviewedHead.js";
import {
  attachRoundWorkspace,
  checkPrHeadPreflight,
  guardAttachedHead,
  makeSystemComposer,
  runReviewPostStep,
  settleReviewedHead,
  type FetchPrCommits,
  type FetchPrHead,
  type ReviewPostOutcome,
} from "../reviewRound.js";
import type { ChildRoundContext, ChildRoundDeps } from "./childRound.js";
import { DEFAULT_CONTRACT_MAX_CHARS, renderContract, type ChildContract } from "./contract.js";

/** The GitHub seam a review round reads and writes through: the PR head it
 *  pins and re-reads, the commits since the base, and the pinned review post. */
export interface ReviewChildGithub {
  postReviewComment: (target: ReviewCommentTarget, body: string) => Promise<void>;
  fetchPrHead: FetchPrHead;
  fetchPrCommits: FetchPrCommits;
}

/** What a review round reads beyond the shared child slice. */
export interface ReviewChildDeps extends ChildRoundDeps {
  /** Thread reply for mid-pipeline notes: the round's head-moved and review-post
   *  notes here; the loop sends a coding round's PR note through the same hook. */
  reply: (text: string) => Promise<void>;
  github: ReviewChildGithub;
}

/** The review child's one user turn. Re-review rounds carry the prior findings
 *  and the fix round's dispositions; the `re-review-delta` skill (scoped to the
 *  review agent) narrows READING only — the verdict still covers the full diff. */
export function buildShipReviewTurn(input: {
  where: string;
  round: number;
  headSha?: string;
  prior?: { findings: Finding[]; dispositions: FindingDisposition[] };
}): string {
  const at = input.headSha ? ` at head \`${input.headSha}\`` : "";
  if (input.round <= 1 || !input.prior) {
    return `Review pull request ${input.where}${at}. Submit your verdict with findings via submit_verdict before your final message.`;
  }
  const findings = input.prior.findings.map(formatFinding).join("\n") || "(none recorded)";
  const dispositions =
    input.prior.dispositions.map((d) => `${d.findingId}: ${d.disposition}${d.note ? ` — ${d.note}` : ""}`).join("\n") ||
    "(none recorded)";
  return (
    `Re-review pull request ${input.where}${at} — review round ${input.round} of this ship pipeline. ` +
    `Load the \`re-review-delta\` skill: narrow your READING to the delta since the previously reviewed head and verify each prior finding's disposition, ` +
    `but your verdict still covers the full diff against base. Carry every unresolved prior finding forward under its existing id.\n\n` +
    `Previous round's findings:\n${findings}\n\nFix round's dispositions:\n${dispositions}`
  );
}

export interface ReviewRoundResult {
  refusal?: string;
  residentUnavailable?: string;
  verdict?: ReviewVerdict;
  answer?: string;
  reviewHead?: string;
  /** Whether the round's verdict actually landed on the PR — the merge-ready
   *  gate consumes it (an approve whose post failed approves nothing). */
  reviewPost?: ReviewPostOutcome;
}

/** Which review round this is, of which PR, and what the previous round left
 *  it: THAT round's findings with THAT round's dispositions — never an
 *  accumulated flat set, where a reused finding id would drag an old
 *  disposition along. Absent on the first review round. */
export interface ReviewRound {
  index: number;
  pr: number;
  prior?: { findings: Finding[]; dispositions: FindingDisposition[] };
  /** The plan unit's contract — the SAME object the coding child was handed —
   *  rendered after the REVIEW TARGET block so the diff is judged against it
   *  (docs/reference/specs/agent-ship.md item 13). Absent on a task-string pipeline. */
  contract?: ChildContract;
}

/**
 * One review child (pinned head, extracted units). Never throws for an
 * unknown head, a refused attach or a missing resident — those are results; a
 * failure inside the child's run propagates after the workspace is released.
 */
export async function runShipReviewChild(
  input: ReviewChildDeps,
  ctx: ChildRoundContext,
  round: ReviewRound,
  roundSpan: Span | undefined,
): Promise<ReviewRoundResult> {
  const { entry, clip } = ctx;
  const { control, github, logKey } = input;
  const { index: roundIndex, pr: prNumber, prior } = round;
  // Read at CALL time behind a function boundary: a stop can land during any
  // await, and TS's property narrowing must not freeze an earlier read.
  const hardStopped = () => control.requested === "hard";
  const spec = input.child("review");
  const pr = { repo: entry.repo, number: prNumber };
  let pinned = normalizeHead(await github.fetchPrHead(pr).catch(() => undefined));
  // Unknown head is a guaranteed downstream refusal — reuse the extracted
  // pre-flight so the refusal reply has ONE wording.
  const pf = checkPrHeadPreflight({
    agent: spec.agent,
    requestText: "",
    repoCtx: { repo: entry.repo, pr: prNumber, headSha: pinned },
  });
  if (!pf.ok) return { refusal: pf.reply };
  const ws = await attachRoundWorkspace({
    factory: input.factory,
    round: { threadKey: input.threadKey, agent: spec.agent, repo: entry.repo, ref: entry.branch, headSha: pinned },
    logKey,
  });
  const { executor, resident, binding, note } = ws.selection;
  if (resident !== true) {
    await ws.release({ hardStopped: false, ...(roundSpan ? { span: roundSpan } : {}) });
    return { residentUnavailable: note ?? "no resident worktree attached" };
  }
  let settled: Awaited<ReturnType<typeof settleReviewedHead>> | undefined;
  let verdict: ReviewVerdict | undefined;
  // The round's diff digest (diff_digest → onDigest), for the post-step's
  // coverage guard. Ship holds no PR size for the round — the PR's facts were
  // read at preflight and every fix round moves them — so the guard here
  // refuses only a digest that could not state its totals.
  let digest: DigestReport | undefined;
  try {
    let verified = false;
    const guard = await guardAttachedHead({
      pr,
      expectedHeadSha: pinned,
      attached: { sha: binding?.sha, ref: binding?.ref },
      fallbackRef: entry.branch,
      fetchPrHead: github.fetchPrHead,
      logKey,
    });
    if (guard.outcome === "refused") return { refusal: guard.reply };
    if (guard.outcome === "adopted") {
      pinned = guard.headSha;
      verified = true;
    } else if (guard.outcome === "verified") {
      verified = true;
    }
    const toolContext: ToolContext = {
      executor,
      reportProgress: input.reportProgress,
      web: input.web,
      skills: input.skills,
      github: input.githubTools,
      agentName: spec.agent.name,
      onVerdict: (v) => {
        verdict = v;
      },
      onDigest: (d) => {
        digest = d;
      },
    };
    const composeSystem = makeSystemComposer({
      agent: spec.agent,
      resident: true,
      repo: entry.repo,
      workspace: binding?.workspace,
      prTarget: { repo: entry.repo, pr: pr.number, ref: entry.branch, baseRef: entry.base },
      ...(round.contract
        ? { contract: renderContract(round.contract, { maxChars: DEFAULT_CONTRACT_MAX_CHARS }).text }
        : {}),
      blocks: input.blocks(spec),
    });
    const clipped = clip(spec.agent);
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildShipReviewTurn({
              where: `${entry.repo}#${pr.number}`,
              round: roundIndex,
              headSha: pinned,
              prior,
            }),
          },
        ],
      },
    ];
    const answer = await runAgent({
      provider: spec.provider,
      model: spec.model,
      agent: clipped,
      messages,
      ...(roundSpan ? { span: roundSpan } : {}),
      backend: ws.selection.backend,
      system: composeSystem({ sha: pinned, verified }),
      effort: spec.effort,
      toolContext,
      onProgress: input.onProgress,
      onEvent: input.onEvent,
      control,
      inbox: input.inbox,
    });
    if (control.requested === "hard") return { answer };
    settled = await settleReviewedHead({
      ...(roundSpan ? { span: roundSpan } : {}),
      pr,
      baseRef: entry.base,
      reviewHead: pinned,
      verdict,
      answer,
      messages,
      composeSystem,
      executor,
      turn: {
        provider: spec.provider,
        model: spec.model,
        agent: clipped,
        effort: spec.effort,
        toolContext,
        onProgress: input.onProgress,
        onEvent: input.onEvent,
        control,
      },
      fetchPrHead: github.fetchPrHead,
      fetchPrCommits: github.fetchPrCommits,
      notify: { reply: input.reply, headMoved: (suffix) => input.onProgress(`head moved: ${suffix}`) },
      logKey,
    });
  } finally {
    await ws.release({ hardStopped: control.requested === "hard", ...(roundSpan ? { span: roundSpan } : {}) });
  }
  // Unreachable: every path that leaves `settled` unassigned returned above
  // (guard refusal, hard stop) — this narrows the type for what follows.
  if (!settled) return {};
  // The pinned review post (extracted unit): posts only when the reviewed
  // head IS the pinned head, says every skip out loud, never throws. Its
  // typed outcome rides back to the loop — the merge-ready gate stands on
  // a POSTED approval, not on a verdict that never reached the PR.
  const reviewPost = await runReviewPostStep({
    agent: spec.agent,
    requestText: "",
    repoCtx: { repo: entry.repo, pr: prNumber },
    heads: { reviewHead: settled.reviewHead, observedHead: settled.observedHead },
    verdict: settled.verdict,
    digest,
    answer: settled.answer,
    carried: settled.carried,
    hardStopped: hardStopped(),
    post: github.postReviewComment,
    fetchPrHead: github.fetchPrHead,
    reply: input.reply,
    logKey,
  });
  return { verdict: settled.verdict, answer: settled.answer, reviewHead: settled.reviewHead, reviewPost };
}
