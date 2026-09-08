// Delivery-time dedupe: the same-process handled-set the live path and the
// reconnect catch-up share, and the redelivery guard that consults it.

import { systemClock } from "../../core/trace/clock.js";
import { botRepliedAfter, fetchReplies, type CatchUpClient, type SlackHistoryMessage } from "../slackCatchUp.js";

// Same-process dedupe for the reconnect catch-up: (channel, ts) pairs this
// process has accepted, live or via catch-up, so a message delivered both ways
// runs once. Bounded FIFO; the durable record is Slack (👀 / bot reply).
const HANDLED_MAX = 5000;
const handledHere = new Set<string>();
function markHandledHere(channel: string, ts: string): void {
  handledHere.add(`${channel}:${ts}`);
  if (handledHere.size > HANDLED_MAX) {
    const oldest = handledHere.values().next().value;
    if (oldest !== undefined) handledHere.delete(oldest);
  }
}
export function wasHandledHere(channel: string, ts: string): boolean {
  return handledHere.has(`${channel}:${ts}`);
}
/** A live delivery older than this is not live: Slack delivers events within
 *  seconds, so an old `ts` means the event was RE-delivered (its original
 *  delivery was never acked — a deploy blackout) or flushed after a blackout.
 *  Only those pay the guard's one thread fetch. */
export const STALE_DELIVERY_MS = 60_000;

/** Delivery-time dedupe. Slack re-delivers an event whose original delivery
 *  was never acked — a mention posted into a deploy blackout comes back
 *  minutes later, after the reconnect catch-up has already answered it (⏱
 *  note, card, answer). The handled-set alone does not cover that: `handle()`
 *  marks it, but only the catch-up scan consulted it, so the live path ran
 *  the redelivery again in full and a second answer landed. This guard is the
 *  live path's consult.
 *
 *  Claims (channel, ts) and answers why the event must be DROPPED, or null to
 *  proceed:
 *  1. Same-process: the pair is already in the handled-set (handled live or by
 *     this process's catch-up) — drop without any API call.
 *  2. Cross-process (the first handling died with the old container): a live
 *     delivery older than `STALE_DELIVERY_MS` pays ONE `conversations.replies`
 *     fetch and is dropped when the bot has already posted in the thread after
 *     it. A stale event with 👀 but NO bot reply after it still runs — that is
 *     the ack-then-killed shape (docs/decisions/0012-reconnect-catch-up-as-recovery.md),
 *     and re-running it is the point.
 *  Fail-open: an unfetchable thread runs the event — a lost request is worse
 *  than the duplicate this guard exists to prevent. Catch-up replays
 *  (`caughtUp`) skip both checks: the scan already decided, against the same
 *  Slack state, that the message is unanswered.
 *
 *  Claim-before-await: the mark lands before the guard's fetch, so a
 *  concurrent second delivery of the same (channel, ts) hits check 1 no matter
 *  how the awaits interleave. */
export async function dedupeDelivery(
  client: Pick<CatchUpClient, "conversations">,
  ev: { channel: string; ts: string; threadTs: string; botUserId?: string; caughtUp?: true },
  nowMs: number = systemClock(),
  state: { was: (c: string, ts: string) => boolean; mark: (c: string, ts: string) => void } = {
    was: wasHandledHere,
    mark: markHandledHere,
  },
): Promise<string | null> {
  if (!ev.caughtUp && state.was(ev.channel, ev.ts)) {
    return "already handled in this process (a Slack redelivery)";
  }
  state.mark(ev.channel, ev.ts);
  if (ev.caughtUp || !ev.botUserId) return null;
  const ageMs = nowMs - Number(ev.ts) * 1000;
  if (!Number.isFinite(ageMs) || ageMs < STALE_DELIVERY_MS) return null;
  let thread: SlackHistoryMessage[];
  try {
    thread = await fetchReplies(client, ev.channel, ev.threadTs);
  } catch {
    return null;
  }
  if (!botRepliedAfter(thread, { ts: ev.ts }, ev.botUserId)) return null;
  return `already answered in its thread (delivered ${Math.round(ageMs / 1000)}s after it was posted — a Slack redelivery)`;
}
