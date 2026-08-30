// Head moved during a review run (features/agent-review.md items 10 and 12).
//
// A review is posted pinned to the head it examined (`RepoContext.headSha`);
// if a push landed while the run was in flight, the PR head is now a different
// commit and the org's auto-approve workflow will skip a review pinned to the
// old one as stale (by design — never an approval of unreviewed code). Before
// item 12 that was the whole story: post pinned to the old head, tell the
// thread, ask for a re-request (`headMovedNote`). Live 2026-08-30 (PR #307,
// switchboard-prompting thread p1788070753524099): the move was a rebase onto
// main for a doc conflict — the same commits, the same review — and the
// re-request cost a second full run to reach the same verdict.
//
// Item 12 classifies the move from the two `base...head` commit lists GitHub's
// compare endpoint answers (`classifyHeadMove`), pure:
//   rebase      — same number of commits, same messages in the same order, and
//                 the same set of touched files (a rebase onto main, conflict
//                 resolutions included — a resolution edits files the PR already
//                 touched). The review applies unchanged: it is posted pinned to
//                 the NEW head, with a footer saying so.
//   substantive — anything else (new/dropped/reordered/reworded commits, or a
//                 same-message amend that reaches new files). The same run
//                 re-reviews at the new head — a second model turn with
//                 `rereviewFollowUp` — before posting.
// The file-set check is a cheap guard against the one blind spot of a
// message-only rule (an `--amend` that keeps the message): it catches an amend
// that reaches a new file, not one confined to files the PR already touched.
// GitHub caps the compare file list at 300 entries; a truncated list on either
// side skips the file check rather than fake a mismatch.
//
// Every text here is deterministic given its input — the dispatcher decides
// when to say it; this module only says it.

import { sameCommit } from "./reviewedHead.js";

/** The thread note when the PR head moved during the run; undefined when the
 *  current head is unknown or is the reviewed commit. Prefix-tolerant so a
 *  7-char and a 40-char form of the same commit compare equal — in production
 *  both sides are 40-hex (`RepoContext.headSha` and `currentPrHeadSha` share
 *  one validator), so the tolerance only matters for injected fetchers; its
 *  one theoretical miss (a 7-char collision hiding a move) errs toward silence,
 *  the side this note is biased to. Item 12's fallback: the move could not be
 *  classified (compare failed), or the head moved AGAIN after a re-review. */
export function headMovedNote(input: { where: string; reviewed: string; current?: string }): string | undefined {
  const reviewed = input.reviewed.trim().toLowerCase();
  const current = input.current?.trim().toLowerCase();
  if (!current || !reviewed) return undefined;
  if (sameCommit(reviewed, current)) return undefined;
  const r = short(reviewed);
  const c = short(current);
  return (
    `ℹ️ ${input.where} moved during the run: reviewed ${r}, head is now ${c}. ` +
    `The review was posted pinned to ${r} and will not auto-approve — re-request to review ${c}.`
  );
}

/** One side of a `base...head` comparison: the commits unique to the head
 *  side (oldest first, full messages) and the files the range touches. */
export interface PrCommitList {
  commits: Array<{ sha: string; message: string }>;
  files: string[];
  /** GitHub capped the file list (300); the set is incomplete. */
  filesTruncated: boolean;
}

export type HeadMove =
  | { kind: "rebase"; commits: number }
  | {
      kind: "substantive";
      before: number;
      after: number;
      /** Subjects (first lines) of commits present after and not before. */
      added: string[];
      /** Subjects of commits present before and not after. */
      removed: string[];
    };

export function classifyHeadMove(before: PrCommitList, after: PrCommitList): HeadMove {
  const msgsBefore = before.commits.map((c) => c.message.trim());
  const msgsAfter = after.commits.map((c) => c.message.trim());
  const sameMessages = msgsBefore.length === msgsAfter.length && msgsBefore.every((m, i) => m === msgsAfter[i]);
  const filesComparable = !before.filesTruncated && !after.filesTruncated;
  const sameFiles = !filesComparable || setEqual(new Set(before.files), new Set(after.files));
  if (sameMessages && sameFiles) return { kind: "rebase", commits: msgsAfter.length };
  const beforeSet = new Set(msgsBefore);
  const afterSet = new Set(msgsAfter);
  return {
    kind: "substantive",
    before: msgsBefore.length,
    after: msgsAfter.length,
    added: msgsAfter.filter((m) => !beforeSet.has(m)).map(subject),
    removed: msgsBefore.filter((m) => !afterSet.has(m)).map(subject),
  };
}

/** Thread note for a carried-forward review (rebase-only move). */
export function headCarriedNote(input: { where: string; reviewed: string; current: string; commits: number }): string {
  const r = short(input.reviewed);
  const c = short(input.current);
  return (
    `ℹ️ ${input.where} moved during the run: reviewed ${r}, head is now ${c} — a rebase of the same ${plural(input.commits, "commit")} ` +
    `(same messages, same files). The review applies unchanged and was posted pinned to ${c}.`
  );
}

/** Appended to the posted GitHub body of a carried-forward review, so the
 *  reader of the PR sees why a review "of" the new head names the old one. */
export function carriedFooter(input: { reviewed: string; current: string; commits: number }): string {
  const r = short(input.reviewed);
  const c = short(input.current);
  return `_Reviewed at ${r}; the head moved to ${c} during the review — a rebase of the same ${plural(input.commits, "commit")} — so this review is posted against ${c}._`;
}

const LISTED_SUBJECTS_MAX = 4;

/** Thread note when the same run re-reviews at the new head. */
export function headRereviewNote(input: {
  where: string;
  reviewed: string;
  current: string;
  move: Extract<HeadMove, { kind: "substantive" }>;
}): string {
  const r = short(input.reviewed);
  const c = short(input.current);
  return `🔀 ${input.where} moved during the run: reviewed ${r}, head is now ${c} — ${describeMove(input.move)}. Re-reviewing at ${c} before posting.`;
}

function describeMove(move: Extract<HeadMove, { kind: "substantive" }>): string {
  const parts = [...move.added.map((s) => `+ “${s}”`), ...move.removed.map((s) => `− “${s}”`)];
  const shown = parts.slice(0, LISTED_SUBJECTS_MAX);
  if (parts.length > LISTED_SUBJECTS_MAX) shown.push(`+${parts.length - LISTED_SUBJECTS_MAX} more`);
  const detail = shown.length > 0 ? shown.join(", ") : "same messages, different files";
  return `${move.before} → ${move.after} commits (${detail})`;
}

/** The second model turn's instruction: what moved, what is on the PR now
 *  versus what was reviewed, where the worktree stands, and the verdict
 *  contract (a fresh `submit_verdict` carrying the new head). Commit SUBJECTS
 *  only — the model reads the commits itself. */
export function rereviewFollowUp(input: {
  where: string;
  reviewed: string;
  current: string;
  move: Extract<HeadMove, { kind: "substantive" }>;
  before: PrCommitList;
  after: PrCommitList;
  /** true when Switchboard moved the workspace to `current` (resident
   *  re-attach); false when the model must fetch and check it out itself. */
  worktreeMoved: boolean;
}): string {
  const r = short(input.reviewed);
  const c = short(input.current);
  const list = (l: PrCommitList) => l.commits.map((x) => `- ${short(x.sha)} ${subject(x.message)}`).join("\n");
  const where = input.worktreeMoved
    ? `Switchboard has already moved your worktree to ${c}. Confirm with \`git rev-parse HEAD\` (from the current directory, no \`cd\`) — it must equal \`${input.current}\`; do NOT run \`git fetch\` and never check out anything else.`
    : `Bring your checkout to the new head: \`git fetch origin ${input.current} && git checkout ${input.current}\`, then confirm with \`git rev-parse HEAD\` — it must equal \`${input.current}\`. Never check out another branch or PR.`;
  return [
    `The head of ${input.where} moved from ${r} to ${c} while you were reviewing — ${describeMove(input.move)}. Your review above was of ${r} and has NOT been posted.`,
    "",
    `Commits you reviewed (${r}):`,
    list(input.before) || "- (none)",
    "",
    `Commits on the PR now (${c}):`,
    list(input.after) || "- (none)",
    "",
    where,
    "",
    `Re-review at ${c}: focus on what changed since ${r} (\`git diff ${r} HEAD\` if ${r} is still present, otherwise diff against the base), re-check any finding above that the new commits address, and report the complete updated review — same format, verdict line first. Then call \`submit_verdict\` again with \`head\` = \`${input.current}\`; the earlier verdict is void.`,
  ].join("\n");
}

function subject(message: string): string {
  return message.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function short(sha: string): string {
  return sha.trim().toLowerCase().slice(0, 7);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function setEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
