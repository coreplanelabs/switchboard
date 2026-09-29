import type { DateRange } from "./costs.js";
import type { RunUsage, ShipRunUsage } from "./runUsage.js";

/** Ship child costs within one snapshot, grouped by their durable unit key. */
export interface ShipSpendReport {
  range: DateRange;
  units: Array<{
    key: string;
    /** The admitted unit cap; null on older runs or inconsistent records. */
    capUsd: number | null;
    /** Unknown after any child with unpriced usage. */
    totalUsd: number | null;
    runs: Array<{ id: string; finishedAt: number; usd: number | null; cumulativeUsd: number | null }>;
  }>;
}

/** The cap gate sums recorded per-model dollars; missing dollars stay unknown, while no model turns cost zero. */
function recordedUsd(usage: RunUsage | undefined): number | null {
  const models = Object.values(usage?.byModel ?? {});
  if (!usage || !Number.isSafeInteger(usage.turns) || usage.turns < 0) return null;
  if (usage.turns === 0 && models.length === 0) return 0;
  if (
    models.length === 0 ||
    models.reduce((sum, model) => sum + model.turns, 0) !== usage.turns ||
    models.some((model) => typeof model.usd !== "number" || !Number.isFinite(model.usd) || model.usd < 0)
  )
    return null;
  return models.reduce((sum, model) => sum + model.usd!, 0);
}

export function buildShipSpendReport(runs: readonly ShipRunUsage[], range: DateRange): ShipSpendReport {
  const groups = new Map<string, ShipRunUsage[]>();
  for (const run of runs) {
    const day = new Date(run.finishedAt).toISOString().slice(0, 10);
    if (day < range.from || day > range.to) continue;
    groups.set(run.unitKey, [...(groups.get(run.unitKey) ?? []), run]);
  }
  const units = [...groups].map(([key, children]) => {
    const ordered = children.sort((a, b) => a.finishedAt - b.finishedAt || a.id.localeCompare(b.id));
    const caps = new Set(ordered.map((r) => r.costCapUsd));
    const capUsd = caps.size === 1 ? (ordered[0]?.costCapUsd ?? null) : null;
    let cumulative: number | null = 0;
    const points = ordered.map((r) => {
      const usd = recordedUsd(r.usage);
      cumulative = cumulative === null || usd === null ? null : cumulative + usd;
      return { id: r.id, finishedAt: r.finishedAt, usd, cumulativeUsd: cumulative };
    });
    return { key, capUsd, totalUsd: cumulative, runs: points };
  });
  units.sort((a, b) => (b.runs.at(-1)?.finishedAt ?? 0) - (a.runs.at(-1)?.finishedAt ?? 0));
  return { range, units };
}
