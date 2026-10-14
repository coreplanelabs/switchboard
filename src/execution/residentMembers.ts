import type { RepositoryRegistration } from "./repoRegistration.js";

/** Member addresses are never reused or removed by a desired-count change.
 * Pending members reserve fleet capacity but cannot receive work until the
 * existing maintenance barrier has imported primary placements. */
export interface ResidentPool {
  version: 1;
  revision: string;
  desired: number;
  active: number;
  members: string[];
  removed?: Record<string, { backupObjectsDeleted: number; r2ObjectsDeleted: number }>;
}

type PoolRepository = RepositoryRegistration & { pool?: ResidentPool };
export type ResidentMember<T extends PoolRepository = PoolRepository> = T & {
  residentId?: string;
  replicaOrdinal?: number;
  keepWarm?: boolean;
};

export function residentAddress(record: { resource: string; residentId?: string }): string {
  return record.residentId ?? record.resource;
}

export function selectedResidentMember(record: PoolRepository, number?: number): string | undefined {
  const pool = residentPoolOf(record);
  const members = pool?.members.slice(0, pool.active) ?? [record.resource];
  if (number === undefined) return members.length === 1 ? members[0] : undefined;
  return Number.isSafeInteger(number) && number >= 1 ? members[number - 1] : undefined;
}

export function residentPoolOf(record: PoolRepository): ResidentPool | undefined {
  const pool = record.pool;
  if (pool === undefined) return undefined;
  if (
    record.noResident === true ||
    !pool ||
    pool.version !== 1 ||
    typeof pool.revision !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(pool.revision) ||
    !Array.isArray(pool.members) ||
    pool.members.length < 1 ||
    pool.members[0] !== record.resource ||
    pool.members.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_:/.-]{0,62}$/.test(id)) ||
    new Set(pool.members).size !== pool.members.length ||
    !Number.isSafeInteger(pool.active) ||
    pool.active < 1 ||
    pool.active > pool.members.length ||
    !Number.isSafeInteger(pool.desired) ||
    pool.desired < 1 ||
    pool.desired > pool.members.length
  )
    throw new Error("resident pool metadata could not be verified");
  if (
    pool.removed !== undefined &&
    (!pool.removed ||
      typeof pool.removed !== "object" ||
      Array.isArray(pool.removed) ||
      Object.entries(pool.removed).some(
        ([id, receipt]) =>
          !pool.members.slice(0, pool.active).includes(id) ||
          !receipt ||
          !Number.isSafeInteger(receipt.backupObjectsDeleted) ||
          receipt.backupObjectsDeleted < 0 ||
          !Number.isSafeInteger(receipt.r2ObjectsDeleted) ||
          receipt.r2ObjectsDeleted < 0,
      ))
  )
    throw new Error("resident pool cleanup could not be verified");
  return pool;
}

/** Old records retain their old response shape and primary address. */
export function residentMembers<T extends PoolRepository>(records: readonly T[]): ResidentMember<T>[] {
  return records.flatMap((record) => {
    const pool = residentPoolOf(record);
    if (record.noResident === true) return [];
    if (!pool) return [record];
    return pool.members.slice(0, pool.active).map((residentId, replicaOrdinal) => ({
      ...record,
      residentId,
      replicaOrdinal,
      keepWarm: replicaOrdinal < pool.desired,
    }));
  });
}

export function reservedResidentCount(records: readonly PoolRepository[]): number {
  return records.reduce((count, record) => {
    const pool = residentPoolOf(record);
    return count + (record.noResident === true ? 0 : (pool?.members.length ?? 1));
  }, 0);
}

/** Apply already-generated addresses inside the registry's transaction. */
export function planResidentPool(
  record: PoolRepository,
  desired: number,
  addresses: readonly string[],
  revision: string,
): ResidentPool {
  if (record.noResident || !Number.isSafeInteger(desired) || desired < 1)
    throw new Error("warm resident count requires a resident-enabled repository and a positive integer");
  const prior = residentPoolOf(record);
  const members = [...(prior?.members ?? [record.resource])];
  const needed = Math.max(0, desired - members.length);
  if (addresses.length < needed) throw new Error("resident addresses are incomplete");
  members.push(...addresses.slice(0, needed));
  const pool: ResidentPool = { version: 1, revision, desired, active: prior?.active ?? 1, members };
  return residentPoolOf({ ...record, pool })!;
}

/** Round robin spreads only new placements; saved placements never call this.
 * The caller supplies serving members, and the registry rechecks eligibility. */
export function nextResidentMember(
  record: PoolRepository,
  serving: readonly string[],
  cursor: number,
): string | undefined {
  const pool = residentPoolOf(record);
  const members = pool ? pool.members.slice(0, Math.min(pool.active, pool.desired)) : [record.resource];
  const candidates = members.filter((id) => serving.includes(id));
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("resident placement cursor is invalid");
  return candidates.length ? candidates[cursor % candidates.length] : undefined;
}
