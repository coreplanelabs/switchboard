import { stripJsonc } from "../agentEnv/bootstrap.js";
import type { WorkerKind } from "./profile.js";

/** Only the first installation uses this protocol. Updates keep the regular deploy runner. */
export interface BootstrapIO {
  resumeMemory?(): Promise<void>;
  absent(workers: readonly WorkerKind[]): Promise<void>;
  upload(worker: WorkerKind, provisional?: boolean): Promise<void>;
  provision(worker: WorkerKind): Promise<void>;
  restartBot(): Promise<void>;
  verify(worker: WorkerKind): Promise<void>;
  prepare(): Promise<{ key: string; priorVersion: number; legacyVersion: number; send(): Promise<void> }>;
  admission(phase: "pending" | "landed"): Promise<void>;
}

/** No failed read, old serving process, or partial installation authorizes creation. */
export async function initializeStaging(commit: string, io: BootstrapIO) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("first installation requires a clean source commit");
  if (io.resumeMemory) {
    await io.absent(["bot", "resident", "sandbox"]);
    await io.resumeMemory();
  } else {
    await io.absent(["memory", "bot", "resident", "sandbox"]);
    await io.upload("memory", true);
    await io.provision("memory");
  }
  await io.verify("memory");
  for (const worker of ["resident", "sandbox"] as const) {
    await io.absent([worker]);
    await io.upload(worker);
    await io.provision(worker);
    await io.verify(worker);
  }
  await io.admission("pending");
  const prepared = await io.prepare();
  if (prepared.priorVersion !== 0 || prepared.legacyVersion !== 0)
    throw new Error("initial configuration requires empty legacy and owned slots");
  await io.absent(["bot"]);
  await prepared.send();
  await io.absent(["bot"]);
  await io.upload("bot");
  await io.provision("bot");
  await io.restartBot();
  await io.verify("bot");
  await io.upload("memory");
  await io.verify("memory");
  await io.admission("landed");
  return { status: "installed" as const, commit };
}

/** A successful, complete provider list is authority; a truncated or malformed one is not. */
export function nativeInventoryRows(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") throw new Error("native inventory is malformed");
  const b = value as Record<string, unknown>;
  if (b.success !== true || !Array.isArray(b.result)) throw new Error("native inventory is unsuccessful");
  const info = b.result_info;
  if (info !== undefined) {
    if (!info || typeof info !== "object" || Array.isArray(info))
      throw new Error("native inventory pagination is malformed");
    const p = info as Record<string, unknown>;
    if (Object.keys(p).some((k) => !["count", "page", "per_page", "total_count", "total_pages"].includes(k)))
      throw new Error("native inventory pagination is unknown");
    if (Object.values(p).some((v) => typeof v !== "number" || !Number.isSafeInteger(v) || v < 0))
      throw new Error("native inventory pagination is malformed");
    if (p.count !== undefined && p.count !== b.result.length) throw new Error("native inventory is incomplete");
    if (
      (p.total_count !== undefined && p.total_count !== b.result.length) ||
      (p.total_pages !== undefined && typeof p.total_pages === "number" && p.total_pages > 1) ||
      (p.page !== undefined && p.page !== 1)
    )
      throw new Error("native inventory is incomplete");
  }
  if (b.result.some((r) => !r || typeof r !== "object" || Array.isArray(r)))
    throw new Error("native inventory rows are malformed");
  return b.result as Record<string, unknown>[];
}

/** The provisional state Worker cannot bind a Bot that does not exist yet. */
export function initialMemoryConfig(rendered: string): string {
  const config = JSON.parse(stripJsonc(rendered));
  delete config.services;
  delete config.workflows;
  return JSON.stringify(config);
}

/** Read the provider's actual final bindings, rather than crediting the local render. */
export function hasFullMemoryBindings(bindings: unknown, bot: string): boolean {
  if (!Array.isArray(bindings)) return false;
  const service = bindings.filter((b) => b?.name === "BOT");
  const workflow = bindings.filter((b) => b?.name === "SHIP_COORDINATOR");
  return (
    service.length === 1 &&
    service[0].type === "service" &&
    service[0].service === bot &&
    workflow.length === 1 &&
    workflow[0].type === "workflow" &&
    workflow[0].workflow_name === `${bot}-ship-coordinator` &&
    workflow[0].script_name === bot
  );
}
