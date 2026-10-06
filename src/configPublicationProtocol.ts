// Shared publication grammar stays independent of host hashing and transport.
// State Workers import this leaf without requiring Node compatibility.

/** Compared atomically with the target version in the same existing document store. */
export interface ConfigSourcePrecondition {
  readonly key: string;
  readonly version: number;
}

/** Only this generated namespace is immutable; ordinary named documents retain CAS updates. */
export function isConfigPublicationSnapshotKey(key: string): boolean {
  return /^deploy-base-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key);
}
