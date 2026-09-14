// The `artifacts:` config section (docs/reference/specs/execution.md item 20).
// Absent, the store is off and every surface behaves as before it existed.

export interface ArtifactsR2Config {
  /** The Cloudflare account id: the S3 endpoint is `<accountId>.r2.cloudflarestorage.com`. */
  accountId: string;
  /** The bucket every artifact lives in; the bot's Worker binds the same name. */
  bucket: string;
}

export interface ArtifactsInboundConfig {
  /** The most staged bytes one message may carry (default 2 GiB). */
  maxBytesPerMessage?: number;
  /** How long the bot waits on its Worker's copy of one inbound file (default 20 minutes). */
  copyTimeoutMs?: number;
}

export interface ArtifactsConfig {
  r2: ArtifactsR2Config;
  /** How long an object lives in the bucket; the lifecycle rule `artifacts lifecycle` applies (default 30). */
  retentionDays?: number;
  inbound?: ArtifactsInboundConfig;
}

export const ARTIFACT_DEFAULTS = {
  retentionDays: 30,
  maxBytesPerMessage: 2 * 1024 * 1024 * 1024,
  copyTimeoutMs: 20 * 60_000,
  /** Both presigned URL kinds admit a request for this long. */
  presignTtlSeconds: 600,
} as const;

const ARTIFACTS_KEYS: Record<keyof ArtifactsConfig, true> = { r2: true, retentionDays: true, inbound: true };
const R2_KEYS: Record<keyof ArtifactsR2Config, true> = { accountId: true, bucket: true };
const INBOUND_KEYS: Record<keyof ArtifactsInboundConfig, true> = { maxBytesPerMessage: true, copyTimeoutMs: true };

function unknownKeys(obj: object, known: Record<string, true>): string[] {
  return Object.keys(obj).filter((k) => !(k in known));
}

function positiveInteger(v: unknown, path: string): void {
  if (v !== undefined && (!Number.isInteger(v) || (v as number) < 1))
    throw new Error(`config.yaml: ${path} must be an integer >= 1`);
}

/** Refuses a typo by name at load rather than reading it as a working setting;
 *  the bucket and account are required because a store without them cannot
 *  sign a single URL. */
export function validateArtifacts(a: ArtifactsConfig): void {
  if (typeof a !== "object" || a === null) throw new Error("config.yaml: artifacts must be a mapping");
  for (const key of unknownKeys(a, ARTIFACTS_KEYS)) throw new Error(`config.yaml: artifacts.${key} is not a known key`);
  if (typeof a.r2 !== "object" || a.r2 === null) throw new Error("config.yaml: artifacts.r2 must be a mapping");
  for (const key of unknownKeys(a.r2, R2_KEYS)) throw new Error(`config.yaml: artifacts.r2.${key} is not a known key`);
  for (const key of ["accountId", "bucket"] as const) {
    const v = a.r2[key];
    if (typeof v !== "string" || v.trim() === "")
      throw new Error(`config.yaml: artifacts.r2.${key} must be a non-empty string`);
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(a.r2.bucket))
    throw new Error("config.yaml: artifacts.r2.bucket must be a valid bucket name (lowercase letters, digits, dashes)");
  positiveInteger(a.retentionDays, "artifacts.retentionDays");
  if (a.inbound !== undefined) {
    if (typeof a.inbound !== "object" || a.inbound === null)
      throw new Error("config.yaml: artifacts.inbound must be a mapping");
    for (const key of unknownKeys(a.inbound, INBOUND_KEYS))
      throw new Error(`config.yaml: artifacts.inbound.${key} is not a known key`);
    positiveInteger(a.inbound.maxBytesPerMessage, "artifacts.inbound.maxBytesPerMessage");
    positiveInteger(a.inbound.copyTimeoutMs, "artifacts.inbound.copyTimeoutMs");
  }
}
