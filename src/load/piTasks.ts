// The five representative coding tasks of `load:pi` (docs/reference/specs/
// load-harness.md, the pi driver items): five shapes a coding child is
// routinely handed — a test gap, a small feature, a refactor, a spec row, a
// CLI flag — each calibrated to this repository's small modules so the run
// is short and its proof is one command. The same five prompts go to today's
// coding agent for the comparison, so each prompt is complete on its own: the
// branch contract, the change, the proof, and the terminal tool.

export type PiTaskShape = "test-gap" | "small-feature" | "refactor" | "spec-row" | "cli-flag";

export interface PiTask {
  name: string;
  shape: PiTaskShape;
  title: string;
  /** The change, as the model reads it. */
  body: string;
  /** The one command that proves it. */
  proof: string;
}

export const PI_TASKS: readonly PiTask[] = [
  {
    name: "test-gap",
    shape: "test-gap",
    title: "Cover two error shapes `reasonOf` does not yet test",
    body: `\`src/load/reasons.ts\` recovers a refusal's machine token from a thrown error. Read \`src/load/reasons.test.ts\`, find two error shapes the tests do not cover (for example a non-Error value, or a message naming a known token and a timeout at once), and add one test each that pins the current behavior. Do not change \`reasons.ts\`.`,
    proof: "npx vitest run src/load/reasons.test.ts",
  },
  {
    name: "small-feature",
    shape: "small-feature",
    title: "Recognize rate limiting as a named refusal",
    body: `Add \`rate-limited\` to \`KNOWN_REASONS\` in \`src/load/reasons.ts\` and make \`reasonOf\` return it for an error whose message carries an HTTP 429 or the words \`rate limit\` (case-insensitive), decided before the timeout rule. Add tests for both spellings and one proving \`timeout\` still wins for a plain timeout message.`,
    proof: "npx vitest run src/load/reasons.test.ts",
  },
  {
    name: "refactor",
    shape: "refactor",
    title: "Extract the operations table from `renderMarkdown`",
    body: `In \`src/load/aggregate.ts\`, \`renderMarkdown\` builds the per-operation table inline. Extract that table into a named function beside \`renderMarkdown\` and call it, without changing one byte of the rendered output. The existing tests in \`src/load/aggregate.test.ts\` must pass unchanged; add one test that renders a two-operation report and compares the table against its exact expected lines.`,
    proof: "npx vitest run src/load/aggregate.test.ts",
  },
  {
    name: "spec-row",
    shape: "spec-row",
    title: "Bind the refusal-token recovery to the load-harness spec",
    body: `\`docs/reference/specs/load-harness.md\` describes the harness but never states how a refusal's token is recovered from a client error. Add one Behavior item describing \`reasonOf\` (the token list, the message fallbacks, \`timeout\`, \`unknown\`) and one Validation criteria row bound to a real test in \`src/load/reasons.test.ts\` in the spec's \`file::describe::it\` proof form. Read the spec's existing items first and match their voice. Write no dates and no issue numbers.`,
    proof: "npm run specs:check",
  },
  {
    name: "cli-flag",
    shape: "cli-flag",
    title: "A `--limit` for `load history`",
    body: `\`scripts/load.ts\`'s \`history\` command pages the whole run store. Add a \`--limit N\` flag that stops paging once N runs have been read (default: unlimited), thread it through \`pageAll\` in \`src/load/history.ts\` as an optional maximum, and add a unit test in \`src/load/history.test.ts\` proving paging stops at the limit and that the default still reads everything.`,
    proof: "npx vitest run src/load/history.test.ts && npm run typecheck",
  },
];

export const PI_TASK_NAMES: readonly string[] = PI_TASKS.map((t) => t.name);

export const piTaskByName = (name: string): PiTask | undefined => PI_TASKS.find((t) => t.name === name);

/** The branch a task runs on: the driver creates it before pi starts, as the
 *  ship pipeline owns its children's branch. */
export const taskBranch = (name: string, runId: string): string => `load-pi/${name}-${runId}`;

/** The prompt both arms of the comparison receive. `branch.created` says
 *  whether a driver already put the checkout on the branch (the pi arm) or
 *  the agent must create it itself (today's coding agent, which gets the same
 *  words through `ask` and no driver). */
export function taskPrompt(task: PiTask, branch: { name: string; created: boolean }): string {
  const branchLine = branch.created
    ? `The branch \`${branch.name}\` is already checked out for you; make every change on it.`
    : `Create the branch \`${branch.name}\` from the current head and make every change on it.`;
  return [
    `You are a coding agent working in the repository checked out in the current directory. ${branchLine} Read AGENTS.md first and follow it.`,
    "",
    `Task: ${task.title}`,
    "",
    task.body.trim(),
    "",
    `Prove it: run \`${task.proof}\` and make it pass.`,
    "",
    `When the change is complete: commit it on \`${branch.name}\` with a conventional-commit message (type(scope): what a reader can now do), do not push, and call the \`submit_pr_description\` tool exactly once with the typed object — title, tldr, whatWhy, a tour with one step per hunk anchored by repo-relative path and 1-based line range in your commit, remaining, decisions, risks, and validation with the criteria you actually proved. Never merge, never approve, never open a pull request yourself: the tool call is the deliverable. Stop after the tool call.`,
  ].join("\n");
}
