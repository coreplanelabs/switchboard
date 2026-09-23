import type { ProviderFailureCause } from "./provider.js";
import type { RunLedger } from "./runLedger/ledger.js";
import type { LedgerWriteThrough } from "./runLedger/writeThrough.js";
import type { RunRegistry } from "./runRegistry.js";

export interface ProviderLiveStateCoordinatorDeps {
  runLedger: Pick<LedgerWriteThrough, "liveRuns" | "planeLevel" | "planePark">;
  ledger: Pick<RunLedger, "listLive"> | null;
  registry: Pick<RunRegistry, "commitLiveState" | "getById" | "snapshotById">;
  clock: () => number;
  warn: (message: string) => void;
}

export interface ProviderLiveStateCoordinator {
  level(provider: string, side: "up" | "down", cause?: ProviderFailureCause): Promise<void>;
  park(runId: string, provider: string): Promise<void>;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Sequence provider park and level reports through one lane. A successful retry
 * cannot inspect a run between its durable park and its waiting projection,
 * then leave that stale waiting projection behind.
 */
export function createProviderLiveStateCoordinator(
  deps: ProviderLiveStateCoordinatorDeps,
): ProviderLiveStateCoordinator {
  let tail = Promise.resolve();
  const enqueue = (label: string, work: () => Promise<void>): Promise<void> => {
    const next = tail.then(work).catch((error: unknown) => {
      deps.warn(`${label} failed: ${describe(error)}`);
    });
    tail = next;
    return next;
  };

  return {
    level: (provider, side, cause) =>
      enqueue(`provider ${side} report for ${provider}`, async () => {
        await deps.runLedger.planeLevel({
          provider,
          name: "provider",
          side,
          ...(side === "down" && cause !== undefined ? { cause } : {}),
        });
        if (side !== "up" || !deps.ledger) return;
        const rows = await deps.ledger.listLive();
        for (const row of rows) {
          if (row.state.liveProvider !== provider || row.liveState?.state !== "waiting_provider") continue;
          const tracked = deps.runLedger.liveRuns().find((run) => run.runId === row.runId);
          const summary = deps.registry.getById(row.runId);
          if (!tracked || !summary || row.liveState.bound === undefined) continue;
          const committed = await tracked.assignLiveState({
            expectedSeq: summary.liveStateSeq ?? 0,
            eventSeq: summary.eventCount + 1,
            at: deps.clock(),
            state: "working",
            bound: row.liveState.bound,
            detail: "model turn",
            statePatch: { liveProvider: undefined },
          });
          if (committed.ok) deps.registry.commitLiveState(row.runId, committed);
        }
      }),
    park: (runId, provider) =>
      enqueue(`provider park for ${runId}`, async () => {
        await deps.runLedger.planePark(runId, provider);
        const summary = deps.registry.getById(runId);
        const tracked = deps.runLedger.liveRuns().find((run) => run.runId === runId);
        const events = deps.registry.snapshotById(runId)?.events ?? [];
        let leaseEndsAt: number | undefined;
        for (const event of events) if (event.type === "lease") leaseEndsAt = event.endsAt;
        if (!summary || !tracked || leaseEndsAt === undefined) return;
        const committed = await tracked.assignLiveState({
          expectedSeq: summary.liveStateSeq ?? 0,
          eventSeq: summary.eventCount + 1,
          at: deps.clock(),
          state: "waiting_provider",
          bound: leaseEndsAt,
          detail: "waiting for the model provider",
          statePatch: { liveProvider: provider },
        });
        if (committed.ok) deps.registry.commitLiveState(runId, committed);
      }),
  };
}
