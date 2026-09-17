// In-place re-attach after a control plane reset or a refuted replaced word
// (docs/reference/specs/harness-pi.md item 16): the one contract both harness
// loops share when a container command fails under a live run. A resident
// Durable Object reset over an unchanged container (`isControlReset`) or the
// executor's replaced word the row's process refutes (`alive(pid)` answers yes)
// is not a container gone — the loop re-attaches in place, a fresh transport
// from the last record boundary with the old one closed so its queued writes
// never land after it, `relaunches` untouched. The word the process cannot
// refute is the verdict as it always was. A write whose outcome the reset left
// unknown is resolved by the harness's echo, never blindly re-sent. Lifted here
// so the next rule lands in pi and OpenCode at once; the conformance table runs
// both against it.

import { isControlReset, saysContainerReplaced, type HarnessContainer } from "./container.js";
import { PiRpcTransport } from "./pi/transport.js";

/** How many times a live run re-attaches in place with no record read between
 *  them before it gives up: a real reset or blip converges in one (the next
 *  read succeeds), so a repeat with no progress is a stuck control plane — the
 *  word then stands as the verdict and a control reset fails the run by name. */
export const MAX_INPLACE_REATTACHES = 8;

/** How many of the loop's ticks a re-attached prompt waits for pi to echo its
 *  id before it is re-sent: a prompt that landed before the reset is echoed
 *  within a poll or two, so a silence past this is a prompt that did not land
 *  and must be re-sent — measured in ticks, not the wall clock, so a fixed-clock
 *  test drives it and a real run's poll cadence bounds it (harness-pi item 16). */
export const PROMPT_ECHO_WAIT_TICKS = 3;

/** The `resumed` note when the executor said replaced but the row's process
 *  answers alive in the container the run holds — the word did not outrank the
 *  live process (ask 2). The identity is the kernel's boot id, which a
 *  same-kernel replacement keeps, so only the process refutes the word; alive
 *  here, the run re-attaches in place with `relaunches` untouched. Exactly this
 *  wording, so a reader keys on it. */
export const WORD_ALIVE_REATTACH_NOTE =
  "the executor said replaced; the row's pi answers alive in this container; re-attached";

/** The `resumed` note when the resident's Durable Object reset under a live run
 *  (a control reset): the container and the process are unchanged, so the run
 *  re-attaches in place and goes on, `relaunches` untouched. */
export function controlResetResumedNote(): string {
  return "the resident's control plane reset under the run (a deploy); the container and pi are unchanged; re-attached";
}

/** The `harness_error` the run fails by name with when a control reset repeats
 *  with no record read between the re-attaches: a stuck control plane the bound
 *  will not ride to the deadline. */
export function controlResetBoundMessage(reattaches: number): string {
  return `the resident's control plane reset under the run ${reattaches} times with no progress; the run cannot continue safely`;
}

/** What the loop does about the container command that failed under it, decided
 *  once for both harnesses. A control reset re-attaches (the container is
 *  unchanged); the replaced word re-attaches only if the row's process still
 *  answers, else it is the verdict; anything else is the loop's own. The bound
 *  turns a live process that keeps meeting the word into the verdict — the word
 *  stands where a re-attach makes no progress. */
export type ReattachOutcome =
  { kind: "control-reset" } | { kind: "word-alive" } | { kind: "word-gone"; said: Error } | { kind: "not-mine" };

/** Classify a failed container command and, for the replaced word, probe the
 *  row's process in the container the run holds before deciding (ask 2). */
export async function classifyLoopFailure(
  err: unknown,
  ctx: { container: Pick<HarnessContainer, "alive">; pid: number | undefined; reattaches: number },
): Promise<ReattachOutcome> {
  if (err instanceof Error && isControlReset(err)) return { kind: "control-reset" };
  if (err instanceof Error && saysContainerReplaced(err)) {
    const aliveHere =
      ctx.reattaches < MAX_INPLACE_REATTACHES &&
      ctx.pid !== undefined &&
      (await ctx.container.alive(ctx.pid).catch(() => false));
    return aliveHere ? { kind: "word-alive" } : { kind: "word-gone", said: err };
  }
  return { kind: "not-mine" };
}

/** A fresh transport at the last record boundary of `old`, with `old` abandoned
 *  (closed, and every write still queued dropped) so none of its writes land
 *  after the re-attach (harness-pi item 16): the re-attach reads on from where
 *  records were handed out, and a write the reset left unresolved is re-sent
 *  onto the NEW transport, before any newer one. */
export function reattachTransport(
  old: PiRpcTransport,
  deps: Pick<ConstructorParameters<typeof PiRpcTransport>[0], "container" | "paths" | "pid" | "pollMs" | "sleep">,
): PiRpcTransport {
  const offset = old.consumedOffset;
  old.abandon();
  return new PiRpcTransport({ ...deps, offset });
}

/** The commands whose outcome a reset leaves unknown that pi's echo resolves.
 *  `prompt` and `steer` are the model-visible writes; the id-carrying control
 *  commands and the gate reply and the abort are re-sent as they were, pi
 *  ignoring a duplicate response for an id it has already settled and a second
 *  abort being the stop it already was. */
const RESOLVABLE_CONTROL_RESET_WRITES = new Set([
  "prompt",
  "steer",
  "set_auto_retry",
  "get_state",
  "extension_ui_response",
  "abort",
]);

/** How to resolve the write a reset left unknown, by pi's echo — one rule for
 *  the control-reset word and for the replaced word the process refuted:
 *  - `none`: nothing was in flight (a read reset), or a `steer` whose landed
 *    copy pi echoes and whose unlanded copy the loop requeues — never re-sent,
 *    a landed steer must not double.
 *  - `resend`: an id-carrying command, the gate reply, an abort — safe to
 *    re-send as it was (its id dedups, or it is idempotent).
 *  - `await-echo`: a `prompt`, re-sent only if pi does not echo its id within
 *    the bound — a blind re-send would deliver the whole request twice into one
 *    turn (`streamingBehavior: "steer"` on the re-send, which pi takes mid-turn).
 *  - `fail`: no echo to resolve the outcome by, so the run cannot continue. */
export type WriteResolution =
  | { kind: "none" }
  | { kind: "resend"; command: Record<string, unknown> }
  | { kind: "await-echo"; command: Record<string, unknown> }
  | { kind: "fail"; message: string };

export function resolveControlResetWrite(command: Record<string, unknown> | undefined): WriteResolution {
  if (command === undefined || command.type === "steer") return { kind: "none" };
  const type = typeof command.type === "string" ? command.type : "unknown";
  if (type === "prompt") return { kind: "await-echo", command };
  if (RESOLVABLE_CONTROL_RESET_WRITES.has(type)) return { kind: "resend", command };
  return {
    kind: "fail",
    message:
      `a ${type} command was in flight when the resident's control plane reset under the run; its outcome is unknown ` +
      "and it has no echo to resolve it by, so the run cannot continue safely",
  };
}
