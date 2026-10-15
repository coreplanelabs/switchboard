import { DRAIN, minutesToMs } from "../core/budgets.js";
import { parseAppConfigText } from "../config.js";
import { sha256Hex } from "../configDocument.js";
import { parseConfigSource } from "./configSource.js";
import { maintenanceProfileMaterial, type LoadedProfile } from "./profile.js";
import { stagingProblems } from "./staging.js";
import { residentImageReportsProblem, residentMaintenanceProblem, residentWorkerProblem } from "./residentReadiness.js";
import { residentImageTargetSchema, type ResidentImageTarget } from "./residentMaintenance.js";
import type { DeployRunResult } from "./run.js";
import type { HealthRead } from "./sandboxLiveGate.js";
import { residentAddress } from "../execution/residentMembers.js";

export interface HeldBootstrapRequest {
  repository: string;
  pullRequest: number;
  branch: string;
  commit: string;
  controllerCommit: string;
  workflowRef: string;
  event: string;
  actorId: number;
  runId: number;
  runAttempt: number;
  attemptId: string;
  profileRef: string;
  previousCommit: string;
  previousWorkerVersion: string;
}
export interface BootstrapWorkflowRun {
  id: number;
  actor: { id: number };
  head_sha: string;
  head_branch: string;
  run_attempt: number;
  event: string;
  display_title: string;
  created_at: string;
}
export interface HeldBootstrapIO {
  now(): number;
  loadProfile(): Promise<LoadedProfile>;
  readConfig(source: string): Promise<string>;
  history(): Promise<BootstrapWorkflowRun[]>;
  read(url: string, timeoutMs: number): Promise<HealthRead>;
  deploy(
    loaded: LoadedProfile,
    config: string,
    previousVersion: string,
  ): Promise<{ result: DeployRunResult; target?: ResidentImageTarget }>;
  receipt(value: Record<string, unknown>): void;
}

const fullCommit = (value: string) => /^[0-9a-f]{40}$/.test(value);
const uuid = (value: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
function immutableReference(value: string, repository: string): boolean {
  const parsed = parseConfigSource(value);
  return (
    parsed.ok &&
    parsed.source.kind === "github" &&
    `${parsed.source.owner}/${parsed.source.repo}` === repository &&
    fullCommit(parsed.source.ref)
  );
}

/** CI metadata identifies the selected run. Repository and cloud credentials supply authority. */
export async function runHeldStagingBootstrap(
  request: HeldBootstrapRequest,
  accounts: { staging?: string; production?: string; configRepository: string },
  io: HeldBootstrapIO,
): Promise<Record<string, unknown>> {
  let receipt: Record<string, unknown> = { schema: 1, kind: "staging-held-bootstrap", outcome: "unverified", request };
  io.receipt(receipt);
  try {
    if (
      request.event !== "workflow_dispatch" ||
      request.runAttempt !== 1 ||
      !positive(request.runId) ||
      !positive(request.actorId) ||
      !positive(request.pullRequest) ||
      !uuid(request.attemptId) ||
      !fullCommit(request.commit) ||
      request.controllerCommit !== request.commit ||
      !fullCommit(request.previousCommit) ||
      request.previousCommit === request.commit ||
      !uuid(request.previousWorkerVersion) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository) ||
      !request.branch ||
      request.workflowRef !==
        `${request.repository}/.github/workflows/deploy-staging-bootstrap.yml@refs/heads/${request.branch}` ||
      !immutableReference(request.profileRef, accounts.configRepository)
    )
      throw new Error("manual bootstrap identity or immutable profile is invalid");
    const runs = await io.history();
    const selected = runs.filter((run) => run.display_title === `staging held bootstrap ${request.attemptId}`);
    const original = selected[0];
    if (
      selected.length !== 1 ||
      !original ||
      original.id !== request.runId ||
      original.actor.id !== request.actorId ||
      original.run_attempt !== 1 ||
      original.event !== "workflow_dispatch" ||
      original.head_sha !== request.commit ||
      original.head_branch !== request.branch ||
      !Number.isFinite(Date.parse(original.created_at))
    )
      throw new Error("original bootstrap run is unavailable or this attempt was already requested");
    const loaded = await io.loadProfile();
    const policy = loaded.profile.residentMaintenance;
    if (
      loaded.origin !== "profile" ||
      loaded.path !== request.profileRef ||
      !policy ||
      policy.attempt.id !== request.attemptId ||
      policy.attempt.sourceCommit !== request.commit ||
      !immutableReference(loaded.profile.configSource, accounts.configRepository)
    )
      throw new Error("selected bootstrap policy or immutable configuration changed");
    const text = await io.readConfig(loaded.profile.configSource);
    const problems = stagingProblems(loaded.profile, parseAppConfigText(text), {
      staging: accounts.staging,
      production: accounts.production,
    });
    if (
      problems.length ||
      sha256Hex(text) !== policy.attempt.configSha256 ||
      sha256Hex(maintenanceProfileMaterial(loaded.profile)) !== policy.attempt.profileSha256 ||
      policy.attempt.deadline > Date.parse(original.created_at) + minutesToMs(DRAIN.maxMinutes) ||
      policy.attempt.deadline - io.now() < minutesToMs(DRAIN.deployFenceMinRemainingMinutes)
    )
      throw new Error("bootstrap isolation, frozen input or deadline is unverified");
    receipt = { ...receipt, policy, configurationSha256: policy.attempt.configSha256 };
    io.receipt(receipt);
    const read = (path: string) =>
      io.read(
        new URL(path, policy.residentOrigin).toString(),
        Math.min(DRAIN.pollMs, policy.attempt.deadline - io.now()),
      );
    const oldHealth = await read("/healthz");
    if (residentWorkerProblem(oldHealth, request.previousCommit))
      throw new Error("qualified previous Resident source changed");
    const before = await read("/residents");
    if ("error" in before || residentImageReportsProblem(before))
      throw new Error("previous fixture inventory is unverified");
    const inventory = before.body as unknown as {
      residents: { resource: string; residentId?: string; live: { inFlight?: number; runsInFlight?: number } }[];
      stagingMaintenance?: unknown;
      pendingReplicas?: number;
    };
    if (
      inventory.stagingMaintenance != null ||
      (inventory.pendingReplicas ?? 0) !== 0 ||
      inventory.residents.some(
        (row) => !policy.resources.includes(row.resource) || row.live.inFlight !== 0 || row.live.runsInFlight !== 0,
      ) ||
      policy.resources.some((resource) => !inventory.residents.some((row) => row.resource === resource))
    )
      throw new Error("bootstrap fixture changed or maintenance already exists");
    const members = inventory.residents.map(residentAddress);
    if (policy.attempt.deadline - io.now() < minutesToMs(DRAIN.deployFenceMinRemainingMinutes))
      throw new Error("bootstrap deadline no longer has its upload reserve");
    const deployed = await io.deploy(structuredClone(loaded), text, request.previousWorkerVersion);
    if (
      deployed.result.kind !== "ran" ||
      !deployed.result.ok ||
      deployed.result.results.length !== 1 ||
      deployed.result.results[0]?.name !== "resident" ||
      deployed.result.results[0].live !== "uploaded, image-ready, maintenance held"
    )
      throw new Error("bootstrap upload or readiness remains unverified");
    const health = await read("/healthz");
    if (
      residentWorkerProblem(health, request.commit) ||
      "error" in health ||
      (health.body?.features as Record<string, unknown> | undefined)?.nativeRunScopes !== "native-v1"
    )
      throw new Error("bootstrap source or native Worker capability is unverified");
    const after = await read("/residents");
    if (
      residentMaintenanceProblem(after, policy, members, true) ||
      residentImageReportsProblem(after, members, deployed.target)
    )
      throw new Error("bootstrap maintenance or member readiness is unverified");
    if (
      "error" in after ||
      (after.body as unknown as { stagingMaintenance: { window: unknown } }).stagingMaintenance.window !== null
    )
      throw new Error("bootstrap must not claim or consume a risk window");
    const terminal = after.body as unknown as typeof inventory;
    if (
      (terminal.pendingReplicas ?? 0) !== 0 ||
      terminal.residents.some(
        (row) => !members.includes(residentAddress(row)) || !policy.resources.includes(row.resource),
      )
    )
      throw new Error("bootstrap fixture changed or pending members remain");
    const target = residentImageTargetSchema.safeParse(deployed.target);
    if (
      !target.success ||
      target.data.application !== `${policy.residentScript}-residentdo` ||
      io.now() >= policy.attempt.deadline
    )
      throw new Error("bootstrap native target or terminal deadline is unverified");
    receipt = {
      ...receipt,
      outcome: "image-ready-maintenance-held",
      riskWindow: null,
      target: {
        application: target.data.application,
        version: target.data.version,
        imageReferenceSha256: sha256Hex(target.data.image),
      },
    };
    io.receipt(receipt);
    return receipt;
  } catch (error) {
    io.receipt({
      ...receipt,
      outcome: "unverified",
      error: error instanceof Error ? error.message : "bootstrap failed",
    });
    throw error;
  }
}
