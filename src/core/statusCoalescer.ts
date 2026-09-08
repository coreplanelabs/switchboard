import type { StatusHandle, StatusUpdate } from "./types.js";

/**
 * Rate-limit a channel's status card to at most one edit per `minIntervalMs`,
 * always ending on the NEWEST frame.
 *
 * The dispatcher refreshes the card on every run event (tool_call, tool_result,
 * checklist update) plus a 5 s heartbeat. A turn that reads five files fires
 * ten edits inside a second — Slack's `chat.update` is ~1 req/s per channel, so
 * the excess queues behind the client's retry-after handling and the card
 * falls behind reality (the final `done` frame waits behind stale ones).
 *
 * Semantics: the first update after a quiet stretch goes out immediately; while
 * the interval is still running, updates only replace the pending frame and one
 * trailing edit flushes it when the interval ends. A frame identical to the last
 * one sent is skipped (the heartbeat re-renders an unchanged card). `done`
 * cancels the trailing edit and writes its frame at once — the terminal frame
 * never waits and is never superseded by a stale trailing flush.
 */
export function coalesceStatus(
  inner: StatusHandle,
  minIntervalMs: number,
  now: () => number = Date.now,
  schedule: (fn: () => void, ms: number) => { unref?(): void } = setTimeout,
): StatusHandle {
  let lastSentAt = -Infinity;
  let lastSent: string | undefined;
  let pending: StatusUpdate | undefined;
  let timer: { unref?(): void } | undefined;
  let closed = false;

  const key = (f: StatusUpdate) => `${f.title}\n${f.detail ?? ""}\n${f.link?.url ?? ""}\n${f.link?.label ?? ""}`;
  const flush = () => {
    timer = undefined;
    if (!pending || closed) return;
    const frame = pending;
    pending = undefined;
    const k = key(frame);
    if (k === lastSent) return;
    lastSent = k;
    lastSentAt = now();
    inner.update(frame);
  };

  return {
    ...(inner.handle ? { handle: inner.handle } : {}),
    update(frame) {
      if (closed) return;
      pending = frame;
      if (timer) return; // a trailing flush is already armed; it will send the newest frame
      const wait = lastSentAt + minIntervalMs - now();
      if (wait <= 0) {
        flush();
        return;
      }
      timer = schedule(flush, wait);
      timer.unref?.();
    },
    async done(frame) {
      closed = true;
      pending = undefined;
      // The armed timer finds `closed` and does nothing; no clearTimeout needed
      // (and `schedule` may not hand back something clearable).
      await inner.done(frame);
    },
  };
}
