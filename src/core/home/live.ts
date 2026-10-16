import type { Predicate } from "../authz/types.js";
import { matchesPredicate } from "../authz/predicate.js";
import type { RunRegistry } from "../runRegistry.js";
import type { RunLedger } from "../runLedger/ledger.js";
import { RUN_ID_PATTERN } from "../runRecord.js";
import { RUN_LIVE_STATE_NAMES, type RunLiveState } from "../runLiveState.js";
import { parseUnitKey } from "../coordinator/contract.js";

/** Read facts only; returned IDs carry no run token, authority or owner change. */
export async function homeLiveUnitRuns(
  source: {
    registry: Pick<RunRegistry, "listActive" | "getById">;
    ledger?: Pick<RunLedger, "listLive"> | null;
    now: () => number;
  },
  visibleTo: Predicate,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  if (visibleTo.kind === "none") return new Map();
  let at: number;
  const moving = (state: RunLiveState | undefined) => {
    if (!state) throw new Error("Current work state is unavailable.");
    if (
      !RUN_LIVE_STATE_NAMES.includes(state.state) ||
      !Number.isFinite(state.since) ||
      state.since > at ||
      (state.state !== "ended" && (!Number.isFinite(state.bound) || state.bound! < state.since))
    )
      throw new Error("Current work state is unavailable.");
    return (
      state.state !== "ended" &&
      state.bound! > at &&
      !["waiting_provider", "waiting_deploy", "waiting_repository"].includes(state.state)
    );
  };
  const runs = new Map<string, Set<string>>();
  const add = (
    runId: string,
    row: {
      userId?: string;
      channelId?: string;
      channelVisibility?: import("../authz/types.js").ChannelVisibility;
      repo?: string;
      parentInstanceId?: string;
      coordinatorUnit?: string;
      liveState?: RunLiveState;
    },
  ) => {
    if (!row.parentInstanceId || !row.coordinatorUnit || !moving(row.liveState)) return;
    const key = `${row.parentInstanceId}:${row.coordinatorUnit}`;
    if (!parseUnitKey(key)) throw new Error("Current work address is unavailable.");
    if (
      matchesPredicate(visibleTo, {
        userId: row.userId ?? "",
        channelId: row.channelId ?? "",
        repo: row.repo,
        channelVisibility: row.channelVisibility ?? "unknown",
      })
    ) {
      const ids = runs.get(key) ?? new Set<string>();
      ids.add(runId);
      runs.set(key, ids);
    }
  };
  const rows = source.ledger ? await source.ledger.listLive() : [];
  at = source.now();
  const local = source.registry.listActive();
  if (!Array.isArray(rows) || new Set(rows.map((row) => row?.runId)).size !== rows.length)
    throw new Error("Current durable work is unavailable.");
  for (const row of rows) {
    if (
      !row ||
      typeof row.runId !== "string" ||
      !RUN_ID_PATTERN.test(row.runId) ||
      !row.meta ||
      [row.meta.userId, row.meta.channelId, row.meta.threadKey].some((field) => typeof field !== "string") ||
      !["live", "attaching", "handoff", "finishing"].includes(row.phase) ||
      !Number.isFinite(row.startedAt) ||
      !Number.isFinite(row.leaseUntil) ||
      !row.state ||
      typeof row.state !== "object" ||
      Array.isArray(row.state) ||
      ![null, "soft", "hard"].includes(row.stop) ||
      (row.state.pausedForRetry !== undefined && typeof row.state.pausedForRetry !== "boolean") ||
      (row.meta.parentInstanceId !== undefined && typeof row.meta.parentInstanceId !== "string") ||
      (row.meta.coordinatorUnit !== undefined && typeof row.meta.coordinatorUnit !== "string")
    )
      throw new Error("Current durable work is unavailable.");
    // Presence, including a known local finish, wins over its older durable copy.
    if (source.registry.getById(row.runId)) continue;
    if (row.phase !== "live" || row.leaseUntil <= at || row.stop !== null || row.state.pausedForRetry === true)
      continue;
    add(row.runId, { ...row.meta, liveState: row.liveState });
  }
  for (const row of local) if (!row.finished && !row.stop) add(row.id, row);
  return runs;
}
