// One import site for the shared formatters (src/channels/*): the same
// implementations the bot's chat/CLI surfaces and the old server renderer use.

export { formatDateTime, formatRelative, splitRunLabel } from "@core/channels/indexFormat.js";
export { formatDuration } from "@core/core/time/formatDuration.js";
export { formatLocalIso } from "@core/channels/localIso.js";

/** The timeline clock: `5:19:57 PM PDT` — the viewer's 12-hour wall time with
 *  their zone's short name (falls back to bare time where the runtime has no
 *  zone names). Web-only: chat/CLI surfaces never render a ticking clock. */
export function formatClock(at: number): string {
  const d = new Date(at);
  const h = d.getHours();
  const p = (n: number): string => String(n).padStart(2, "0");
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(d)
    .find((part) => part.type === "timeZoneName")?.value;
  return `${h % 12 === 0 ? 12 : h % 12}:${p(d.getMinutes())}:${p(d.getSeconds())} ${h < 12 ? "AM" : "PM"}${zone ? ` ${zone}` : ""}`;
}
