import { redactSecrets, stripAnsi } from "../core/redact.js";

// How a failed resident step describes itself (features/resident-repos.md
// item 53). Pure, so the shape is a unit test and not a live post-mortem.
//
// The rule this module exists to enforce: a failure report may never CHOOSE
// between the two streams. It used to — `tail(r.stderr || r.stdout)` — and
// that cost a whole diagnosis once: a resident went `down (provision-failed at
// install: exit 1: [WARN] The "pnpm" field in package.json is no longer read
// by pnpm …)`. That warning cannot fail an install: the same command prints
// those exact bytes on stderr and exits 0 (reproducible on the same tree
// inside the resident's own base image). The pnpm family reports through its
// own logger on STDOUT, so `stderr || stdout` let a harmless warning shadow
// the error that named the exit — and nothing else recorded the command's
// output, so the real cause was gone for good.
//
// Every stream a step can write is therefore reported, labelled, tail-first
// (a tool's error is its last output), each bounded on its own so one noisy
// stream cannot crowd out the other.

/** What the sandbox exec hands back for one command. */
export interface StepResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** Chars kept per stream in the STORED reason — it travels into DO storage,
 *  `GET /residents`, `repo list` and a Slack reply, so it stays short. The
 *  full output goes to the Worker log instead (`stepFailureLog`). */
export const STEP_REPORT_PER_STREAM = 400;

/** Chars kept per stream in the LOG line: enough for a pnpm/vitest error
 *  block with its context, still bounded so one runaway step cannot flood
 *  the Worker's logs. */
export const STEP_LOG_PER_STREAM = 4000;

/** The last `budget` chars of `s`, marked with a leading `…` when cut. Empty
 *  (after trimming) yields "" so the caller can drop the label entirely. */
function tailOf(s: string, budget: number): string {
  // Item 62: the tail lands in a stored reason and on a card — strip and
  // redact BEFORE cutting, so a cut can never split a credential.
  const trimmed = redactSecrets(stripAnsi(s)).trim();
  if (trimmed.length <= budget) return trimmed;
  return `…${trimmed.slice(-budget)}`;
}

function exitPhrase(r: StepResult): string {
  return `exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}`;
}

/** The StepResult for a wait the SDK gave up on while the process was still
 *  alive (`ProcessWaitTimeoutError`: "Process output did not complete within
 *  <ms>ms") — after the caller killed it. It is the step's OWN timeout, shaped
 *  exactly like one the supervisor enforced (`timedOut: true` → "(timed out)"
 *  in the report), so `classifyRefreshFailure` files it as `<step>-failed`,
 *  never as an interruption. `exitCode` is the status observed after the
 *  kill, or -1 when the process still had not reported one: the report says
 *  which, and never invents a status. */
export function abandonedWaitStepResult(input: { detail: string; exitCode: number | null }): StepResult {
  const exit = input.exitCode === null ? "killed, no exit status observed" : `killed, exit ${input.exitCode}`;
  return {
    stdout: "",
    stderr: `${input.detail} — process was still running: ${exit}`,
    exitCode: input.exitCode ?? -1,
    timedOut: true,
  };
}

/** The stored `provision-failed at <step>: <this>` / refresh-error detail.
 *
 *  Throws when handed a success: the only correct caller is a failure branch,
 *  and a "failure" description of exit 0 would be a lie in the record. */
export function describeStepFailure(r: StepResult, perStream = STEP_REPORT_PER_STREAM): string {
  if (r.exitCode === 0 && !r.timedOut) {
    throw new Error(`describeStepFailure: not a failure (exit ${r.exitCode})`);
  }
  const parts: string[] = [];
  const out = tailOf(r.stdout, perStream);
  const err = tailOf(r.stderr, perStream);
  if (out) parts.push(`stdout: ${out}`);
  if (err) parts.push(`stderr: ${err}`);
  return `${exitPhrase(r)}: ${parts.length > 0 ? parts.join("; ") : "no output"}`;
}

/** The operator's escape hatch: what `console.log` writes when a step fails,
 *  so the Worker log (observability is on for this Worker) holds the error
 *  block itself even when the stored reason only had room for its tail. */
export function stepFailureLog(step: string, r: StepResult, perStream = STEP_LOG_PER_STREAM): string {
  const out = tailOf(r.stdout, perStream);
  const err = tailOf(r.stderr, perStream);
  return [
    `step ${step} failed: ${exitPhrase(r)}`,
    `--- stdout ---\n${out || "(empty)"}`,
    `--- stderr ---\n${err || "(empty)"}`,
  ].join("\n");
}
