import { DAY_MS } from "../budgets.js";

export interface HomeWeek {
  startDate: string;
  timeZone: string;
  start: number;
  end: number;
  label: string;
  previousUrl: string;
  nextUrl?: string;
}
const iso = (at: number) => new Date(at).toISOString().slice(0, 10);
function calendar(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid week");
  const value = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(value) || iso(value) !== date) throw new Error("Invalid week");
  return value;
}
function parts(at: number, timeZone: string) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
}
function midnight(date: string, timeZone: string): number {
  const target = calendar(date);
  let candidate = target;
  for (let tries = 0; tries < 4; tries++) {
    const p = parts(candidate, timeZone);
    const displayed = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    );
    if (displayed === target) return candidate;
    candidate += target - displayed;
  }
  throw new Error("Week boundary is unavailable in this time zone");
}
/** Calendar boundaries are converted separately: a DST week is not always 168 hours. */
export function homeWeek(now: number, selected?: string, requestedZone = "UTC"): HomeWeek {
  if (!Number.isFinite(now) || requestedZone.length > 100) throw new Error("Invalid week");
  const timeZone = new Intl.DateTimeFormat("en-US", { timeZone: requestedZone }).resolvedOptions().timeZone;
  const today = parts(now, timeZone);
  const todayAt = calendar(`${today.year}-${today.month}-${today.day}`);
  const current = todayAt - new Date(todayAt).getUTCDay() * DAY_MS;
  const startDate = selected ?? iso(current);
  const localStart = calendar(startDate);
  if (new Date(localStart).getUTCDay() !== 0 || localStart > current)
    throw new Error("Choose a current or past Sunday");
  const localEnd = localStart + 7 * DAY_MS;
  const link = (at: number) => `/home/history?week=${iso(at)}&tz=${encodeURIComponent(timeZone)}`;
  const format = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return {
    startDate,
    timeZone,
    start: midnight(startDate, timeZone),
    end: midnight(iso(localEnd), timeZone),
    label: `${format.format(localStart)} – ${format.format(localEnd - DAY_MS)}`,
    previousUrl: link(localStart - 7 * DAY_MS),
    ...(localStart < current ? { nextUrl: link(localEnd) } : {}),
  };
}
