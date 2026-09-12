// The settle stage of the dispatch pipeline (docs/decisions/0025-dispatch-pipeline-as-built.md,
// docs/reference/specs/thread-admission.md item 4): when a request is over, the
// thread is freed and whatever the run never consumed is settled — handed on as
// ONE fresh turn when the run ended by itself, or dropped with a note to each
// sender when an operator stopped it. `dispatch()` calls `settleThread` from
// its outer finally, ends the request's root with the settlement's stop mode,
// and runs the fresh turn `prepareFreshTurn` builds as an ordinary dispatch of
// its own — the recursion stays a real call to `dispatch()`, in `dispatch()`.
import type { StopMode } from "../runEvents.js";
import type { Clock, Span } from "../trace/types.js";
import type { RunControl } from "../runRegistry/runControl.js";
import { channelOf, startRequestRoot, type RequestTrace, type RequestTraceDeps } from "../requestTrace.js";
import { mergeFollowUps, type LiveThread } from "../threadAdmission.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import { defaultAdmission, type AdmissionDeps, type DispatchFollowUp } from "./admission.js";

/** The note a follow-up's sender gets when the run it was folded into was
 *  stopped by an operator before its next step read it. */
export const FOLLOW_UP_DROPPED_BY_STOP =
  "⛔ The run this was folded into was stopped before it read this follow-up, so it was not run. Re-send it to run it fresh.";

/** What the settle stage reads off the dispatch when the request is over. */
export interface SettleContext {
  msg: IncomingMessage;
  /** The thread slot this dispatch holds — undefined when admission never granted one. */
  admitted: LiveThread<DispatchFollowUp> | undefined;
  /** True once the run loop owned the run: a stop relayed during an attach that
   *  then refused stopped nothing, and the follow-ups run fresh. */
  runLoopStarted: boolean;
  /** The registered run's stop control; undefined when no run was created. */
  control: RunControl | undefined;
}

/** A person's follow-up: one with a channel handle to answer on. The other
 *  kind — a steer a run sent (`from`) — never reaches a settlement. */
export type PersonFollowUp = DispatchFollowUp & { io: ChannelIO };

const fromPerson = (p: DispatchFollowUp): p is PersonFollowUp => p.from === undefined && p.io !== undefined;

/** How the thread was settled. `stopMode` is what the request's root reports. */
export type Settlement =
  /** Nothing was left unconsumed. */
  | { kind: "quiet"; stopMode: StopMode | undefined }
  /** An operator stopped the run: the follow-ups are not run; `tellDropped` tells each sender. */
  | { kind: "dropped"; stopMode: StopMode; pending: PersonFollowUp[] }
  /** The run ended by itself: the follow-ups are handed on as one fresh turn for this agent. */
  | { kind: "handed-on"; agent: string; pending: PersonFollowUp[] };

/**
 * Thread admission item 4: free the thread, and settle what the run never
 * consumed. A run that ended by itself (an answer, a budget, a failure, a dead
 * sandbox) hands its unconsumed follow-ups on as ONE fresh turn — on the most
 * recent sender's channel handle, so the reply lands where they asked — never
 * a silent drop. A run an operator stopped does not: the stop meant "no more
 * work here", and each sender is told their follow-up was not run. A steer a
 * run sent (thread-admission item 7) is neither: a program's message has no
 * one to answer and is never run fresh — the parent reads the child's end
 * through its own tools — so it is set aside with a log line. Synchronous on
 * purpose: the quiet path awaits nothing, exactly as the inline code did, so
 * nothing that rides on the dispatch's microtask order (a reflection scheduled
 * after the reply) moves.
 */
export function settleThread(deps: Pick<AdmissionDeps, "admission">, ctx: SettleContext): Settlement {
  const { msg, admitted, runLoopStarted, control } = ctx;
  const admission = deps.admission ?? defaultAdmission;
  const released = admitted ? admission.release(msg.threadKey, admitted) : [];
  const pending = released.filter(fromPerson);
  const fromRuns = released.length - pending.length;
  if (fromRuns > 0)
    console.log(`[dispatch] ${msg.threadKey} ${fromRuns} steer(s) from a parent run never read — not run fresh`);
  // A stop counts once the run loop had the run: a stop relayed during an
  // attach that then refused stopped nothing, and the follow-ups run fresh.
  const stopMode: StopMode | undefined = runLoopStarted ? control?.requested : undefined;
  if (pending.length > 0 && stopMode) {
    console.log(`[dispatch] ${msg.threadKey} ${pending.length} follow-up(s) dropped: run stopped (${stopMode})`);
    return { kind: "dropped", stopMode, pending };
  }
  if (pending.length > 0 && admitted) {
    console.log(`[dispatch] ${msg.threadKey} ${pending.length} unconsumed follow-up(s) → fresh turn`);
    return { kind: "handed-on", agent: admitted.agent, pending };
  }
  return { kind: "quiet", stopMode };
}

/** Each dropped follow-up's sender is told it was not run — one `post.followups` span. */
export async function tellDropped(root: Span, pending: PersonFollowUp[]): Promise<void> {
  await root.span("post.followups", async () => {
    for (const p of pending) await p.io.reply(FOLLOW_UP_DROPPED_BY_STOP).catch(() => {});
  });
}

/** The fresh turn's request: the message, the channel handle to reply on, and
 *  the dispatch options `dispatch()` takes. */
export interface FreshTurn {
  msg: IncomingMessage;
  io: ChannelIO;
  opts: { trace: RequestTrace; queuedBehindMs: number };
}

/**
 * The fresh turn is a request of its own (docs/reference/specs/tracing.md): it
 * was received NOW, and it waited behind the run that just ended since its
 * earliest follow-up arrived — the `queued … behind the previous run` caption,
 * on the root at start so the fresh run's record carries it. Pinned to the
 * agent the follow-ups were addressed to: they were admitted as input FOR that
 * run's agent (a different one would have been refused), so the fresh turn must
 * not fall back to whatever the thread's history or the channel default
 * resolves to. Built after the first request's root has ended; `dispatch()`
 * runs it.
 */
export function prepareFreshTurn(
  deps: RequestTraceDeps,
  ctx: { agent: string; pending: PersonFollowUp[]; clock: Clock },
): FreshTurn {
  const { agent, pending, clock } = ctx;
  const merged = mergeFollowUps(pending)!;
  const last = pending[pending.length - 1];
  const freshAt = clock();
  const earliestAt = Math.min(...pending.map((p) => p.at));
  const queuedBehindMs = Math.max(0, freshAt - earliestAt);
  const fresh = startRequestRoot(deps, {
    channel: channelOf(last.msg.channelId),
    receivedAt: freshAt,
    queuedBehindMs,
  });
  return {
    // The follow-up's own platform stamp stays behind: the fresh turn's
    // wait is `queuedBehindMs`, not a `queued … before we saw it`.
    msg: {
      ...last.msg,
      ...merged,
      text: `agent:${agent} ${merged.text}`,
      receivedAt: freshAt,
      originAt: undefined,
    },
    io: last.io,
    opts: { trace: fresh, queuedBehindMs },
  };
}
