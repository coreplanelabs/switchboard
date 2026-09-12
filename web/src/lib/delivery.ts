import type { DeliveryIndicators, DeliveryReport } from "@core/core/delivery.js";

// The delivery page's view model: the stat tiles and the formatters the two
// tables share. Pure data in, pure strings out — the component does layout only.

/** A share as a whole percent; nothing to divide → an em dash. */
export const pct = (share: number | null): string => (share === null ? "—" : `${Math.round(share * 100)}%`);

/** Hours as a person reads them: minutes under an hour, hours under two days, days after. */
export function hours(h: number | null): string {
  if (h === null) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

export const ratio = (x: number | null, digits = 2): string => (x === null ? "—" : x.toFixed(digits));

/** An ISO day (`YYYY-MM-DD`) → `Sep 7`. */
export function monthDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** The snapshot's instant → `Sep 11, 13:51 UTC`; anything unparsable is shown as given. */
export function snapshotTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${monthDay(d.toISOString().slice(0, 10))}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/** The page's own query with `fresh=1` set — the live-read link keeps the range the viewer chose. */
export function freshHref(search: string): string {
  const params = new URLSearchParams(search);
  params.set("fresh", "1");
  return `?${params.toString()}`;
}

export interface DeliveryTile {
  label: string;
  value: string;
  note: string;
}

/** `the newest 291 pull requests` — what a truncated report's numbers cover. */
const newest = (report: DeliveryReport): string => `the newest ${report.totals.prsMerged} pull requests`;

/** The line over a truncated report's tiles: what they cover, from when the read is complete, and what
 *  the weeks before that hold. A complete report has none. */
export function coverageNote(report: DeliveryReport): string | undefined {
  if (!report.truncated) return undefined;
  const from =
    report.completeFrom === undefined
      ? "the read stopped at its page cap before the range began"
      : `the read is complete from ${snapshotTime(report.completeFrom)}; the weeks before that hold what it reached, not the week`;
  return `The tiles cover ${newest(report)} only — ${from}.`;
}

/** The six tiles over the whole range: the counts and the four leading indicators. A truncated
 *  report's Merged tile says it counts the newest pull requests, not the range's. */
export function tilesOf(report: DeliveryReport): DeliveryTile[] {
  const t = report.totals;
  return [
    {
      label: "Merged",
      value: String(t.prsMerged),
      note: report.truncated
        ? `${newest(report)} · ${t.agentAuthoredPrs} agent-authored`
        : `${t.agentAuthoredPrs} agent-authored · ${report.range.weeks} week${report.range.weeks === 1 ? "" : "s"}`,
    },
    {
      label: "Issue → merge",
      value: hours(t.leadTimeHours.median),
      note: t.leadTimeHours.mean === null ? "no merges in range" : `median · mean ${hours(t.leadTimeHours.mean)}`,
    },
    {
      label: "First-pass CI",
      value: pct(t.firstPassCi.share),
      note:
        t.firstPassCi.known === 0
          ? "no CI facts in range"
          : `${t.firstPassCi.passed} of ${t.firstPassCi.known} green at the first attempt`,
    },
    {
      label: "Review rounds",
      value: ratio(t.reviewRounds.perPr),
      note: `per PR · ${t.reviewRounds.verdicts} verdicts, ${t.reviewRounds.fixRounds} fix round${t.reviewRounds.fixRounds === 1 ? "" : "s"}`,
    },
    {
      label: "No human edit",
      value: pct(t.findings.noHumanEditShare),
      note:
        t.findings.total === 0 ? "no findings in range" : `of ${t.findings.total} findings resolved by an agent alone`,
    },
    {
      label: "Blocking caught",
      value: String(t.findings.blocking),
      note: `${t.findings.major} major · ${t.findings.minor} minor · ${t.findings.nit} nit`,
    },
  ];
}

/** `8 (2 blocking)` — a findings cell. */
export function findingsCell(x: DeliveryIndicators): string {
  return x.findings.total === 0
    ? "0"
    : `${x.findings.total}${x.findings.blocking > 0 ? ` (${x.findings.blocking} blocking)` : ""}`;
}

/** `5/6` — a first-pass CI cell; nothing known → an em dash. */
export function ciCell(x: DeliveryIndicators): string {
  return x.firstPassCi.known === 0 ? "—" : `${x.firstPassCi.passed}/${x.firstPassCi.known}`;
}
