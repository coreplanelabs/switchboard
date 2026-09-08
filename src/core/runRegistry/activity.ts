import type { RunEvent } from "../runEvents.js";

// The one-line "what is it doing" the runs index shows on a run's status dot
// (docs/reference/specs/live-view.md item 20). One rule for the live summary
// (the registry refreshes it as each event is appended) and for the persisted
// record (the record writer derives it from the events at finish).

/** First line of `text`, whitespace collapsed, cut at `max` with an ellipsis —
 *  the index's one-line activity (events are already redacted upstream). */
function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The one-line activity an event contributes (live-view item 20): the newest
 *  narration's first line, a tool call's summary, or the answer's first line —
 *  for a failed inline run that is the `⚠️ <error>` reply, so the index can
 *  say WHAT failed. Other events contribute nothing (`undefined`). One rule for
 *  the live summary (`publish`) and the persisted record (`activityOfEvents`). */
export function activityOf(event: RunEvent): string | undefined {
  if (event.type === "assistant" || event.type === "answer") return oneLine(event.text, 120);
  if (event.type === "tool_call") return oneLine(event.summary, 120);
  return undefined;
}

/** The latest activity across a run's events (the record writer's rule). */
export function activityOfEvents(events: readonly RunEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const a = activityOf(events[i]);
    if (a !== undefined) return a;
  }
  return undefined;
}
