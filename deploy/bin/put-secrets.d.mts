// Types for put-secrets.mjs (plain-Node ESM so `npm run secrets` needs no build step).
export type SecretDef = { name: string; workers: string[]; optional?: boolean; note?: string };
export type Manifest = { secrets: SecretDef[] };
export type Plan = { puts: string[]; skippedOptional: string[]; missing: string[] };
export const WORKERS: Readonly<Record<"bot" | "resident" | "memory" | "sandbox", string>>;
export const SECRETS_DIR: string;
export function loadManifest(path: string): Manifest;
export function planSecretPuts(manifest: Manifest, worker: string, hasFile: (name: string) => boolean, only?: string[]): Plan;
