// Display helpers for the runs index (features/live-view.md item 16), shared
// by the server and the dashboard bundle (web/src/lib/format.ts imports them
// straight from here), so a server-rendered row and its client repaint agree
// byte for byte. Pure leaf module: no imports, no module-scope state.

/** A stopwatch reading for a run: `38s`, `4m 12s`, `1h 03m`. Two parts above a
 *  minute so the column stays a fixed width as the numbers tick. Negative or
 *  non-finite input (clock skew, a missing stamp) reads `0s`, never `NaN`. */
export function formatElapsed(ms: number): string {
  if (!(ms > 0)) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60 < 10 ? "0" : "") + (s % 60) + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60 < 10 ? "0" : "") + (m % 60) + "m";
}

/** When a run started, the way GitHub and Linear say it (live-view item 20):
 *  `just now` (< 45 s), `1 minute ago` … `59 minutes ago`, `1 hour ago` … `23
 *  hours ago`, `yesterday`, `2 days ago` … `6 days ago`, then the date — `Aug 28`
 *  in the current year, `Aug 28, 2025` otherwise. A future or non-finite
 *  `startedAt` reads `just now`. Date parts come from the runtime's zone (the
 *  viewer's in the browser); `now` is passed so the server and a test are
 *  deterministic. */
export function formatRelative(startedAt: number, now: number): string {
  const delta = now - startedAt;
  if (!(delta > 45000)) return "just now";
  const m = Math.floor(delta / 60000);
  if (m < 60) return m <= 1 ? "1 minute ago" : m + " minutes ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? "1 hour ago" : h + " hours ago";
  const d = Math.floor(h / 24);
  if (d < 7) return d === 1 ? "yesterday" : d + " days ago";
  const dt = new Date(startedAt);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const label = months[dt.getMonth()] + " " + dt.getDate();
  return dt.getFullYear() === new Date(now).getFullYear() ? label : label + ", " + dt.getFullYear();
}

/** A moment for humans — `Aug 30, 9:12 PM` (`Aug 30, 2025, 9:12 PM` in another
 *  year than `now`'s) — in the runtime's zone (the viewer's in the browser).
 *  Used where a row states a time rather than a distance: when a leaving row is
 *  removed, which runs an older page holds (live-view item 21). */
export function formatDateTime(at: number, now: number): string {
  const dt = new Date(at);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h = dt.getHours();
  const min = dt.getMinutes();
  const time = (h % 12 === 0 ? 12 : h % 12) + ":" + (min < 10 ? "0" : "") + min + (h < 12 ? " AM" : " PM");
  const day = months[dt.getMonth()] + " " + dt.getDate();
  return (dt.getFullYear() === new Date(now).getFullYear() ? day : day + ", " + dt.getFullYear()) + ", " + time;
}

/** The dispatcher's run label (`composeRunLabel`: `agent · scope · "snippet"`)
 *  split into what the row styles differently: the agent (a chip), the scope
 *  (repo or `#channel · user`) and the quoted request snippet. Anything that is
 *  not in that shape is returned whole as `scope` — the row degrades to the
 *  plain label rather than mis-labelling a part. */
export function splitRunLabel(label: string): { agent?: string; scope: string; snippet?: string } {
  const parts = label.split(" · ");
  const out: { agent?: string; scope: string; snippet?: string } = { scope: label };
  if (parts.length < 2 || !/^[a-z][a-z0-9_-]*$/.test(parts[0])) return out;
  out.agent = parts[0];
  let rest = parts.slice(1);
  const last = rest[rest.length - 1];
  if (rest.length >= 2 && last.length >= 2 && last.charAt(0) === '"' && last.charAt(last.length - 1) === '"') {
    out.snippet = last.slice(1, -1);
    rest = rest.slice(0, -1);
  }
  out.scope = rest.join(" · ");
  return out;
}
