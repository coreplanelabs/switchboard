/** Which way a resident's snapshot bytes travel (features/resident-repos.md
 *  item 61), kept pure so the decision is a unit test and the Worker only
 *  reads it.
 *
 *  The Sandbox SDK has two transfer modes for `createBackup` / `restoreBackup`:
 *  - `localBucket: true` — the Durable Object reads the archive from the R2
 *    binding and pumps it to the container over the control RPC (and the
 *    reverse on upload). The SDK documents this as the LOCAL-DEVELOPMENT mode
 *    ("required for local development where presigned URLs and FUSE are
 *    unavailable"). It puts a 128 MB isolate in the data path of every
 *    transfer: a checkout restore larger than the isolate's memory (a full
 *    checkout runs to gigabytes) resets the isolate mid-transfer, and a
 *    resident whose restore was reset sits in `restoring` with no way out but
 *    a manual rebuild.
 *  - presigned — the DO signs GET/PUT URLs; the container downloads
 *    (`downloadBackupParallel`, resumable) and uploads the bytes itself. The
 *    DO orchestrates and judges; its memory no longer scales with the archive.
 *    This is the mode the SDK's `requirePresignedURLSupport` gates on four env
 *    values, named below exactly as it reads them.
 *
 *  Fail-closed: any input absent → local mode, with the gap named, so a
 *  misprovisioned secret degrades to today's behavior loudly instead of
 *  breaking every snapshot. The mode is reported on /healthz for the receipt. */

export const PRESIGNED_BACKUP_ENV = [
  "CLOUDFLARE_ACCOUNT_ID",
  "BACKUP_BUCKET_NAME",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
] as const;

export type BackupTransferMode = "presigned" | "local";

export interface BackupTransferDecision {
  mode: BackupTransferMode;
  /** What to pass the SDK as `localBucket`. */
  localBucket: boolean;
  /** The presigned inputs that are absent or blank, in PRESIGNED_BACKUP_ENV order; empty in presigned mode. */
  missing: string[];
}

export function backupTransferMode(env: Record<string, unknown>): BackupTransferDecision {
  const missing = PRESIGNED_BACKUP_ENV.filter((name) => {
    const v = env[name];
    return typeof v !== "string" || v.trim() === "";
  });
  return missing.length === 0
    ? { mode: "presigned", localBucket: false, missing: [] }
    : { mode: "local", localBucket: true, missing: [...missing] };
}
