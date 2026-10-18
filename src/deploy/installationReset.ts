import { createHash } from "node:crypto";
import type { StagingRecreationPlan, StagingDeletion } from "./stagingRecreate.js";

export interface ResetBucket {
  name: string;
  objects: { key: string; size: number; etag: string }[];
}
export interface InstallationResetPlan {
  schema: 1;
  native: StagingRecreationPlan;
  settingsSha256: string;
  hostingSha256: string;
  journalBucket: string;
  buckets: ResetBucket[];
  objects?: { namespace: string; class: string; objects: { id: string; hasStoredData: boolean }[] }[];
  retained: readonly string[];
  sha256: string;
}
export const resetDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function installationResetPlan(
  input: Omit<InstallationResetPlan, "schema" | "retained" | "sha256">,
): InstallationResetPlan {
  if (![input.settingsSha256, input.hostingSha256].every((digest) => /^[a-f0-9]{64}$/.test(digest)))
    throw new Error("reset requires exact settings and hosting digests");
  if (input.buckets.length !== 2 || new Set(input.buckets.map((bucket) => bucket.name)).size !== 2)
    throw new Error("reset requires two distinct private installation buckets");
  if (
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.journalBucket) ||
    input.buckets.some((bucket) => bucket.name === input.journalBucket)
  )
    throw new Error("reset requires a separate private journal bucket");
  for (const bucket of input.buckets) {
    if (
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket.name) ||
      bucket.objects.some(
        (object) =>
          !object.key ||
          object.key.split("/").some((part) => part === "." || part === "..") ||
          !Number.isSafeInteger(object.size) ||
          object.size < 0 ||
          !object.etag,
      ) ||
      new Set(bucket.objects.map((object) => object.key)).size !== bucket.objects.length
    )
      throw new Error("reset bucket inventory is incomplete");
    bucket.objects.sort((a, b) => a.key.localeCompare(b.key, "en"));
  }
  const plan = {
    schema: 1 as const,
    native: input.native,
    settingsSha256: input.settingsSha256,
    hostingSha256: input.hostingSha256,
    journalBucket: input.journalBucket,
    buckets: input.buckets,
    ...(input.objects ? { objects: input.objects } : {}),
    retained: [
      "hosting and access configuration",
      "external Slack, GitHub and connected-service data",
      "provider metrics, logs, billing and recovery retention",
      "encrypted reset settings and original action journals in the separate control bucket",
    ],
  };
  // The approval clears whole stores. Object counts are observations, not row-level consent.
  return {
    ...plan,
    sha256: resetDigest({
      schema: plan.schema,
      native: plan.native,
      settingsSha256: plan.settingsSha256,
      hostingSha256: plan.hostingSha256,
      journalBucket: plan.journalBucket,
      buckets: plan.buckets.map((bucket) => bucket.name),
      retained: plan.retained,
    }),
  };
}

export interface InstallationResetIO {
  preflight(): Promise<void>;
  readPlan(): Promise<InstallationResetPlan>;
  record(phase: string, detail: unknown): Promise<void>;
  preserve(operation: string): Promise<void>;
  remove(entry: StagingDeletion): Promise<void>;
  absent(): Promise<void>;
  bucketContents(name: string): Promise<ResetBucket>;
  removeObject(bucket: string, object: ResetBucket["objects"][number]): Promise<void>;
  empty(): Promise<void>;
  initialize(): Promise<void>;
  verify(): Promise<void>;
}

/** Every mutation has an original receipt. A lost answer never advances or retries it. */
export async function resetInstallation(approved: string, operation: string, io: InstallationResetIO) {
  if (!/^[a-f0-9]{64}$/.test(approved) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operation))
    throw new Error("reset requires an exact approved plan and operation ID");
  await io.preflight();
  const plan = await io.readPlan();
  if (plan.sha256 !== approved) throw new Error("reset plan changed; preview again");
  // The host creates this original receipt exclusively. Existing receipts refuse before preserve.
  await io.record("preserving", { operation, planSha256: approved });
  await io.preserve(operation);
  for (const entry of plan.native.deletions) {
    await io.record("removing", entry);
    await io.remove(entry);
  }
  await io.absent();
  const currentBuckets = await Promise.all(plan.buckets.map((bucket) => io.bucketContents(bucket.name)));
  if (currentBuckets.some((bucket, index) => bucket.name !== plan.buckets[index].name))
    throw new Error("reset bucket scope changed");
  const current = installationResetPlan({ ...plan, buckets: currentBuckets });
  for (const bucket of current.buckets)
    for (const object of bucket.objects) {
      await io.record("removing-object", { bucket: bucket.name, ...object });
      await io.removeObject(bucket.name, object);
    }
  await io.empty();
  await io.record("initializing", { operation });
  await io.initialize();
  await io.verify();
  await io.record("verified", { operation, maintenance: "retained" });
  return { status: "verified" as const, operation, planSha256: approved, maintenance: "retained" as const };
}
