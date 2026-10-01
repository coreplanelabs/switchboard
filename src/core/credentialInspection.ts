import type { HarnessRegistry } from "./harness/pi/relay.js";
import {
  emptyCredentialInspection,
  parseCredentialInspection,
  type CredentialInspection,
} from "../execution/credentialInspection.js";

export interface CredentialInspectionBinding {
  backend: "resident" | "sandbox";
  repo: string;
  ref: string;
  head: string;
}

/** Attaches only to an already-live harness. It never provisions an executor,
 * mints a bearer, or borrows a publication effect. */
export async function inspectLiveCredentials(
  registry: HarnessRegistry,
  runId: string,
  expected: CredentialInspectionBinding,
): Promise<CredentialInspection> {
  try {
    const live = registry.get(runId);
    if (
      !live ||
      (live.backend !== "resident" && live.backend !== "sandbox") ||
      live.backend !== expected.backend ||
      live.rules.branch !== expected.ref ||
      live.toolContext.signal?.aborted ||
      live.toolsBlocked?.()
    )
      return emptyCredentialInspection();
    const process = live.credentialInspectionProcess?.();
    const executor = live.toolContext.executor;
    if (!process || !executor.inspectCredentials) return emptyCredentialInspection();
    const result = await executor.inspectCredentials({
      runId,
      pid: process.pid,
      processBirth: process.processBirth,
      repo: expected.repo,
      ref: expected.ref,
      head: expected.head,
      signal: live.toolContext.signal,
    });
    if (
      registry.get(runId) !== live ||
      live.toolContext.executor !== executor ||
      live.credentialInspectionProcess?.()?.pid !== process.pid ||
      live.credentialInspectionProcess?.()?.processBirth !== process.processBirth ||
      live.backend !== expected.backend ||
      live.rules.branch !== expected.ref ||
      live.toolContext.signal?.aborted ||
      live.toolsBlocked?.()
    )
      return emptyCredentialInspection();
    return parseCredentialInspection(result);
  } catch {
    return emptyCredentialInspection();
  }
}
