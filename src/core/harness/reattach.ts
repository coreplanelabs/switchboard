// In-place re-attach after a control plane reset or a refuted replaced word
// (docs/reference/specs/harness-pi.md item 16): the one contract both harness
// loops share when a container command fails under a live run. A resident
// Durable Object reset over an unchanged container (`isControlReset`) or the
// executor's replaced word the row's process refutes (`alive(pid)` answers yes)
// is not a container gone — the loop re-attaches in place, a fresh transport
// from the last record boundary with the old one abandoned so its queued
// writes never land after it, `relaunches` untouched. The word the process
// cannot refute is the verdict as it always was. A write whose outcome the
// reset left unknown is resolved by the harness's echo, never blindly re-sent.
// Past the bound on re-attaches with no record read between them the run fails
// by name, whichever word it met: a live pid is never relaunched beside.
// Lifted here so the next rule lands in pi and OpenCode at once; the
// conformance table runs both against it.

import { isControlReset, saysContainerReplaced, type HarnessContainer } from "./container.js";
import { PiRpcTransport, type PiRpcTransportDeps } from "./pi/transport.js";

/** How many times a live run re-attaches in place with no record read between
 *  them before it gives up: a real reset or blip converges in one (the next
 *  read succeeds), so a repeat with no progress is a stuck control plane or a
 *  word nothing refutes by a record — the run fails by name either way
 *  (`reattachBoundMessage`), never a relaunch beside a pid that answers alive. */
export const MAX_INPLACE_REATTACHES = 8;

/** How many of the loop's ticks a re-attached prompt waits for pi to echo its
 *  id before it is re-sent: a prompt that landed before the reset is echoed
 *  within a poll or two, so a silence past this is a prompt that did not land
 *  and must be re-sent — measured in the loop's ticks, never its events (a
 *  catch-up burst of records is not time), so a fixed-clock test drives it and
 *  a real run's poll cadence bounds it (harness-pi item 16). */
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
export const CONTROL_RESET_RESUMED_NOTE =
  "the resident's control plane reset under the run (a deploy); the container and pi are unchanged; re-attached";

/** The two failures a loop re-attaches in place on. */
export type ReattachKind = "control-reset" | "word-alive";

/** The `harness_error` the run fails by name with at `MAX_INPLACE_REATTACHES`
 *  re-attaches that read no record between them. A control reset that keeps
 *  coming is a stuck control plane; the replaced word that keeps coming while
 *  the pid still answers was never refuted by a record — and is never turned
 *  into the verdict at the bound, since that would relaunch beside a live pi
 *  (the orphan the guard exists to prevent). */
export function reattachBoundMessage(kind: ReattachKind, reattaches: number, process: string): string {
  return kind === "control-reset"
    ? `the resident's control plane reset under the run ${reattaches} times with no progress; the run cannot continue safely`
    : `the executor said replaced ${reattaches} times with no progress while the row's ${process} answered alive in this container; ` +
        `the word was never refuted by a record, and the run cannot continue safely — never a relaunch beside a live ${process}`;
}

/** What the loop does about the container command that failed under it, decided
 *  once for both harnesses. A control reset re-attaches (the container is
 *  unchanged); the replaced word re-attaches only if the row's process still
 *  answers, else it is the verdict; anything else is the loop's own. The bound
 *  is the loop's to apply (`reattachBoundMessage`): the process's answer alone
 *  decides between `word-alive` and `word-gone`, never the count. */
export type ReattachOutcome =
  { kind: "control-reset" } | { kind: "word-alive" } | { kind: "word-gone"; said: Error } | { kind: "not-mine" };

/** Classify a failed container command and, for the replaced word, probe the
 *  row's process in the container the run holds before deciding (ask 2). */
export async function classifyLoopFailure(
  err: unknown,
  ctx: { container: Pick<HarnessContainer, "alive">; pid: number | undefined },
): Promise<ReattachOutcome> {
  if (err instanceof Error && isControlReset(err)) return { kind: "control-reset" };
  if (err instanceof Error && saysContainerReplaced(err)) {
    const aliveHere = ctx.pid !== undefined && (await ctx.container.alive(ctx.pid).catch(() => false));
    return aliveHere ? { kind: "word-alive" } : { kind: "word-gone", said: err };
  }
  return { kind: "not-mine" };
}

/** A fresh transport at the last record boundary of `old`, with `old` abandoned
 *  (closed, every write whose turn had not come held back) so none of its
 *  writes land out of turn (harness-pi item 16): the re-attach reads on from
 *  where records were handed out, the write the failure left unresolved is
 *  resolved first (`resolveControlResetWrite`), and `unsent` — the writes that
 *  never reached pi, in the loop's order — is for the caller to send on the
 *  fresh transport behind it, through the gate (`HeldSends`), so pi sees the
 *  order the loop sent. The caller awaits `old.flushed()` BEFORE resolving: a
 *  write in flight when the read failed can fail with the same reset a moment
 *  later, and is neither `pendingSend` nor queued until it settles. */
export function reattachTransport(
  old: PiRpcTransport,
  deps: Pick<PiRpcTransportDeps, "container" | "paths" | "pid" | "pollMs" | "sleep">,
): { transport: PiRpcTransport; unsent: Record<string, unknown>[] } {
  const offset = old.consumedOffset;
  const unsent = old.takeUnsent();
  old.abandon();
  return { transport: new PiRpcTransport({ ...deps, offset }), unsent };
}

/** The commands re-sent AS THEY WERE after a reset left them unknown: pi
 *  ignores a duplicate response for an id it has already settled, and a second
 *  abort is the stop it already was. A `prompt` is not here (it awaits its
 *  echo) and neither is a `steer` (its echo and the loop's requeue resolve it). */
const RESEND_AS_IS = new Set(["set_auto_retry", "get_state", "extension_ui_response", "abort"]);

/** How to resolve the write a reset left unknown, by pi's echo — one rule for
 *  the control-reset word and for the replaced word the process refuted:
 *  - `none`: nothing was in flight (a read reset); a `steer`, whose landed copy
 *    pi echoes and whose unlanded copy the loop requeues — never re-sent, a
 *    landed steer must not double; or a command whose id pi has ALREADY echoed
 *    (`echoed`), which landed before the failure was seen — the echo may sit in
 *    the very chunk read before the transport surfaced its send error.
 *  - `resend`: an id-carrying control command, the gate reply, an abort — safe
 *    to re-send as it was (its id dedups, or it is idempotent).
 *  - `await-echo`: a `prompt` with an id, re-sent only if pi does not echo that
 *    id within the bound — a blind re-send would deliver the whole request
 *    twice into one turn (`streamingBehavior: "steer"` on the re-send, which pi
 *    takes mid-turn).
 *  - `fail`: no echo to resolve the outcome by — an unknown write, or a prompt
 *    with no id, whose echo could not be told from any other — so the run
 *    cannot continue safely. */
export type WriteResolution =
  | { kind: "none" }
  | { kind: "resend"; command: Record<string, unknown> }
  | { kind: "await-echo"; command: Record<string, unknown> }
  | { kind: "fail"; message: string };

export function resolveControlResetWrite(
  command: Record<string, unknown> | undefined,
  echoed: (id: string) => boolean = () => false,
): WriteResolution {
  if (command === undefined || command.type === "steer") return { kind: "none" };
  const type = typeof command.type === "string" ? command.type : "unknown";
  const id = typeof command.id === "string" ? command.id : undefined;
  if (id !== undefined && echoed(id)) return { kind: "none" };
  if (type === "prompt") {
    if (id === undefined)
      return {
        kind: "fail",
        message:
          "a prompt with no id was in flight when the resident's control plane reset under the run; its outcome is unknown " +
          "and its echo could not be told from any other, so the run cannot continue safely",
      };
    return { kind: "await-echo", command };
  }
  if (RESEND_AS_IS.has(type)) return { kind: "resend", command };
  return {
    kind: "fail",
    message:
      `a ${type} command was in flight when the resident's control plane reset under the run; its outcome is unknown ` +
      "and it has no echo to resolve it by, so the run cannot continue safely",
  };
}

/** One write to pi, as the gate holds it: to send when its turn comes, a prompt
 *  in doubt awaiting its echo, or one whose echo came (landed — nothing to send). */
interface HeldSend {
  command: Record<string, unknown>;
  state: "send" | "await" | "landed";
}

/** The one gate every write to pi takes after a re-attach (harness-pi item 16).
 *  While a prompt a failure left in doubt awaits its echo, every later write —
 *  a follow-up's steer, the wrap-up, an abort, a gate reply, a turn's prompt —
 *  is held behind it in the order it was sent, and a second prompt in doubt is
 *  appended behind the first, never overwriting it. The gate moves on by the
 *  echo (the prompt landed: nothing to send, the writes behind it go out) or by
 *  the bound of the loop's ticks (the prompt is re-sent steer-delivered once,
 *  then the writes behind it go out) — so pi sees the order the loop sent, and
 *  no request is delivered twice or lost. `deliver` writes to the transport as
 *  it is at that moment, so a re-attach's fresh transport is what a held write
 *  reaches. */
export class HeldSends {
  private readonly queue: HeldSend[] = [];
  private ticks = 0;

  constructor(private readonly deliver: (command: Record<string, unknown>) => void) {}

  /** Whether a prompt in doubt is holding the gate. */
  get holding(): boolean {
    return this.queue.length > 0;
  }

  /** Send now — or, while a prompt in doubt holds the gate, hold behind it in order. */
  send(command: Record<string, unknown>): void {
    if (!this.holding) this.deliver(command);
    else this.queue.push({ command, state: "send" });
  }

  /** A prompt whose landing a failure left in doubt: awaited until its echo or
   *  the bound. Appended behind an earlier one, never overwriting it; its own
   *  wait starts once it is the head. */
  await(command: Record<string, unknown>): void {
    this.queue.push({ command, state: "await" });
    if (this.queue.length === 1) this.ticks = 0;
  }

  /** pi echoed `id`: a prompt in doubt under that id landed — never re-sent,
   *  and if it held the gate, the writes behind it go out now. */
  echoed(id: string): void {
    let landed = false;
    for (const held of this.queue) {
      if (held.state !== "await" || held.command.id !== id) continue;
      held.state = "landed";
      landed = true;
    }
    if (landed) this.release();
  }

  /** One of the loop's ticks — never one of its events, a catch-up burst of
   *  records being no time: past `PROMPT_ECHO_WAIT_TICKS` the awaited prompt
   *  is re-sent steer-delivered once (pi takes it mid-turn) and the gate moves on. */
  tick(): void {
    const head = this.queue[0];
    if (head === undefined || head.state !== "await" || this.ticks++ < PROMPT_ECHO_WAIT_TICKS) return;
    this.queue.shift();
    this.ticks = 0;
    this.deliver({ ...head.command, streamingBehavior: "steer" });
    this.release();
  }

  /** Deliver from the head until the next prompt still awaiting its echo, whose wait starts now. */
  private release(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (head.state === "await") return;
      this.queue.shift();
      this.ticks = 0;
      if (head.state === "send") this.deliver(head.command);
    }
  }
}
