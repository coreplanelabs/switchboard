import { z } from "zod";
import { createHash } from "node:crypto";
import type { DeploymentProfile } from "./profile.js";

export function memoryReceiptSelection(profile: DeploymentProfile) {
  const memory = profile.workers.memory;
  if (!memory) throw new Error("Memory endpoint is required");
  return {
    account: profile.account,
    script: memory.script,
    hostname: memory.hostname,
    zone: memory.zone ?? profile.zone,
  };
}

export interface MemoryCreationReceipt {
  schema: 1;
  account: string;
  script: string;
  hostname: string;
  zone: string;
  commit: string;
  uploadVersion: string;
  activeVersion: string;
  deploymentId: string;
  domainId: string;
  authorId: string;
  resourcesHash: string;
}

const versionId = z.string().uuid();
export function parseMemoryCreationReceipt(value: unknown): MemoryCreationReceipt {
  return z
    .object({
      schema: z.literal(1),
      account: z.string().regex(/^[a-f0-9]{32}$/),
      script: z.string().regex(/^[a-z0-9-]+$/),
      hostname: z.string().regex(/^[a-z0-9.-]+$/),
      zone: z.string().regex(/^[a-z0-9.-]+$/),
      commit: z.string().regex(/^[a-f0-9]{40}$/),
      uploadVersion: versionId,
      activeVersion: versionId,
      deploymentId: versionId,
      domainId: z.string().regex(/^[a-f0-9]{40}$/),
      authorId: z.string().min(1),
      resourcesHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(value);
}

/** Health alone cannot prove which Worker owns a custom domain. */
export function memoryDomainId(selected: { script: string; hostname: string; zone: string }, domains: unknown): string {
  if (!Array.isArray(domains)) throw new Error("Memory domain inventory unreadable");
  const matches = domains.filter((d) => d?.hostname === selected.hostname);
  const domain = matches[0];
  if (
    matches.length !== 1 ||
    typeof domain?.id !== "string" ||
    !/^[a-f0-9]{40}$/.test(domain.id) ||
    domain.service !== selected.script ||
    domain.zone_name !== selected.zone ||
    domain.environment !== "production" ||
    domain.enabled !== true
  )
    throw new Error("Memory hostname ownership changed or is incomplete");
  return domain.id;
}

/** Native version resources, excluding only the one secret added by provisioning. */
export function memoryResourcesHash(resources: unknown): string {
  if (!resources || typeof resources !== "object" || Array.isArray(resources))
    throw new Error("Memory resources unreadable");
  const value = structuredClone(resources) as Record<string, unknown>;
  const script = value.script as { etag?: unknown } | undefined;
  if (!script || typeof script.etag !== "string" || !script.etag) throw new Error("Memory script identity unreadable");
  if (!Array.isArray(value.bindings)) throw new Error("Memory bindings unreadable");
  if (
    value.bindings.some((b) => typeof b?.name !== "string" || typeof b?.type !== "string") ||
    new Set(value.bindings.map((b) => b.name)).size !== value.bindings.length
  )
    throw new Error("Memory binding identity is incomplete");
  if (
    value.bindings.some(
      (b) =>
        !b ||
        typeof b !== "object" ||
        b.type === "service" ||
        b.type === "workflow" ||
        (b.type === "secret_text" && b.name !== "MEMORY_TOKEN") ||
        (b.name === "MEMORY_TOKEN" && b.type !== "secret_text"),
    )
  )
    throw new Error("Memory is not the provisional installation");
  value.bindings = value.bindings.filter((b) => b.name !== "MEMORY_TOKEN");
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, canonical(x)]),
      );
    return v;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function validateMemoryReceipt(
  receipt: MemoryCreationReceipt,
  selected: { account: string; script: string; hostname: string; zone: string },
  deployment: unknown,
  upload: unknown,
  active: unknown,
  domains: unknown,
): void {
  if (
    receipt.schema !== 1 ||
    !/^[a-f0-9]{40}$/.test(receipt.commit) ||
    !/^[a-f0-9]{64}$/.test(receipt.resourcesHash) ||
    receipt.account !== selected.account ||
    receipt.script !== selected.script ||
    receipt.hostname !== selected.hostname ||
    receipt.zone !== selected.zone
  )
    throw new Error("Memory receipt does not match the selected installation");
  const d = deployment as { id?: string; versions?: { version_id?: string; percentage?: number }[] };
  const u = upload as { id?: string; metadata?: { author_id?: string }; resources?: unknown };
  const a = active as { id?: string; metadata?: { author_id?: string }; resources?: unknown };
  if (
    !d?.versions ||
    d.id !== receipt.deploymentId ||
    memoryDomainId(selected, domains) !== receipt.domainId ||
    d.versions.length !== 1 ||
    d.versions[0].percentage !== 100 ||
    d.versions[0].version_id !== receipt.activeVersion ||
    u?.id !== receipt.uploadVersion ||
    a?.id !== receipt.activeVersion ||
    !receipt.authorId ||
    u.metadata?.author_id !== receipt.authorId ||
    a.metadata?.author_id !== receipt.authorId ||
    memoryResourcesHash(u.resources) !== receipt.resourcesHash ||
    memoryResourcesHash(a.resources) !== receipt.resourcesHash
  )
    throw new Error("Memory creation receipt changed or is incomplete");
}
