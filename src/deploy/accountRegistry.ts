// The account registry's facts every deploy module shares — a leaf, so the
// images planner (src/deploy/images.ts) and the registry transfer
// (src/deploy/registryTransfer.ts) can both name the registry and its listing
// without importing each other.

/** Cloudflare's managed registry — the one Containers pull from cached and pre-fetched. */
export const ACCOUNT_REGISTRY = "registry.cloudflare.com";

/** One repository in the account registry: its name without the account prefix, and its tags. */
export interface RegistryImage {
  name: string;
  tags: string[];
}

/** Pure: does the account registry hold `<name>:<version>`? */
export function registryHas(listing: readonly RegistryImage[], name: string, version: string): boolean {
  return listing.some((r) => r.name === name && r.tags.includes(version));
}
