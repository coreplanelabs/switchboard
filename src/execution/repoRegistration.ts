/** Registration is durable metadata. Only entries with a resident spend fleet capacity. */
export interface RepositoryRegistration {
  resource: string;
  noResident?: boolean;
}

export const REPOSITORY_KEY_PREFIX = "resident:";
export const repositoryKey = (resource: string): string => `${REPOSITORY_KEY_PREFIX}${resource}`;

export interface RepositoryStorage<T extends RepositoryRegistration> {
  get(key: string): Promise<T | undefined>;
  list(options: { prefix: string }): Promise<Map<string, T>>;
  put(key: string, record: T): Promise<unknown>;
}

export function residentRecords<T extends RepositoryRegistration>(records: T[]): T[] {
  return records.filter((record) => record.noResident !== true);
}

/** The caller holds its storage input gate throughout this read/check/write. */
export async function registerRepository<T extends RepositoryRegistration>(
  storage: RepositoryStorage<T>,
  record: T,
  cap: number,
): Promise<{ ok: true; record: T } | { ok: false; status: number; error: string }> {
  const key = repositoryKey(record.resource);
  if (await storage.get(key)) return { ok: false, status: 409, error: `${record.resource} is already onboarded` };
  if (record.noResident !== true) {
    const existing = residentRecords([...(await storage.list({ prefix: REPOSITORY_KEY_PREFIX })).values()]);
    if (existing.length >= cap)
      return {
        ok: false,
        status: 429,
        error: `resident cap reached (${existing.length}/${cap}); offboard a resident first, or onboard with evictColdest:true to make room`,
      };
  }
  await storage.put(key, record);
  return { ok: true, record };
}
