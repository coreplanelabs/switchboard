import { describe, expect, it } from "vitest";
import { PRESIGNED_BACKUP_ENV, backupTransferMode } from "./residentBackupTransfer.js";

// Feature: features/resident-repos.md item 61 — which way snapshot bytes
// travel. `localBucket: true` (the Sandbox SDK's local-development mode) pumps
// every archive through the Durable Object over the control RPC, so a checkout
// restore larger than the isolate's memory resets the isolate mid-transfer.
// Presigned mode has the container move the bytes itself; it needs four env
// values, and a missing one must fail CLOSED to local mode with the gap named
// — never to a broken resident.

const full = {
  CLOUDFLARE_ACCOUNT_ID: "account-id",
  BACKUP_BUCKET_NAME: "switchboard-resident-cache",
  R2_ACCESS_KEY_ID: "k",
  R2_SECRET_ACCESS_KEY: "s",
};

describe("backupTransferMode (transfers leave the DO's data path only when every presigned input is present)", () => {
  it("names the four inputs the SDK's requirePresignedURLSupport reads, and nothing else", () => {
    expect([...PRESIGNED_BACKUP_ENV]).toEqual([
      "CLOUDFLARE_ACCOUNT_ID",
      "BACKUP_BUCKET_NAME",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    ]);
  });

  it("all four present → presigned: localBucket false", () => {
    expect(backupTransferMode(full)).toEqual({ mode: "presigned", localBucket: false, missing: [] });
  });

  it("any input absent or empty → local mode, with the missing names in env order (a misprovisioned secret degrades to today's behavior, loudly)", () => {
    const { R2_SECRET_ACCESS_KEY: _dropped, ...noSecret } = full;
    expect(backupTransferMode(noSecret)).toEqual({
      mode: "local",
      localBucket: true,
      missing: ["R2_SECRET_ACCESS_KEY"],
    });
    expect(backupTransferMode({ ...full, R2_ACCESS_KEY_ID: "", BACKUP_BUCKET_NAME: "   " })).toEqual({
      mode: "local",
      localBucket: true,
      missing: ["BACKUP_BUCKET_NAME", "R2_ACCESS_KEY_ID"],
    });
    expect(backupTransferMode({})).toMatchObject({ mode: "local", localBucket: true });
    expect(backupTransferMode({}).missing).toHaveLength(4);
  });

  it("ignores unrelated env and non-string values", () => {
    expect(backupTransferMode({ ...full, OTHER: 1, RESIDENT: {} } as Record<string, unknown>).mode).toBe("presigned");
    expect(backupTransferMode({ ...full, R2_ACCESS_KEY_ID: 42 } as Record<string, unknown>)).toMatchObject({
      mode: "local",
      missing: ["R2_ACCESS_KEY_ID"],
    });
  });
});
