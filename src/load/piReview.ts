// The review suite of `load:pi` (docs/reference/specs/load-harness.md, the
// review suite item): what a review task's pi is told and how its run is
// scored. The framing is the production one — the registry's resident review
// prompt composed as a review run composes it, with the REVIEW TARGET block,
// then the read identity's harness note — plus one note on the relayed tools
// this driver cannot offer, since there is no bot behind it. The scoring is
// the post-step's own judgement without the post: the verdict parsed by the
// same parser, the head held against the pinned one by the same guard, the
// body the post-step would have posted rendered by the same function — and
// the read-only facts a review must leave behind: no write tool ran and the
// checkout is untouched.

import { AGENTS } from "../agents/registry.js";
import { harnessPromptNote } from "../core/harness/pi/process.js";
import { makeSystemComposer } from "../core/reviewRound.js";
import { buildReviewPostBody, parseVerdictInput, type ReviewVerdict } from "../core/reviewVerdict.js";
import { checkReviewedHead, normalizeHead } from "../core/reviewedHead.js";
import type { SloCheck } from "./aggregate.js";
import type { PiTaskRun } from "./piRpc.js";
import { reviewTaskUrl, type PiReviewTask } from "./piReviewTasks.js";

/** The one tool the driver relays for a review: the verdict. */
export const REVIEW_RELAY_TOOLS: readonly string[] = ["submit_verdict"];

/** The readonly toolset's other relays, which the production harness serves
 *  from the bot and this driver has no bot to serve from. */
const ABSENT_RELAYS: readonly string[] = ["diff_digest", "update_status", "web_fetch", "list_skills", "use_skill"];

/** The tools a review run must never call: pi's own writes, and the coding
 *  preset's terminal tool. Off the allowlist, so a call is pi's refusal —
 *  listed on the receipt either way. */
export const PI_WRITE_TOOLS: readonly string[] = ["edit", "write", "submit_pr_description"];

/** Where a review task runs: the repository the checkout's origin names and the checkout itself. */
export interface ReviewSite {
  repo: string;
  checkout: string;
}

/** The system prompt a review task's pi reads: the registry's resident review
 *  prompt composed by the run loop's own composer (the REVIEW TARGET block
 *  names the task's pull request, head and base; the worktree is the
 *  checkout), the read identity's harness note, and the driver's note. */
export function reviewSystemPrompt(task: PiReviewTask, site: ReviewSite): string {
  const { repo, checkout } = site;
  const compose = makeSystemComposer({
    agent: AGENTS.review,
    resident: true,
    repo,
    workspace: checkout,
    prTarget: { repo, pr: task.number, ref: task.headRef, baseRef: task.baseRef },
    blocks: { memory: undefined, config: undefined, instructions: undefined, skills: undefined },
  });
  const driverNote = `DRIVER NOTE: this is a harness measurement without a bot behind it, so ${ABSENT_RELAYS.map((t) => `\`${t}\``).join(", ")} are not available in this run — read the change with git (\`git diff origin/${task.baseRef}...HEAD\`, \`git diff --stat\`) and skip the status card. \`submit_verdict\` records your verdict for the receipt; nothing is posted anywhere.`;
  return [compose({ sha: task.head, verified: true }), harnessPromptNote(REVIEW_RELAY_TOOLS, "read"), driverNote].join(
    "\n\n",
  );
}

/** The request, as a person would type it into the thread. */
export function reviewPrompt(task: PiReviewTask, repo: string): string {
  return `Review pull request #${task.number} of ${repo}: ${reviewTaskUrl(repo, task)}`;
}

/** One review task judged as the post-step would judge it. */
export interface ReviewOutcome {
  /** The verdict as the parser accepted it; undefined when none was submitted or it was rejected. */
  verdict: ReviewVerdict | undefined;
  /** A verdict the house parser accepts: approve or request_changes, a summary, typed findings. */
  houseShape: boolean;
  /** The verdict names the pinned head — the reviewed-head guard's fallback check, since the driver has no workspace probe of its own until the task ends. */
  headMatches: boolean;
  /** The body the post-step would have posted: the verdict line, the findings, the answer. */
  body: string | undefined;
  problems: string[];
  /** Every write tool the model asked for, by call, with the gate's judgement. */
  writeCalls: string[];
}

export function reviewOutcome(run: PiTaskRun, task: PiReviewTask): ReviewOutcome {
  const problems: string[] = [];
  const raw =
    typeof run.verdict === "object" && run.verdict !== null ? (run.verdict as Record<string, unknown>) : undefined;
  const verdict = raw ? (parseVerdictInput(raw) ?? undefined) : undefined;
  if (!raw) problems.push("no verdict submitted");
  else if (!verdict) problems.push("the verdict is not approve or request_changes");
  let headMatches = false;
  if (verdict) {
    const check = checkReviewedHead({ expected: task.head, reported: verdict.head });
    headMatches = check.ok;
    if (!check.ok) {
      const reported = normalizeHead(verdict.head);
      problems.push(
        reported
          ? `the verdict names head ${reported.slice(0, 7)}, not the reviewed ${task.head.slice(0, 7)}`
          : "the verdict names no head",
      );
    }
  }
  const writeCalls = run.toolCalls
    .filter((c) => PI_WRITE_TOOLS.includes(c.tool))
    .map((c) => `${c.tool} ${c.callId} (${c.gate})`);
  return {
    verdict,
    houseShape: verdict !== undefined,
    headMatches,
    body: run.answer !== undefined || verdict ? buildReviewPostBody(run.answer ?? "", verdict) : undefined,
    problems,
    writeCalls,
  };
}

/** Why a task's sample is not `ok`, as one token for the receipt's refusal
 *  table: the terminal state when the run did not settle, else which half of
 *  the verdict row failed — no house-shaped verdict, or a verdict naming
 *  another head than the reviewed one; undefined when the task passed. */
export function reviewFailureReason(run: PiTaskRun, outcome: ReviewOutcome): string | undefined {
  if (run.terminal !== "settled") return run.terminal;
  if (!outcome.houseShape) return "no-house-verdict";
  if (!outcome.headMatches) return "head-mismatch";
  return undefined;
}

export interface ReviewRow {
  task: PiReviewTask;
  run: PiTaskRun;
  /** The checkout after the task: clean, and still at the pinned head. */
  checkout: { clean: boolean; head: string };
}

/** The receipt's verdict rows for the review suite. */
export function reviewChecks(rows: readonly ReviewRow[]): SloCheck[] {
  const outcomes = rows.map((r) => ({ ...r, outcome: reviewOutcome(r.run, r.task) }));
  const unsettled = outcomes.filter((r) => r.run.terminal !== "settled");
  const offShape = outcomes.filter((r) => !(r.outcome.houseShape && r.outcome.headMatches));
  const bypassed = outcomes.flatMap((r) =>
    r.run.toolCalls.filter((c) => c.gate === "bypassed").map((c) => `${r.task.name}:${c.callId} (${c.tool})`),
  );
  const vetted = outcomes.reduce((n, r) => n + r.run.toolCalls.filter((c) => c.gate === "vetted").length, 0);
  const writes = outcomes.flatMap((r) =>
    r.run.toolCalls
      .filter((c) => PI_WRITE_TOOLS.includes(c.tool))
      .map((c) => ({ task: r.task.name, ran: c.gate !== "rejected-by-pi", text: `${c.tool} ${c.callId} (${c.gate})` })),
  );
  const ranWrites = writes.filter((w) => w.ran);
  const touched = outcomes.flatMap((r) => {
    const facts = [
      ...(r.checkout.clean ? [] : ["dirty tree"]),
      ...(r.checkout.head === r.task.head ? [] : [`moved to ${r.checkout.head.slice(0, 7)}`]),
    ];
    return facts.length > 0 ? [`${r.task.name}: ${facts.join(", ")}`] : [];
  });
  return [
    {
      name: "every task settled",
      pass: unsettled.length === 0,
      actual: outcomes.map((r) => `${r.task.name}: ${r.run.terminal}`).join(", "),
      limit: "settled",
    },
    {
      name: "every task submitted a verdict in the house shape naming the reviewed head",
      pass: offShape.length === 0,
      actual:
        offShape.length === 0
          ? `${outcomes.length}/${outcomes.length} (${outcomes.map((r) => r.outcome.verdict?.verdict).join(", ")})`
          : offShape.map((r) => `${r.task.name}: ${r.outcome.problems.join("; ")}`).join("; "),
      limit: `${outcomes.length}`,
    },
    {
      name: "every tool call pi ran was seen by the extension's tool_call hook — none bypassed the gate",
      pass: bypassed.length === 0,
      actual: bypassed.length === 0 ? `${vetted} vetted` : `bypassed: ${bypassed.join(", ")}`,
      limit: "0 bypassed",
    },
    {
      name: "no write tool ran — pi's edit and write are off the allowlist, and none was asked for",
      pass: ranWrites.length === 0,
      actual:
        writes.length === 0
          ? "none asked for"
          : `${ranWrites.length} ran; asked for: ${writes.map((w) => `${w.task} ${w.text}`).join(", ")}`,
      limit: "0 ran",
    },
    {
      name: "the checkout is untouched after every task — clean tree, still at the reviewed head",
      pass: touched.length === 0,
      actual: touched.length === 0 ? "clean, at the pinned head" : touched.join("; "),
      limit: "untouched",
    },
  ];
}
