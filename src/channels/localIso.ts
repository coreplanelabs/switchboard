/**
 * An epoch-ms instant as an ISO-8601 timestamp in a local zone, second
 * precision, with the numeric offset: `2026-08-29T17:47:44-07:00`.
 *
 * `offsetMinutes` follows `Date#getTimezoneOffset` (minutes *west* of UTC, so
 * PDT is 420) and defaults to the runtime's zone — in the browser, the viewer's.
 *
 * A pure leaf with no imports: the dashboard bundle imports it straight from
 * here (web/src/lib/format.ts), the same way as the markdown renderer and the
 * timeline, so server and browser format an instant identically.
 */
export function formatLocalIso(at: number, offsetMinutes?: number): string {
  const off = typeof offsetMinutes === "number" ? offsetMinutes : new Date(at).getTimezoneOffset();
  // Shift the instant by the offset, then read the fields as UTC: the zone's
  // wall-clock without depending on the runtime zone for any field but `off`.
  const d = new Date(at - off * 60000);
  function p(n: number): string {
    return (n < 10 ? "0" : "") + n;
  }
  const sign = off <= 0 ? "+" : "-";
  const abs = Math.abs(off);
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
