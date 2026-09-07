// The residents view model shared by the bot server (residentsView.ts routes
// the /residents pages and looks records up by slug) and the web app (which
// renders them). Node-free and dependency-free: the web bundle imports it.

import type { DiskSample } from "../execution/residentDiskBudget.js";

/** Lowercase `owner/name` — the resident Worker's REPO_ID_RE shape. */
export const RESIDENT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;

/** One registry record + the resident DO's live engine view, as returned by
 *  the admin `GET /residents` route. Fields are read defensively: the view is
 *  a display of whatever the resident reports, never a contract the bot
 *  enforces. `live` is `{error}` when the DO could not be reached. */
export interface ResidentRecordView {
  resource?: unknown;
  commands?: unknown;
  effects?: unknown;
  defaultRef?: unknown;
  diskBudgetMb?: unknown;
  provisioningTimeoutMs?: unknown;
  worktreeTtlDays?: unknown;
  onboardedAt?: unknown;
  updatedAt?: unknown;
  live?: unknown;
}

export interface ResidentListing {
  cap?: unknown;
  count?: unknown;
  residents: ResidentRecordView[];
}

export type ResidentTone = "green" | "amber" | "red" | "grey";

/** Lifecycle state → dot color. Unknown/unreachable → grey. */
export function residentStateTone(state: string): ResidentTone {
  switch (state) {
    case "warm":
      return "green";
    case "onboarding":
    case "refreshing":
    case "restoring":
      return "amber";
    case "degraded":
    case "down":
      return "red";
    default:
      return "grey";
  }
}

export const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
export const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

export function residentSlug(record: ResidentRecordView): string {
  return str(record.resource).replace(/^repo:/, "");
}

/** The live view's `disk` (features/resident-repos.md item 55): the resident's
 *  last `df` + `du` sample, or null when it has not measured yet (a fresh
 *  container before its first cycle) or the field is malformed. The shape is
 *  the resident's `DiskSample` (KiB; a `parts` value may be null = unmeasured,
 *  rendered "?"), validated field by field — the view displays, never trusts. */
export interface ResidentDiskView extends DiskSample {}

const kib = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const kibMap = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(rec(v))) {
    const value = kib(n);
    if (value !== null) out[k] = value;
  }
  return out;
};

export function residentDisk(record: ResidentRecordView): ResidentDiskView | null {
  const d = rec(residentLive(record).disk);
  const total = kib(d.totalKiB);
  const used = kib(d.usedKiB);
  const free = kib(d.freeKiB);
  if (total === null || used === null || free === null) return null;
  const p = rec(d.parts);
  return {
    at: str(d.at),
    totalKiB: total,
    usedKiB: used,
    freeKiB: free,
    parts: {
      mirror: kib(p.mirror),
      deps: kib(p.deps),
      checkout: kib(p.checkout),
      threads: kibMap(p.threads),
      homes: kibMap(p.homes),
      other: kib(p.other) ?? 0,
    },
  };
}

/** The live engine view, normalized: `state` is "unreachable" when the DO
 *  answered with an error instead of a view. */
export function residentLive(record: ResidentRecordView): Record<string, unknown> & { state: string; reason: string } {
  const live = rec(record.live);
  if (typeof live.error === "string") return { ...live, state: "unreachable", reason: live.error };
  return { ...live, state: str(live.state) || "unknown", reason: str(live.reason) };
}
