import { unitOfIdempotencyKey } from "../coordinator/contract.js";
import { RUN_LIVE_STATE_NAMES } from "../runLiveState.js";
import type { RunView } from "../runsService.js";
import type { HomeSnapshot, HomeUnit } from "./service.js";

export const HOME_PAGE_SIZE = 50;
export const HOME_VIEWS = ["attention", "moving", "waiting", "investigation", "pipelines"] as const;
export type HomeView = (typeof HOME_VIEWS)[number];
export interface HomeOverview {
  view: HomeView;
  page: number;
  pages: number;
  total: number;
  counts: Record<HomeView, number>;
  runs: (Pick<RunView, "id" | "label" | "agent" | "repo" | "startedAt" | "liveState" | "activity"> & {
    stateLabel: string;
    viewPath?: string;
  })[];
  pipelineUnits?: HomeUnit[];
  runsPartial?: true;
}
/** A saved wait describes an obligation. It is never proof of external liveness. */
export function recordedWait(row: HomeUnit): boolean {
  return (
    row.nextAction.kind === "recorded" &&
    row.conditions.length > 0 &&
    row.conditions.every(
      (condition) =>
        condition.state === "open" && condition.owner.kind !== "unknown" && !condition.id.endsWith(":failure"),
    )
  );
}
const unitOrder = (a: HomeUnit, b: HomeUnit) => (a.unit.unit < b.unit.unit ? -1 : a.unit.unit > b.unit.unit ? 1 : 0);

/** Page only after the complete authorized read. No age rule can retire work. */
export function homeOverview(
  source: HomeSnapshot,
  live: RunView[],
  selected: { view: HomeView; page: number },
  now: number,
): { snapshot: HomeSnapshot; overview: HomeOverview } {
  const waiting = source.waiting.filter(recordedWait).sort(unitOrder);
  const investigation = source.waiting.filter((row) => !recordedWait(row)).sort(unitOrder);
  const liveRuns = live.filter((run) => !run.finished);
  const runGroup = (run: RunView): "moving" | "waiting" | "investigation" => {
    const state = run.liveState;
    if (
      run.stop ||
      run.recoveryPending ||
      run.pausedForRetry ||
      !state ||
      !RUN_LIVE_STATE_NAMES.includes(state.state) ||
      !Number.isFinite(state.since) ||
      state.since > now ||
      !Number.isFinite(state.bound) ||
      state.bound! <= now ||
      state.bound! < state.since ||
      state.state === "ended"
    )
      return "investigation";
    return ["waiting_provider", "waiting_repository", "waiting_deploy"].includes(state.state) ? "waiting" : "moving";
  };
  const groupedRuns = {
    moving: liveRuns.filter((run) => runGroup(run) === "moving"),
    waiting: liveRuns.filter((run) => runGroup(run) === "waiting"),
    investigation: liveRuns.filter((run) => runGroup(run) === "investigation"),
  };
  for (const runs of Object.values(groupedRuns))
    runs.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Keep every permitted run visible, including additional children of one
  // unit. Omit only a repeated unit card, never another execution record.
  const representedUnits = new Set(
    groupedRuns.moving.flatMap((run) => {
      const unit = run.idempotencyKey && unitOfIdempotencyKey(run.idempotencyKey);
      return run.parentInstanceId && unit ? [`${run.parentInstanceId}:${unit}`] : [];
    }),
  );
  const movingUnits = source.moving.filter((row) => !representedUnits.has(row.unit.unit));
  const activeInstances = new Set([...source.needsYou, ...source.moving, ...waiting].map((row) => row.instance.id));
  const pipelines = source.pipelines
    .filter((row) => activeInstances.has(row.instance.id))
    .sort((a, b) => (a.instance.id < b.instance.id ? -1 : a.instance.id > b.instance.id ? 1 : 0));
  const counts = {
    attention: source.needsYou.length,
    moving: movingUnits.length + groupedRuns.moving.length,
    waiting: waiting.length + groupedRuns.waiting.length,
    investigation: investigation.length + groupedRuns.investigation.length,
    pipelines: pipelines.length,
  };
  const total = counts[selected.view];
  const pages = Math.max(1, Math.ceil(total / HOME_PAGE_SIZE));
  const page = Math.min(selected.page, pages);
  const start = (page - 1) * HOME_PAGE_SIZE;
  const take = <T>(rows: T[]) => rows.slice(start, start + HOME_PAGE_SIZE);
  const units =
    selected.view === "moving"
      ? [...movingUnits].sort(unitOrder)
      : selected.view === "waiting"
        ? waiting
        : selected.view === "investigation"
          ? investigation
          : [];
  const runs =
    selected.view === "moving" || selected.view === "waiting" || selected.view === "investigation"
      ? groupedRuns[selected.view]
      : [];
  const items = [...runs.map((run) => ({ run })), ...units.map((unit) => ({ unit }))];
  const selectedItems = take(items);
  const selectedUnits = selectedItems.flatMap((item) => ("unit" in item ? [item.unit] : []));
  const snapshot: HomeSnapshot = {
    ...source,
    needsYou: selected.view === "attention" ? take([...source.needsYou].sort(unitOrder)) : [],
    moving: selected.view === "moving" ? selectedUnits : [],
    waiting: selected.view === "waiting" || selected.view === "investigation" ? selectedUnits : [],
    pipelines: selected.view === "pipelines" ? take(pipelines) : [],
  };
  const cardIds = new Set(snapshot.pipelines.map((row) => row.instance.id));
  const cardUnits = new Map<string, HomeUnit[]>();
  for (const row of [...source.needsYou, ...source.moving, ...source.waiting]
    .filter((row) => cardIds.has(row.instance.id))
    .sort(unitOrder)) {
    const group = cardUnits.get(row.instance.id) ?? [];
    if (group.length < 3) group.push(row);
    cardUnits.set(row.instance.id, group);
  }
  return {
    snapshot,
    overview: {
      ...selected,
      page,
      pages,
      total,
      counts,
      ...(cardIds.size ? { pipelineUnits: [...cardUnits.values()].flat() } : {}),
      runs: selectedItems.flatMap((item) =>
        "run" in item
          ? [
              {
                id: item.run.id,
                label: item.run.label,
                agent: item.run.agent,
                repo: item.run.repo,
                startedAt: item.run.startedAt,
                liveState: item.run.liveState,
                stateLabel: item.run.stop
                  ? "Shutdown not confirmed"
                  : item.run.recoveryPending
                    ? "Recovery not confirmed"
                    : item.run.pausedForRetry
                      ? "Run paused"
                      : !item.run.liveState
                        ? "State not recorded"
                        : item.run.liveState.bound !== undefined && item.run.liveState.bound <= now
                          ? "Live state expired"
                          : item.run.liveState.state === "ended"
                            ? "Shutdown not confirmed"
                            : runGroup(item.run) === "investigation"
                              ? "State cannot be confirmed"
                              : item.run.liveState.state.replaceAll("_", " "),
                activity: item.run.activity,
              },
            ]
          : [],
      ),
    },
  };
}
