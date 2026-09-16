// The residents view model shared by the bot server (residentsView.ts routes
// the /residents pages and looks records up by slug) and the web app (which
// renders them). Node-free and dependency-free: the web bundle imports it.

import {
  diskReserveKiB,
  effectiveFreeKiB,
  projectThreadCostKiB,
  type DiskReserve,
  type DiskSample,
} from "../execution/residentDiskBudget.js";
import type { ResidentsFeedFrame, RunIndexRowSeed } from "./webSeed.js";

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

/** The fleet's one-word health — what the residents index tab's favicon dot
 *  says. Worst-of, in severity order: any red resident → red; else any amber →
 *  amber; else green only when every resident is warm; anything else — no
 *  residents, or an unknown/unreachable one with nothing worse to show — is
 *  grey ("no claim"), never green: a fleet is only "all up" when all of it is. */
export function residentsFleetTone(records: readonly ResidentRecordView[]): ResidentTone {
  if (records.length === 0) return "grey";
  const tones = new Set(records.map((record) => residentStateTone(residentLive(rec(record)).state)));
  if (tones.has("red")) return "red";
  if (tones.has("amber")) return "amber";
  return tones.size === 1 && tones.has("green") ? "green" : "grey";
}

export const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
export const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

export function residentSlug(record: ResidentRecordView): string {
  return str(record.resource).replace(/^repo:/, "");
}

/** The live view's `disk` (docs/reference/specs/resident-repos.md item 55): the resident's
 *  last `df` + `du` sample, or null when it has not measured yet (a fresh
 *  container before its first cycle) or the field is malformed. The shape is
 *  the resident's `DiskSample` (KiB; a `parts` value may be null = unmeasured,
 *  rendered "?"), validated field by field — the view displays, never trusts. */
export type ResidentDiskView = DiskSample;

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

// ---- thread worktrees and the runs on them ----------------------------------

/** One thread's worktree binding as the resident reports it in `live.threads`
 *  (resident-repos item 42), every field normalized: strings empty when
 *  absent, `evicted` a boolean. An evicted binding is the audit row of a tree
 *  that is gone — its user is released and its bytes are back. */
export interface ResidentThreadView {
  threadKey: string;
  ref: string;
  sha: string;
  user: string;
  deps: string;
  boundAt: string;
  lastAttachAt: string;
  evicted: boolean;
  evictedAt: string;
  evictedWhy: string;
}

/** The record's thread bindings, newest attach first; an entry that is not a
 *  record is dropped, an unreachable engine has none. */
export function residentThreads(record: ResidentRecordView): ResidentThreadView[] {
  const raw = residentLive(record).threads;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
    .map((t) => ({
      threadKey: str(t.threadKey),
      ref: str(t.ref),
      sha: str(t.sha),
      user: str(t.user),
      deps: str(t.deps),
      boundAt: str(t.boundAt),
      lastAttachAt: str(t.lastAttachAt),
      evicted: t.evicted === true,
      evictedAt: str(t.evictedAt),
      evictedWhy: str(t.evictedWhy),
    }))
    .sort((a, b) => b.lastAttachAt.localeCompare(a.lastAttachAt));
}

/** The registry rows that are running on the resident with this slug: a run
 *  names the repo it was dispatched for (`RunMeta.repo`), and only a live run
 *  holds a tree. Oldest started first — the order they took their trees in. */
export function runsOnResident<T extends { repo?: string; finished: boolean; startedAt: number }>(
  runs: Iterable<T>,
  slug: string,
): T[] {
  return [...runs].filter((r) => !r.finished && r.repo === slug).sort((a, b) => a.startedAt - b.startedAt);
}

/** The live binding a run's thread holds on the resident, or undefined: before
 *  the attach completes, after the release, or when the run fell to another
 *  backend. The join key is the thread key both sides stamp (AGENTS.md
 *  invariant 4): the run's `RunMeta.threadKey`, the binding's `threadKey`. */
export function bindingFor(
  threads: readonly ResidentThreadView[],
  threadKey: string | undefined,
): ResidentThreadView | undefined {
  if (!threadKey) return undefined;
  return threads.find((t) => !t.evicted && t.threadKey === threadKey);
}

/** The bytes one thread's tree holds beyond what it shares with the checkout,
 *  from the last disk sample (item 55); null when the resident has not
 *  measured, or the sample predates this tree. */
export function threadTreeKiB(disk: ResidentDiskView | null, threadKey: string): number | null {
  if (!disk) return null;
  return Object.hasOwn(disk.parts.threads, threadKey) ? disk.parts.threads[threadKey]! : null;
}

// ---- disk headroom -----------------------------------------------------------

/** The budget arithmetic over the last sample — the same pure functions the
 *  resident's attach admission runs (item 55), so a page shows the numbers the
 *  next admission decides on. `room` is how many more trees of each kind fit
 *  in the headroom; null when the checkout has not been measured (no cost to
 *  project from). */
export interface DiskHeadroom {
  freeKiB: number;
  capped: boolean;
  capacityKiB: number;
  reserve: DiskReserve;
  headroomKiB: number;
  room: { hardlink: number | null; reconcile: number | null };
}

export function diskHeadroom(disk: ResidentDiskView, diskBudgetMb: number | undefined): DiskHeadroom {
  const reserve = diskReserveKiB(disk);
  const { freeKiB, capped, capacityKiB } = effectiveFreeKiB(disk, diskBudgetMb);
  const headroomKiB = Math.max(0, freeKiB - reserve.totalKiB);
  const room = (kind: "hardlink" | "reconcile"): number | null => {
    const cost = projectThreadCostKiB(disk.parts, kind);
    return cost === null || cost === 0 ? null : Math.floor(headroomKiB / cost);
  };
  return {
    freeKiB,
    capped,
    capacityKiB,
    reserve,
    headroomKiB,
    room: { hardlink: room("hardlink"), reconcile: room("reconcile") },
  };
}

// ---- the index page's state and its feed ------------------------------------

/** What the residents index holds between frames: the listing as last read
 *  (the seed's, then each `residents` frame's) and the live repo runs by id. */
export interface ResidentsIndexState {
  cap: unknown;
  count: unknown;
  residents: unknown[];
  runs: Map<string, RunIndexRowSeed>;
}

/** Apply one feed frame in place. A live `upsert` sets its row; a finished one
 *  removes it — the fold lists what is running, and the run's tree is released
 *  at its end (item 17) — as does `removed`. A `residents` frame replaces the
 *  listing whole (cap, count, records) and leaves the runs alone: they are the
 *  registry's, not the resident Worker's. Anything else is ignored. */
export function applyResidentsFrame(state: ResidentsIndexState, frame: ResidentsFeedFrame): void {
  if (!frame || typeof frame !== "object") return;
  if (frame.type === "upsert") {
    const run = frame.run;
    if (!run || typeof run.id !== "string") return;
    if (run.finished) state.runs.delete(run.id);
    else state.runs.set(run.id, run);
  } else if (frame.type === "removed") {
    if (typeof frame.id === "string") state.runs.delete(frame.id);
  } else if (frame.type === "residents") {
    state.cap = frame.cap;
    state.count = frame.count;
    state.residents = Array.isArray(frame.residents) ? frame.residents : [];
  }
}
