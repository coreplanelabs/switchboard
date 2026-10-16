import { z } from "zod";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DeploymentProfile } from "./profile.js";
import { workerDomainId, provisionedResourcesHash, parseMemoryCreationReceipt } from "./stagingMemoryReceipt.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const executor = z
  .object({
    applicationId: z.string().uuid(),
    namespaceId: z.string().regex(/^[a-f0-9]{32}$/),
    image: z.string().regex(/^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/),
    uploadVersion: z.string().uuid(),
  })
  .strict();

export const continuationSchema = z
  .object({
    schema: z.literal(1),
    originalRun: z.number().int().positive(),
    originalArtifact: z.number().int().positive(),
    originalArtifactDigest: digest,
    originalController: sha,
    originalActor: z.number().int().positive(),
    installationCommit: sha,
    partialArtifactSha256: digest,
    memoryReceiptSha256: digest,
    executors: z.object({ resident: executor, sandbox: executor }).strict(),
    fixture: z
      .object({
        resource: z.string().regex(/^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        noResident: z.literal(true),
        defaultRef: z.literal("main"),
        commands: z.object({ install: z.string().min(1), build: z.string().min(1), test: z.string().min(1) }).strict(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type StagingContinuation = z.infer<typeof continuationSchema>;

/** Prove a completed upload and provisioning without replaying either effect. */
export function validateExecutorContinuation(
  kind: "resident" | "sandbox",
  expected: StagingContinuation["executors"]["resident"],
  profile: DeploymentProfile,
  author: string,
  secrets: readonly string[],
  observed: {
    applications: Record<string, unknown>[];
    namespaces: Record<string, unknown>[];
    domains: Record<string, unknown>[];
    deployment: unknown;
    upload: unknown;
    active: unknown;
  },
) {
  const worker = profile.workers[kind];
  if (!worker) throw new Error("continuation executor is not selected");
  const applicationName = `${worker.script}-${kind === "resident" ? "residentdo" : "switchboardsandbox"}`;
  const applications = observed.applications.filter(
    (a) => a.name === applicationName || a.id === expected.applicationId,
  );
  const app = applications[0] as
    | {
        id?: string;
        name?: string;
        account_id?: string;
        version?: number;
        durable_objects?: { namespace_id?: string };
        configuration?: { image?: string };
      }
    | undefined;
  const namespaces = observed.namespaces.filter(
    (n) =>
      n.id === expected.namespaceId ||
      (n.script === worker.script && n.class === (kind === "resident" ? "ResidentDO" : "SwitchboardSandbox")),
  );
  if (
    applications.length !== 1 ||
    app?.id !== expected.applicationId ||
    app.name !== applicationName ||
    app.account_id !== profile.account ||
    !Number.isSafeInteger(app.version) ||
    app.version! < 1 ||
    app.durable_objects?.namespace_id !== expected.namespaceId ||
    app.configuration?.image !== expected.image ||
    !expected.image.startsWith(`registry.cloudflare.com/${profile.account}/${applicationName}@sha256:`) ||
    namespaces.length !== 1 ||
    namespaces[0].id !== expected.namespaceId ||
    namespaces[0].script !== worker.script ||
    namespaces[0].class !== (kind === "resident" ? "ResidentDO" : "SwitchboardSandbox")
  )
    throw new Error("continuation executor application or namespace changed");
  workerDomainId(
    { script: worker.script, hostname: worker.hostname, zone: worker.zone ?? profile.zone },
    observed.domains,
  );
  const deployment = observed.deployment as { id?: string; versions?: { version_id?: string; percentage?: number }[] };
  const upload = observed.upload as { id?: string; metadata?: { author_id?: string }; resources?: unknown };
  const active = observed.active as {
    id?: string;
    metadata?: { author_id?: string };
    resources?: { bindings?: { name?: string; type?: string }[] };
  };
  const names = active.resources?.bindings
    ?.filter((b) => b.type === "secret_text")
    .map((b) => b.name)
    .sort();
  if (
    !author ||
    upload.id !== expected.uploadVersion ||
    upload.metadata?.author_id !== author ||
    active.metadata?.author_id !== author ||
    !z.string().uuid().safeParse(active.id).success ||
    !z.string().uuid().safeParse(deployment.id).success ||
    deployment.versions?.length !== 1 ||
    deployment.versions[0].percentage !== 100 ||
    deployment.versions[0].version_id !== active.id ||
    JSON.stringify(names) !== JSON.stringify([...secrets].sort()) ||
    provisionedResourcesHash(upload.resources, secrets) !== provisionedResourcesHash(active.resources, secrets)
  )
    throw new Error("continuation executor deployment, code or secret roster changed");
  return {
    applicationId: expected.applicationId,
    applicationVersion: app.version!,
    namespaceId: expected.namespaceId,
    image: expected.image,
    deploymentId: deployment.id!,
    activeVersion: active.id!,
    secrets: [...secrets].sort(),
  };
}

export interface OriginalInitializationRun {
  id?: number;
  status?: string;
  conclusion?: string;
  run_attempt?: number;
  event?: string;
  path?: string;
  head_sha?: string;
  actor?: { id?: number };
}

/** Qualify the original code before executing anything from its checkout. */
export function validateContinuationProvenance(
  checkpoint: StagingContinuation,
  original: OriginalInitializationRun,
  partialBytes: Buffer,
  memoryBytes: Buffer,
  installationCommit: string | undefined,
) {
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  if (
    original.id !== checkpoint.originalRun ||
    original.status !== "completed" ||
    original.conclusion !== "failure" ||
    original.run_attempt !== 1 ||
    original.event !== "workflow_dispatch" ||
    original.path?.split("@")[0] !== ".github/workflows/recreate-staging.yml" ||
    original.head_sha !== checkpoint.originalController ||
    original.actor?.id !== checkpoint.originalActor ||
    hash(partialBytes) !== checkpoint.partialArtifactSha256 ||
    hash(memoryBytes) !== checkpoint.memoryReceiptSha256
  )
    throw new Error("original initialization controller or artifacts changed");
  const partial = JSON.parse(partialBytes.toString());
  const memory = parseMemoryCreationReceipt(JSON.parse(memoryBytes.toString()));
  if (
    installationCommit !== checkpoint.installationCommit ||
    partial.status !== "initializing" ||
    partial.acceptance !== "not-run" ||
    partial.plan?.evidence?.source?.commit !== installationCommit ||
    memory.commit !== installationCommit
  )
    throw new Error("continuation original installation source changed");
  return { memory, profile: partial.plan.evidence.profile, configSha256: partial.plan.evidence.source.configSha256 };
}

/** Current runtime inputs are checked separately from original source provenance. */
export function validateContinuationSource(
  checkpoint: StagingContinuation,
  original: OriginalInitializationRun,
  partialBytes: Buffer,
  memoryBytes: Buffer,
  profile: DeploymentProfile,
  configSha256: string,
) {
  const proved = validateContinuationProvenance(
    checkpoint,
    original,
    partialBytes,
    memoryBytes,
    checkpoint.installationCommit,
  );
  if (proved.configSha256 !== configSha256 || !isDeepStrictEqual(proved.profile, profile))
    throw new Error("continuation installation source, profile or configuration changed");
  return proved.memory;
}
