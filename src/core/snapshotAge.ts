// How old a snapshot is, in the words every page that serves one uses (the
// delivery page, the costs page): shared so the two never drift. Node-free.

/** `just now`, `n minutes ago`, `n hours ago`, `n days ago` — the snapshot's age at `nowMs`; empty for an unparsable instant. */
export function snapshotAgeText(snapshotAt: string, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(snapshotAt)) / 60_000));
  if (!Number.isFinite(minutes)) return "";
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (minutes < 1) return "just now";
  if (minutes < 90) return unit(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return unit(hours, "hour");
  return unit(Math.round(hours / 24), "day");
}

/** `in n minutes`, `in n hours`, `in n days` — how far off an instant is at `nowMs`; once it has passed,
 *  `due now` for the first minute and `due n minutes ago` after (so an overdue take reads as overdue,
 *  not as forever imminent); empty for an unparsable instant. */
export function untilText(at: string, nowMs: number): string {
  const diffMs = Date.parse(at) - nowMs;
  if (!Number.isFinite(diffMs)) return "";
  if (diffMs <= -60_000) return `due ${snapshotAgeText(at, nowMs)}`;
  if (diffMs < 60_000) return "due now";
  const minutes = Math.floor(diffMs / 60_000);
  const unit = (n: number, word: string): string => `in ${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes < 90) return unit(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return unit(hours, "hour");
  return unit(Math.round(hours / 24), "day");
}
