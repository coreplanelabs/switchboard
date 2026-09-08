// `load:cards`: the status-card path at N concurrent runs, simulated in
// virtual time over the REAL coalescer (`coalesceStatus`) and the REAL process
// budget (`createStatusBudget`) against the fake Slack Web API and its
// published limits. The HTTP ingress `status()` handle is a no-op, so an
// end-to-end run through `/ingress` exercises zero card traffic; this is where
// "fifty cards is a Slack rate limit" (the plan's second tipping point) gets a
// number: card update lag p50/p95/max, refused edits, frames the budget held
// back, and whether every terminal frame landed. Two client models: the
// `budgeted` one is the Slack adapter as shipped (docs/reference/specs/run-visibility.md
// item 9); `retrying` is the pre-budget adapter on the WebClient's default
// policy, kept as the baseline the budget is measured against. Deterministic,
// instant, no I/O.

import { coalesceStatus } from "../core/statusCoalescer.js";
import { createStatusBudget, STATUS_EDITS_PER_MINUTE } from "../core/statusBudget.js";
import type { StatusHandle, StatusUpdate } from "../core/types.js";
import { FakeSlack, type FakeSlackStats } from "./fakeSlack.js";

export type CardsClientModel = "budgeted" | "retrying";

/** The Slack adapter's cap on terminal re-sends (`TERMINAL_RESENDS` in `src/channels/slack.ts`). */
const TERMINAL_RESENDS = 10;

export interface CardsLoadParams {
  cards: number;
  /** How long each card lives before its terminal frame. */
  holdMs: number;
  /** Distinct channels the cards spread over (16 cards in one channel is the production shape). */
  channels?: number;
  /** The dispatcher's heartbeat (5 s) — re-renders the elapsed time. */
  heartbeatMs?: number;
  /** A tool event (a new detail line) every this often per card. */
  eventEveryMs?: number;
  /** The coalescer's floor between edits (`STATUS_UPDATE_MIN_MS`, 3 s). */
  minIntervalMs?: number;
  /** Which adapter the edits go through (default `budgeted`, the shipped one). */
  client?: CardsClientModel;
  /** `budgeted`: the process budget's rate (default Slack's published `chat.update` allowance). */
  budgetPerMinute?: number;
  /** `retrying`: how many times a refused edit is re-sent before it is given up
   *  (the WebClient's default retry budget). */
  maxRetriesPerFrame?: number;
  perAppPerMinute?: number;
  perChannelPerSecond?: number;
}

export interface CardsLoadOutcome {
  client: CardsClientModel;
  stats: FakeSlackStats;
  /** Frames the dispatcher side produced (before coalescing). */
  framesProduced: number;
  /** `budgeted`: progress frames the process budget held back (never sent; the next frame repaints). */
  budgetDropped: number;
  /** `budgeted`: terminal frames the budget could not fund at once — sent when it was, the reply never waiting. */
  terminalWaited: number;
  /** `budgeted`: terminal re-sends after a `ratelimited` answer (up to the adapter's cap per frame). */
  terminalResent: number;
  /** `retrying`: edits re-sent after a `ratelimited` answer. */
  retries: number;
  /** `retrying`: refused frames not re-sent because a newer frame for the card
   *  had already been produced — a real client would have spent the retry on a
   *  stale card, so the count is the waste the limit causes. */
  staleDropped: number;
  /** `retrying`: frames given up after `maxRetriesPerFrame`. */
  givenUp: number;
  /** Cards whose terminal frame was accepted. */
  terminalAccepted: number;
  /** Virtual ms the whole simulation spanned. */
  spanMs: number;
}

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
}

/** Insert keeping `timers` ordered by (at, seq) — a binary search, so a long
 *  simulation stays linear-log in its events. */
function insertTimer(timers: Timer[], t: Timer): void {
  let lo = 0;
  let hi = timers.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const m = timers[mid];
    if (m.at < t.at || (m.at === t.at && m.seq < t.seq)) lo = mid + 1;
    else hi = mid;
  }
  timers.splice(lo, 0, t);
}

export function simulateCards(params: CardsLoadParams): CardsLoadOutcome {
  const heartbeatMs = params.heartbeatMs ?? 5_000;
  const eventEveryMs = params.eventEveryMs ?? 7_000;
  const minIntervalMs = params.minIntervalMs ?? 3_000;
  const maxRetries = params.maxRetriesPerFrame ?? 10;
  const channels = Math.max(1, params.channels ?? 1);
  const model: CardsClientModel = params.client ?? "budgeted";

  let t = 0;
  let seq = 0;
  const timers: Timer[] = [];
  const now = () => t;
  const schedule = (fn: () => void, ms: number) => {
    insertTimer(timers, { at: t + Math.max(0, ms), seq: seq++, fn });
    return {};
  };

  const slack = new FakeSlack({
    now,
    ...(params.perAppPerMinute !== undefined ? { perAppPerMinute: params.perAppPerMinute } : {}),
    ...(params.perChannelPerSecond !== undefined ? { perChannelPerSecond: params.perChannelPerSecond } : {}),
  });
  // One budget for the whole simulated process, like the adapter's.
  const budget = createStatusBudget({ perMinute: params.budgetPerMinute ?? STATUS_EDITS_PER_MINUTE, now });
  const producedAt = new WeakMap<StatusUpdate, number>();
  let framesProduced = 0;
  let budgetDropped = 0;
  let terminalWaited = 0;
  let terminalResent = 0;
  let retries = 0;
  let staleDropped = 0;
  let givenUp = 0;
  let terminalAccepted = 0;

  for (let i = 0; i < params.cards; i++) {
    const channel = `C${i % channels}`;
    const posted = slack.postMessage({ channel, thread_ts: `${i}.000`, text: "⏳ starting" });
    if (!posted.ok) continue;
    const ts = posted.ts;
    const update = (frame: StatusUpdate) =>
      slack.update({ channel, ts, text: `${frame.title}\n${frame.detail ?? ""}`, frameAt: producedAt.get(frame) ?? t });

    let inner: StatusHandle;
    if (model === "budgeted") {
      // The shipped adapter: a progress frame asks the budget first (reserve and
      // fair share) and is dropped when refused or rate-limited; the terminal
      // frame reserves a token, goes out when it is funded, and is re-sent
      // after Retry-After up to the adapter's cap.
      const card = `${channel}:${ts}`;
      budget.open(card);
      const sendTerminal = (frame: StatusUpdate, attempt: number) => {
        const r = update(frame);
        if (r.ok) {
          terminalAccepted++;
          return;
        }
        if (r.error !== "ratelimited" || attempt >= TERMINAL_RESENDS) return;
        terminalResent++;
        schedule(() => sendTerminal(frame, attempt + 1), (r.retryAfterS ?? 1) * 1000);
      };
      inner = {
        update: (frame) => {
          if (!budget.tryProgress(card, channel)) {
            budgetDropped++;
            return;
          }
          update(frame);
        },
        done: async (frame) => {
          budget.close(card);
          const waitMs = budget.takeTerminal(channel);
          if (waitMs === 0) sendTerminal(frame, 0);
          else {
            terminalWaited++;
            schedule(() => sendTerminal(frame, 0), waitMs);
          }
        },
      };
    } else {
      // The pre-budget adapter: one chat.update per frame; on `ratelimited`
      // the WebClient waits Retry-After and re-sends the SAME frame, up to its
      // retry budget.
      let latestSent: StatusUpdate | undefined;
      const send = (frame: StatusUpdate, terminal: boolean, attempt: number) => {
        if (!terminal && latestSent !== frame) {
          staleDropped++;
          return;
        }
        const r = update(frame);
        if (!r.ok && r.error === "ratelimited") {
          if (attempt >= maxRetries) {
            givenUp++;
            return;
          }
          retries++;
          schedule(() => send(frame, terminal, attempt + 1), (r.retryAfterS ?? 1) * 1000);
          return;
        }
        if (r.ok && terminal) terminalAccepted++;
      };
      inner = {
        update: (frame) => {
          latestSent = frame;
          send(frame, false, 0);
        },
        done: async (frame) => {
          latestSent = frame;
          send(frame, true, 0);
        },
      };
    }

    const handle = coalesceStatus(inner, minIntervalMs, now, schedule);
    const startedAt = t;
    const produce = (title: string, detail: string) => {
      const frame: StatusUpdate = { title, detail };
      producedAt.set(frame, t);
      framesProduced++;
      handle.update(frame);
    };
    for (let at = heartbeatMs; at < params.holdMs; at += heartbeatMs) {
      schedule(() => produce(`⚡ coding · ${Math.round((t - startedAt) / 1000)}s`, `heartbeat`), at);
    }
    for (let at = eventEveryMs; at < params.holdMs; at += eventEveryMs) {
      const n = at / eventEveryMs;
      schedule(() => produce(`⚡ coding · ${Math.round((t - startedAt) / 1000)}s`, `tool ${n}: bash npm test`), at);
    }
    schedule(() => {
      const frame: StatusUpdate = { title: `✅ coding · ${Math.round(params.holdMs / 1000)}s`, detail: "done" };
      producedAt.set(frame, t);
      framesProduced++;
      void handle.done(frame);
    }, params.holdMs);
  }

  while (timers.length > 0) {
    const next = timers.shift()!;
    t = Math.max(t, next.at);
    next.fn();
  }

  return {
    client: model,
    stats: slack.stats(),
    framesProduced,
    budgetDropped,
    terminalWaited,
    terminalResent,
    retries,
    staleDropped,
    givenUp,
    terminalAccepted,
    spanMs: t,
  };
}
