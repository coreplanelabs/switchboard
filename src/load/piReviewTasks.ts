// The review tasks of `load:pi --suite review` (docs/reference/specs/
// load-harness.md, the review suite item): merged pull requests of the
// repository the driver's checkout clones — four shapes a review is routinely
// handed: a one-line docs change that should be a plain approval, a small fix
// across a few files, a fix with a table of cases behind it, a change across
// sixteen files with a judgement in it — each pinned to the head the review
// must read, so the suite is repeatable months later and its verdict is
// posted nowhere: the driver records it in the receipt in place of the
// post-step. The repository is never written here: the checkout's `origin`
// names it, and a checkout whose origin does not hold a pinned head refuses to
// start.

export interface PiReviewTask {
  name: string;
  number: number;
  /** The pull request's head at merge — the commit the review must read; the
   *  driver checks the checkout out at it and refuses to start on another. */
  head: string;
  /** The head branch, as the REVIEW TARGET block names it. */
  headRef: string;
  /** The base branch: `origin/<baseRef>...HEAD` is the change. */
  baseRef: string;
  title: string;
}

const task = (t: Omit<PiReviewTask, "baseRef">): PiReviewTask => ({ ...t, baseRef: "main" });

export const PI_REVIEW_TASKS: readonly PiReviewTask[] = [
  task({
    name: "docs-line",
    number: 1069,
    head: "72ed3a505357dfacb08d7095b6388a8ef17071a3",
    headRef: "docs/u29-pi-relay-seed-clause",
    title: "docs(docs): state the pi relay seed dependency in the plan",
  }),
  task({
    name: "seed-rule",
    number: 1048,
    head: "1f69c3f591a9908d1ac166f458e09ae47ce60777",
    headRef: "fix/pi-harness-seed-prompt",
    title: "fix(harness): a fresh pi run is prompted with the request, not the thread's oldest turn",
  }),
  task({
    name: "adaptive-thinking",
    number: 1068,
    head: "a8cca615ca864ffc0bd1343e28f749f1b466aeba",
    headRef: "fix/pi-adaptive-thinking",
    title: "fix(harness): pi asks a Claude 5 model for adaptive thinking through the proxy",
  }),
  task({
    name: "gate-coverage",
    number: 1067,
    head: "150c8fee1ef4c34ab473aa58d27fc405ab6b85c4",
    headRef: "fix/pi-hook-coverage",
    title: "fix(harness): pi answers a tool call whose arguments fail its validation before the tool_call hook fires",
  }),
];

export const PI_REVIEW_TASK_NAMES: readonly string[] = PI_REVIEW_TASKS.map((t) => t.name);

export const piReviewTaskByName = (name: string): PiReviewTask | undefined =>
  PI_REVIEW_TASKS.find((t) => t.name === name);

/** The pull request's URL in the repository the checkout's origin names. */
export const reviewTaskUrl = (repo: string, task: Pick<PiReviewTask, "number">): string =>
  `https://github.com/${repo}/pull/${task.number}`;
