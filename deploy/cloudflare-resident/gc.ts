// Residency garbage collection (#50) — the PURE decision logic, kept free of
// the Sandbox SDK and DO storage so it runs under plain-Node vitest
// (gc.test.ts). worker.ts feeds it what it observed (mirror refs, the GitHub
// pulls list, tree cleanliness, live views) and acts on the answers.
//
// Two mechanisms:
//   1. Event-triggered reclamation: after every refresh-cycle `fetch --prune`,
//      each live thread binding's ref is classified — branch gone from the
//      mirror, or its PR merged/closed on GitHub — and a finished ref's
//      worktree is evicted right away instead of waiting out the idle TTL.
//      This is a POLL folded into the existing alarm, not a webhook: the
//      GitHub App is configured with webhooks OFF (events: [], no hook
//      config), and the fetch that already runs every cycle carries the
//      "branch deleted" signal for free.
//   2. Resident-level LRU eviction: an over-cap onboard with
//      `evictColdest:true` (admin opt-in, default off) offboards the coldest
//      eligible warm resident to make room instead of answering 429.

// ---------------------------------------------------------------------------
// 1. Reclamation
// ---------------------------------------------------------------------------

/** What GitHub says about a head branch's pull requests. */
export interface PullSummary {
  number: number;
  state: "open" | "closed";
  merged: boolean;
}

/** The fate of a thread's bound ref, as far as one refresh cycle can tell. */
export type RefFate =
  | "gone" // the branch no longer exists in the mirror after `fetch --prune`
  | "merged" // no open PR; the latest PR for the head was merged
  | "closed" // no open PR; PRs exist but none merged
  | "open" // a PR is still open — work in progress
  | "no-pr" // branch exists, no PR ever opened for it
  | "unknown"; // GitHub could not be asked (unreachable / non-200 / unparsable)

/** Defensive parse of `GET /repos/{o}/{r}/pulls?head=…&state=all`: a non-array
 *  is null (an error object must never read as "no PRs"), malformed elements
 *  are dropped rather than guessed at. */
export function parsePullsBody(body: unknown): PullSummary[] | null {
  if (!Array.isArray(body)) return null;
  const out: PullSummary[] = [];
  for (const el of body) {
    if (!el || typeof el !== "object") continue;
    const { number, state, merged_at } = el as Record<string, unknown>;
    if (typeof number !== "number" || (state !== "open" && state !== "closed")) continue;
    out.push({ number, state, merged: typeof merged_at === "string" && merged_at.length > 0 });
  }
  return out;
}

/** Collapse a head's PR list into one fate. An open PR always wins (the
 *  branch is still in play); otherwise merged beats closed. */
export function pullsFate(pulls: readonly PullSummary[]): Extract<RefFate, "merged" | "closed" | "open" | "no-pr"> {
  if (pulls.length === 0) return "no-pr";
  if (pulls.some((p) => p.state === "open")) return "open";
  if (pulls.some((p) => p.merged)) return "merged";
  return "closed";
}

export interface ReclaimInput {
  fate: RefFate;
  /** The resident's default branch is never a finished ref. */
  isDefaultRef: boolean;
  /** Thread exec/read/write currently running on this binding. */
  busy: number;
  /** Tree cleanliness as the thread user; `null` = the runtime is down, so
   *  the tree is already gone with the disk and there is nothing to preserve. */
  clean: boolean | null;
}

/** The PR that decided the fate (for the audit trail): the open one, else the
 *  merged one, else the newest closed one; null when there is none. */
export function decisivePull(pulls: readonly PullSummary[]): PullSummary | null {
  return pulls.find((p) => p.state === "open") ?? pulls.find((p) => p.merged) ?? pulls[0] ?? null;
}

export type ReclaimWhy = "default-ref" | "pr-open" | "no-pr" | "fate-unknown" | "busy" | "re-attached" | "dirty" | Extract<RefFate, "gone" | "merged" | "closed">;

/** Evict this binding now? A finished ref (gone/merged/closed) is reclaimed
 *  only when nothing runs on it and its tree is provably clean — a merged PR
 *  can still have unpushed local commits, and destroying work on a signal is
 *  exactly what this must never do. Keeps are named so the pass is auditable. */
export function reclaimDecision(input: ReclaimInput): { reclaim: boolean; why: ReclaimWhy } {
  if (input.isDefaultRef) return { reclaim: false, why: "default-ref" };
  switch (input.fate) {
    case "open":
      return { reclaim: false, why: "pr-open" };
    case "no-pr":
      return { reclaim: false, why: "no-pr" };
    case "unknown":
      return { reclaim: false, why: "fate-unknown" };
  }
  if (input.busy > 0) return { reclaim: false, why: "busy" };
  if (input.clean === false) return { reclaim: false, why: "dirty" };
  return { reclaim: true, why: input.fate };
}

// ---------------------------------------------------------------------------
// 2. LRU eviction
// ---------------------------------------------------------------------------

/** One resident as the LRU picker sees it: registry record + live view.
 *  `state: "unknown"` / `inFlight: null` model a live view that failed. */
export interface ResidentView {
  resource: string;
  state: string;
  inFlight: number | null;
  onboardedAt: string;
  provisionedAt: string | null;
  threads: ReadonlyArray<{ lastAttachAt: string; evicted: boolean; user: string }>;
}

export interface EvictionPick {
  candidate: { resource: string; lastActivityAt: string } | null;
  rejected: Array<{ resource: string; why: string }>;
}

/** The newest thing that happened on the resident: an attach (evicted
 *  bindings count — the run happened) or, never attached, provisioning. */
export function lastActivityAt(view: ResidentView): string {
  let latest = view.provisionedAt ?? view.onboardedAt;
  for (const t of view.threads) if (t.lastAttachAt > latest) latest = t.lastAttachAt;
  return latest;
}

/** Choose the coldest resident that is safe to offboard: `warm`, nothing in
 *  flight, no LIVE worktree (a live tree may hold uncommitted work), and its
 *  last activity older than `floorMs` (so a repo used minutes ago is never
 *  evicted to make room). Coldest = oldest last activity; ties on name. */
export function pickEvictionCandidate(views: readonly ResidentView[], nowMs: number, floorMs: number): EvictionPick {
  const rejected: EvictionPick["rejected"] = [];
  const eligible: Array<{ resource: string; lastActivityAt: string }> = [];
  for (const v of views) {
    if (v.state !== "warm") {
      rejected.push({ resource: v.resource, why: `state ${v.state}` });
      continue;
    }
    if (v.inFlight === null) {
      rejected.push({ resource: v.resource, why: "in-flight count unknown" });
      continue;
    }
    if (v.inFlight > 0) {
      rejected.push({ resource: v.resource, why: `${v.inFlight} operation(s) in flight` });
      continue;
    }
    const live = v.threads.filter((t) => !t.evicted && t.user).length;
    if (live > 0) {
      rejected.push({ resource: v.resource, why: `${live} live worktree(s)` });
      continue;
    }
    const last = lastActivityAt(v);
    const idleMs = nowMs - Date.parse(last);
    if (!(idleMs >= floorMs)) {
      rejected.push({ resource: v.resource, why: `active ${Math.round(idleMs / 60_000)}m ago (floor ${Math.round(floorMs / 60_000)}m)` });
      continue;
    }
    eligible.push({ resource: v.resource, lastActivityAt: last });
  }
  eligible.sort((a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt) || a.resource.localeCompare(b.resource));
  return { candidate: eligible[0] ?? null, rejected };
}
