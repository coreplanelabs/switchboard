import { REPOSITORY_KEY_PREFIX, repositoryKey, type RepositoryRegistration } from "./repoRegistration.js";

export interface SettingsKv {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<unknown>;
}
interface TransactionalSettings extends SettingsKv {
  transaction<T>(action: (store: SettingsKv) => Promise<T>): Promise<T>;
}
const lockKey = "installation-reset:settings";
interface ResetLock {
  operation: string;
  phase: "frozen" | "restored";
}

export async function assertRepositorySettingsWritable(
  store: Pick<SettingsKv, "get">,
  mutation:
    | "onboard"
    | "replace"
    | "requestWarmReplicas"
    | "importPrimaryPlacements"
    | "updateConfig"
    | "remove"
    | "beginPoolOffboard"
    | "finishPoolOffboard"
    | "recordPoolRemoval",
) {
  const lock = await store.get<ResetLock>(lockKey);
  if (lock?.phase === "frozen") {
    try {
      console.log(JSON.stringify({ event: "repository.settings.frozen_refused", operation: lock.operation, mutation }));
    } catch {
      // Keep the known refusal if the telemetry sink is unavailable.
    }
    throw new Error("repository settings are frozen for reset");
  }
}

/** Transfer registrations only; admissions, placements and native outcomes are history. */
export async function resetRepositorySettings<T extends RepositoryRegistration>(
  storage: TransactionalSettings,
  action: "preview" | "freeze" | "restore",
  operation: string | undefined,
  records: T[] | undefined,
  validate: (record: T) => void,
): Promise<{ schema: 1; records: T[] }> {
  if (action !== "preview" && (!operation || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operation)))
    throw new Error("reset operation is invalid");
  return storage.transaction(async (txn) => {
    const current = await txn.get<ResetLock>(lockKey);
    if (action === "freeze") {
      if (current?.phase === "frozen" && current.operation !== operation)
        throw new Error("another reset owns repository settings");
      if (current?.phase === "restored" && current.operation === operation)
        throw new Error("reset operation already completed");
      await txn.put(lockKey, { operation, phase: "frozen" });
    }
    if (action === "restore") {
      if (current || (await txn.list()).size || !Array.isArray(records))
        throw new Error("repository reset target is not empty");
      const seen = new Set<string>();
      for (const record of records) {
        validate(record);
        if (seen.has(record.resource) || record.offboarding) throw new Error("repository reset settings are invalid");
        seen.add(record.resource);
      }
      for (const record of records) await txn.put(repositoryKey(record.resource), record);
      await txn.put(lockKey, { operation, phase: "restored" });
    }
    const entries = [...(await txn.list<T>({ prefix: REPOSITORY_KEY_PREFIX })).values()].sort((a, b) =>
      a.resource.localeCompare(b.resource),
    );
    for (const record of entries) validate(record);
    return { schema: 1, records: entries };
  });
}
