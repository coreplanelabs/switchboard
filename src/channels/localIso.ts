/**
 * An epoch-ms instant as an ISO-8601 timestamp in a local zone, second
 * precision, with the numeric offset: `2026-08-29T17:47:44-07:00`.
 *
 * `offsetMinutes` follows `Date#getTimezoneOffset` (minutes *west* of UTC, so
 * PDT is 420) and defaults to the runtime's zone — in the browser, the viewer's.
 *
 * Written as plain ES5 with no imports: the run page inlines it with
 * `String(formatLocalIso)` (see liveView.ts), the same build step as the
 * markdown renderer and the timeline.
 */
export function formatLocalIso(at: number, offsetMinutes?: number): string {
  var off = typeof offsetMinutes === "number" ? offsetMinutes : new Date(at).getTimezoneOffset();
  // Shift the instant by the offset, then read the fields as UTC: the zone's
  // wall-clock without depending on the runtime zone for any field but `off`.
  var d = new Date(at - off * 60000);
  function p(n: number): string {
    return (n < 10 ? "0" : "") + n;
  }
  var sign = off <= 0 ? "+" : "-";
  var abs = Math.abs(off);
  return (
    d.getUTCFullYear() +
    "-" +
    p(d.getUTCMonth() + 1) +
    "-" +
    p(d.getUTCDate()) +
    "T" +
    p(d.getUTCHours()) +
    ":" +
    p(d.getUTCMinutes()) +
    ":" +
    p(d.getUTCSeconds()) +
    sign +
    p(Math.floor(abs / 60)) +
    ":" +
    p(abs % 60)
  );
}
