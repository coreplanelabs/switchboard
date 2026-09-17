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
import { PiRpcTransport, type Landing, type PiRpcTransportDeps } from "./pi/transport.js";

/** How many times a live run re-attaches in place with no record read between
 *  them before it gives up: a real reset or blip converges in one (the next
 *  read succeeds), so a repeat with no progress is a stuck control plane or a
 *  word nothing refutes by a record — the run fails by name either way
 *  (`reattachBoundMessage`), never a relaunch beside a pid that answers alive. */
export const MAX_INPLACE_REATTACHES = 8;

/** How long, on the harness's clock, a re-attached prompt waits for pi to echo
 *  its id before it is re-sent: a prompt that landed before the reset is echoed
 *  within a poll or two, so a silence past this is a prompt that did not land
 *  and must be re-sent. Wall-clock, never a count of the loop's ticks or
 *  events: a streaming pi that answers every poll starves the tick (the race
 *  re-creates it each iteration), and a catch-up burst of records is no time
 *  — so the gate reads the clock on every iteration and a fixed-clock test
 *  never reaches the bound (harness-pi item 16). */
export const PROMPT_ECHO_WAIT_MS = 3_000;

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
export function reattachBoundMessage(kind: ReattachKind, reattaches: number, processName: "pi" | "OpenCode"): string {
  return kind === "control-reset"
    ? `the resident's control plane reset under the run ${reattaches} times with no progress; the run cannot continue safely`
    : `the executor said replaced ${reattaches} times with no progress while the row's ${processName} answered alive in this container; ` +
        `the word was never refuted by a record, and the run cannot continue safely — never a relaunch beside a live ${processName}`;
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
 *  ignores a duplicate response for an id it has already settled. A `prompt`
 *  is not here (it awaits its echo), neither is a `steer` (its echo and the
 *  loop's requeue resolve it), and neither is an `abort` — never in doubt: the
 *  transport writes it as its own step past any spent chain, and a failed one
 *  its sender asks again on the loop's next tick (the pi harness's `abortPi`),
 *  so the re-attach neither resolves nor re-sends a stop. */
const RESEND_AS_IS = new Set(["set_auto_retry", "get_state", "extension_ui_response"]);

/** How to resolve the write a reset left unknown, by pi's echo — one rule for
 *  the control-reset word and for the replaced word the process refuted:
 *  - `none`: nothing was in flight (a read reset); a `steer`, whose landed copy
 *    pi echoes and whose unlanded copy the loop requeues — never re-sent, a
 *    landed steer must not double; or a command whose id pi has ALREADY echoed
 *    (`echoed`), which landed before the failure was seen — the echo may sit in
 *    the very chunk read before the transport surfaced its send error.
 *  - `resend`: an id-carrying control command or the gate reply — safe to
 *    re-send as it was (its id dedups). An abort is never in doubt: the
 *    transport writes it as its own step past any spent chain, and a failed
 *    one its sender asks again on the next tick, so it needs nothing here.
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
  if (command === undefined || command.type === "steer" || command.type === "abort") return { kind: "none" };
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
 *  in doubt awaiting its echo, or one whose echo came (landed — nothing to send).
 *  `onDelivered` runs when the write actually leaves the gate — what a clock
 *  stamped at delivery (the finale's) is told by. */
interface HeldSend {
  command: Record<string, unknown>;
  state: "send" | "await" | "landed";
}

/** A landing the write's sender hears about: the write is over, one way or the
 *  other — `landed`, `failed`, or `dropped` (nothing kept it and no re-send
 *  will come, so a clock or a label waiting on it must give up now). Only a
 *  `held` write is not over: it comes back through `send` as the same object
 *  (`PiRpcTransport.Landing`). */
export type Settled = Exclude<Landing, "held">;

/** The commands the gate never holds, by type — the two exits (harness-pi item
 *  16), enforced here so no caller can get them wrong. A gate reply answers an
 *  ask pi already made, so no order is owed it and holding it would only block
 *  pi's tool. An abort — a stop's, the finale's, a gate bypass's — is written
 *  by the transport as its own step behind whatever is in flight; held here it
 *  would wait out a bound the stop itself ends (the loop breaks on the flag),
 *  and the drop at the loop's end would discard it: pi never aborted. */
const PASSES_HOLD = new Set(["extension_ui_response", "abort"]);

/** The one gate every write to pi takes after a re-attach (harness-pi item 16).
 *  While a prompt a failure left in doubt awaits its echo, every later write of
 *  turn content — a follow-up's steer, the wrap-up, a turn's prompt — is held
 *  behind it in the order it was sent, and a second prompt in doubt is appended
 *  behind the first, never overwriting it. The gate moves on by the echo (the
 *  prompt landed: nothing to send, the writes behind it go out) or by the bound
 *  on the harness's clock (`PROMPT_ECHO_WAIT_MS`: the prompt is re-sent
 *  steer-delivered once, then the writes behind it go out) — so pi sees the
 *  order the loop sent, and no request is delivered twice or lost. The clock
 *  is read (`quiet`) on every iteration of the loop on which the feed is quiet
 *  — the transport has handed out every record it read — never counted in
 *  ticks a streaming pi starves, and never while a catch-up burst is still
 *  being handed out: the records pi wrote during the reset, read in one chunk
 *  and consumed one ledger write at a time, are no time, and the echo late in
 *  that burst lands the prompt before any judgement. The two answers to what pi
 *  already did never wait, each enforced by type where the write is made rather
 *  than at its call sites: `send` here holds neither an abort nor a gate reply
 *  (`PASSES_HOLD`), and the transport writes an abort as its own step behind
 *  whatever is in flight (the abort step of `PiRpcTransport.write`, never
 *  queued, never stopped by a spent chain). `deliver` writes to the transport as
 *  it is at that moment, so a re-attach's fresh transport is what a held write
 *  reaches, and answers with the write's landing. */
export class HeldSends {
  private readonly queue: HeldSend[] = [];
  /** The awaited head's clock: when the feed first went quiet with it at the
   *  front. Undefined until then, and again whenever the head changes. */
  private headSince: number | undefined;
  /** What runs once a write has actually settled at the transport, by the
   *  command object — kept across a `held` landing, so the re-send of the same
   *  object after a re-attach still runs it — told whether the write landed or
   *  failed (the finale's clock, harness-pi item 15, starts when pi has the
   *  wrap-up, not when the loop asked, and not at all on a write that failed). */
  private readonly onLanded = new Map<Record<string, unknown>, (landing: Settled) => void>();

  constructor(private readonly deliver: (command: Record<string, unknown>) => Promise<Landing>) {}

  /** Whether a prompt in doubt is holding the gate. */
  get holding(): boolean {
    return this.queue.length > 0;
  }

  /** Send now — or, while a prompt in doubt holds the gate, hold behind it in
   *  order. A gate reply and an abort never hold (`PASSES_HOLD`): the rule
   *  lives here, by the command's type, so no caller can get it wrong.
   *  `onLanded` runs when the write has settled at the transport — told
   *  `landed`, `failed` with the reset, or `dropped` — never at the hand-off to
   *  a chain that only holds it, and never once the loop or turn that sent it
   *  has ended (`dropHeld` forgets it). */
  send(command: Record<string, unknown>, onLanded?: (landing: Settled) => void): void {
    if (onLanded) this.onLanded.set(command, onLanded);
    if (this.holding && !PASSES_HOLD.has(String(command.type))) {
      this.queue.push({ command, state: "send" });
      return;
    }
    this.dispatch(command);
  }

  /** A prompt whose landing a failure left in doubt: awaited until its echo or
   *  the bound. Appended behind an earlier one, never overwriting it; its clock
   *  starts at the first quiet moment once it is the head. */
  await(command: Record<string, unknown>): void {
    this.queue.push({ command, state: "await" });
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

  /** The feed is quiet at `now`: the transport has handed out every record it
   *  read. The awaited head's clock starts on the first such read after it
   *  became the head; once the head has waited `PROMPT_ECHO_WAIT_MS` of quiet
   *  clock it is re-sent steer-delivered once (pi takes it mid-turn) and the
   *  gate moves on, the next awaited head's clock starting here. Never called
   *  while records are still arriving, so a catch-up burst is no time. */
  quiet(now: number): void {
    const head = this.queue[0];
    if (head === undefined || head.state !== "await") return;
    if (this.headSince === undefined) {
      this.headSince = now;
      return;
    }
    if (now - this.headSince < PROMPT_ECHO_WAIT_MS) return;
    this.queue.shift();
    this.headSince = undefined;
    // The re-send is a steer-delivered copy. No callback follows it: a prompt
    // is never sent with one (only the wrap-up steer carries `onLanded`), and
    // an awaited head is a write the transport already answered `failed`,
    // whose callback `dispatch` ran and forgot.
    this.dispatch({ ...head.command, streamingBehavior: "steer" });
    this.release();
    if (this.queue[0]?.state === "await") this.headSince = now;
  }

  /** The loop or turn that sent what is still pending has ended: drop the held
   *  writes, delivering nothing, answer what was dropped so the caller can say
   *  so, and forget EVERY callback but an abort's — a write in flight included,
   *  whose landing, however late, is nobody's now (a dispatched wrap-up steer
   *  settling inside a follow-up turn would otherwise start the turn's clock or
   *  re-ask the loop's instruction into it — forgotten here, by construction,
   *  not checked by each sender). An abort's callback alone survives: a stop in
   *  flight when its loop ended is the one landing the ended loop still wants
   *  on the record (harness-pi item 16: a swallowed stop is seen, never
   *  assumed), and its sender notes what became of it and never asks again
   *  after the drop. A held follow-up steer went back to the inbox with the other unechoed
   *  steers (the loop's `requeueUnechoed`), a held wind-down steer belongs to
   *  the loop that ended (its answer then wears no label for a wrap-up pi never
   *  saw), and a prompt still in doubt when the loop settled is nothing a later
   *  turn should start — delivered later they would run a follow-up twice,
   *  steer a dead loop's finale into a turn, or hold the turn's first prompt
   *  behind a bound the dead loop was waiting out. */
  dropHeld(): Record<string, unknown>[] {
    const dropped = this.queue.map((held) => held.command);
    this.queue.length = 0;
    this.headSince = undefined;
    for (const command of this.onLanded.keys()) if (command.type !== "abort") this.onLanded.delete(command);
    return dropped;
  }

  /** Hand a write to the transport; its `onLanded`, if any, runs once the write
   *  settled there. A `held` landing leaves the callback in place: the fresh
   *  transport's re-send of the same object (through `send`) runs it. Every
   *  other landing is the write's end and the callback is told which —
   *  `dropped` included: a closed transport kept nothing, no re-send will come,
   *  and a clock or a label waiting on the write must give up now rather than
   *  wait for ever. */
  private dispatch(command: Record<string, unknown>): void {
    void this.deliver(command).then((landing) => {
      if (landing === "held") return;
      const onLanded = this.onLanded.get(command);
      this.onLanded.delete(command);
      onLanded?.(landing);
    });
  }

  /** Deliver from the head until the next prompt still awaiting its echo. A
   *  prompt that BECOMES the head has no clock until the feed is next quiet;
   *  one that already was the head keeps the clock it has (an echo of a later
   *  prompt is no reason to wait longer for the first). */
  private release(): void {
    let advanced = false;
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (head.state === "await") {
        if (advanced) this.headSince = undefined;
        return;
      }
      this.queue.shift();
      advanced = true;
      if (head.state === "send") this.dispatch(head.command);
    }
    this.headSince = undefined;
  }
}
