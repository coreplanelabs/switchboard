export interface DrainReceiptRecord {
  id: string;
  status: string;
  finishedAt?: number;
  events: readonly Record<string, unknown>[];
}

export interface DrainReceiptSummary {
  runs: number;
  waits: number;
  waitDurationMs: number;
  seeded: number;
  fresh: number;
}

/**
 * Fold only complete typed receipts. `load:drain` is an acceptance gate, not
 * an approximation: an unfinished row or a prose-only legacy note refuses the
 * whole report so a rollout cannot be called safe from partial evidence.
 */
export function drainReceiptSummary(records: readonly DrainReceiptRecord[]): DrainReceiptSummary {
  const summary: DrainReceiptSummary = { runs: records.length, waits: 0, waitDurationMs: 0, seeded: 0, fresh: 0 };
  for (const record of records) {
    if (record.status === "running" || record.status === "queued" || record.status === "restarting")
      throw new Error(`run ${record.id} is incomplete (${record.status})`);
    if (typeof record.finishedAt !== "number" || !Number.isFinite(record.finishedAt))
      throw new Error(`run ${record.id} has no finished receipt`);
    for (const event of record.events) {
      if (event.type !== "run_note") continue;
      if (event.kind === "drain_wait") {
        if (typeof event.durationMs !== "number" || !Number.isFinite(event.durationMs) || event.durationMs < 0)
          throw new Error(`run ${record.id} has a legacy or incomplete drain_wait receipt`);
        summary.waits++;
        summary.waitDurationMs += event.durationMs;
      }
      if (event.kind === "cold_sandbox") {
        if (event.sandboxOutcome !== "seeded" && event.sandboxOutcome !== "fresh")
          throw new Error(`run ${record.id} has a legacy or incomplete cold_sandbox receipt`);
        summary[event.sandboxOutcome]++;
      }
    }
  }
  return summary;
}
