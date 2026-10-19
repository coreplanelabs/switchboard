import { MaintenanceService, type MaintenanceStore } from "../core/maintenance.js";

interface ResetCycle {
  episodeId: string;
  apply(action: () => void): void;
}

/** A failed preview can release its own hold; an attempted reset needs reconciliation. */
export async function withStagingResetMaintenance<T>(
  store: MaintenanceStore,
  actor: string,
  run: (cycle: ResetCycle) => Promise<T>,
): Promise<T> {
  const maintenance = new MaintenanceService({ store });
  const hold = await maintenance.start(
    { scopes: ["all"], reason: "Isolated staging reset validation", channel: "staging-reset-fixture" },
    actor,
  );
  if (!hold.episode || hold.episode.phase !== "active")
    throw new Error("staging reset maintenance did not close access");
  const episodeId = hold.episode.id;
  const owned = new MaintenanceService({
    store: {
      async read() {
        const current = await store.read();
        if (current.episode?.id !== episodeId || current.episode.actor !== actor)
          throw new Error("staging reset maintenance owner changed; retain the current hold");
        return current;
      },
      write: (version, document) => store.write(version, document),
    },
  });
  let applyAttempted = false;
  let result: T;
  try {
    result = await run({
      episodeId,
      apply: (action) => {
        applyAttempted = true;
        action();
      },
    });
  } catch (error) {
    if (!applyAttempted) {
      try {
        await owned.end(episodeId, actor);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Reset preflight failed and maintenance release is unverified",
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
  await owned.end(episodeId, actor);
  return result;
}
