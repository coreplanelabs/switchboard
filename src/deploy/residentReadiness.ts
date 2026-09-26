import { DRAIN, minutesToMs } from "../core/budgets.js";
import { servedCommit } from "./liveGate.js";
import type { HealthRead } from "./sandboxLiveGate.js";

/** The registry's cycle backstop releases admissions, not proof of readiness. */
export const RESIDENT_READY_WAIT_MS = minutesToMs(DRAIN.cycleBoundMinutes);

export function residentWorkerProblem(health: HealthRead, expectedCommit: string): string | undefined {
  if ("error" in health) return `Worker health unreadable: ${health.error}`;
  if (health.status !== 200 || health.body?.ok !== true) return "Worker /healthz is not ready";
  const commit = servedCommit(health.body);
  if (!/^[0-9a-f]{40}$/.test(expectedCommit) || commit !== expectedCommit)
    return `Worker serving ${commit ?? "no commit"}, expected exact ${expectedCommit}`;
  return undefined;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** A complete authenticated registry read, never the lift's acknowledgement or the Worker's build. */
export function residentRegistryProblem(
  read: { status: number; body: unknown } | { error: string },
  expectedResources: readonly string[] = [],
): string | undefined {
  if ("error" in read) return `registry unreadable: ${read.error}`;
  if (read.status !== 200) return `registry unreadable: HTTP ${read.status}`;
  const body = object(read.body);
  if (!body || !Array.isArray(body.residents) || body.count !== body.residents.length)
    return "registry listing missing or incomplete";
  const problems: string[] = [];
  if (body.draining !== null) {
    const held = object(body.draining)?.holds;
    problems.push(`registry not undrained${Array.isArray(held) ? `; held: ${held.join(", ")}` : ""}`);
  }
  const seen = new Set<string>();
  for (const value of body.residents) {
    const row = object(value);
    if (typeof row?.resource !== "string" || row.resource === "" || seen.has(row.resource)) {
      problems.push("registry has missing or duplicate resident identity");
      continue;
    }
    seen.add(row.resource);
    const live = object(row.live);
    if (live?.imageReport !== "current" || live.error !== undefined)
      problems.push(
        `${row.resource}: image report ${String(live?.imageReport ?? "missing")}${live?.error ? " (live view failed)" : ""}`,
      );
  }
  for (const resource of expectedResources)
    if (!seen.has(resource)) problems.push(`${resource}: missing from registry readback`);
  return problems.length ? problems.join("; ") : undefined;
}

/** A lost/malformed reconcile cannot prove its markers were installed for this deploy. */
export function reconciledResources(
  answer: { status: number; body: Record<string, unknown> } | { error: string },
): string[] | undefined {
  if ("error" in answer || answer.status !== 200 || !Array.isArray(answer.body.reconciled)) return undefined;
  const resources: string[] = [];
  for (const value of answer.body.reconciled) {
    const row = object(value);
    if (
      typeof row?.resource !== "string" ||
      !row.resource ||
      resources.includes(row.resource) ||
      typeof row.verified !== "boolean" ||
      typeof row.result !== "string" ||
      !["restarted", "current", "inactive", "deferred", "stale"].includes(row.result)
    )
      return undefined;
    resources.push(row.resource);
  }
  return resources;
}
