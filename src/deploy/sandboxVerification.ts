import type { PublicInventoryObservation } from "./publicInventoryObservation.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_ROOT, packageSourceOnHost, ensureWorkAreaOnHost } from "./host.js";
import { LIVE_GATE_DEADLINE_MS } from "./liveGate.js";
import { createPagingObserver, type PagingObserver } from "./pagingDiagnostic.js";
import { workersFor, type SandboxLiveGate } from "./plan.js";
import type { DeploymentProfile } from "./profile.js";
import { defaultSandboxGateDeps, type SandboxGateDeps } from "./run.js";
import {
  decideSandboxLive,
  decideWorker,
  probeThreadKey,
  type HealthRead,
  type AppState,
  type ContainerInstance,
} from "./sandboxLiveGate.js";

export interface SandboxVerificationOptions {
  expectedCommit: string;
  expectedAppVersion: number;
  expectedImage: string;
  inventoryOnly: boolean;
}
export interface SandboxVerificationResult {
  ok: boolean;
  live: boolean;
  inventoryVerified: boolean;
  source: string;
  expectedCommit: string;
  reason: string;
}

export interface SandboxInspectionOptions {
  expectedCommit: string;
  inspect: true;
  publicMetadata?: boolean;
}
export interface SandboxInspectionResult {
  ok: boolean;
  live: false;
  targetVerified: false;
  inventoryComplete: boolean;
  publicMetadata?: PublicInventoryObservation;
  source: string;
  expectedCommit: string;
  appVersion: number | null;
  imageDigest: string | null;
  reason: string;
}
type Target = { account?: string; dir: string; gate: SandboxLiveGate; config?: string; source: string };
type Snapshot = { health: HealthRead; app: { value: AppState }; instances: { value: ContainerInstance[] } };
type SnapshotRead = Snapshot | { error: string; app?: Snapshot["app"] };
const imageDigest = (image: string | null) => image?.match(/(?:^|@)(sha256:[a-f0-9]{64})$/)?.[1] ?? null;

function readBudget(deps: SandboxGateDeps) {
  const started = deps.now();
  const deadline = AbortSignal.timeout(LIVE_GATE_DEADLINE_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline;
  return { started, signal, stopped: () => signal.aborted || deps.now() - started >= LIVE_GATE_DEADLINE_MS };
}
async function readSnapshot(
  expectedCommit: string,
  target: Target,
  deps: SandboxGateDeps,
  budget: ReturnType<typeof readBudget>,
  observePaging?: PagingObserver,
  pins?: SandboxVerificationOptions,
): Promise<SnapshotRead> {
  const { signal, stopped } = budget;
  if (stopped()) return { error: "verification interrupted or deadline reached" };
  const health = await deps.readHealth(target.gate.healthUrl, deps.env[target.gate.bearerEnv], undefined, signal);
  if (stopped()) return { error: "verification interrupted or deadline reached" };
  const worker = decideWorker(health, expectedCommit);
  if (!worker.ok) return { error: worker.reason };
  if ("error" in health || health.status !== 200 || worker.commit !== expectedCommit)
    return { error: "Worker health does not carry HTTP 200 and the exact pinned commit" };
  const app = await deps.readAppState(target.dir, target.gate.containerApp, target.config, signal);
  if (stopped()) return { error: "verification interrupted or deadline reached" };
  if ("error" in app) return app;
  if (
    pins &&
    (app.value.version !== pins.expectedAppVersion ||
      (pins.expectedImage.startsWith("sha256:")
        ? imageDigest(app.value.image) !== pins.expectedImage
        : app.value.image !== pins.expectedImage))
  )
    return { error: "container application does not match the pinned version and image", app };
  const instances = await deps.readInstances(
    target.dir,
    target.gate.containerApp,
    target.config,
    signal,
    observePaging,
  );
  if (stopped()) return { error: "verification interrupted or deadline reached", app };
  if ("error" in instances) return { error: instances.error, app };
  if (pins && instances.value.some((row) => row.state === "running" && row.version !== pins.expectedAppVersion))
    return { error: "complete inventory includes a running instance outside the pinned application version", app };
  return { health, app, instances };
}

/** Observation cannot establish that an installed image belongs to a desired
 * release. The operator must bind its digest to independent build provenance. */
export async function inspectSandboxOnce(
  options: SandboxInspectionOptions,
  target: Target,
  deps: SandboxGateDeps,
  observePaging?: PagingObserver,
): Promise<SandboxInspectionResult> {
  const result = (reason: string, observed?: SnapshotRead): SandboxInspectionResult => ({
    ok: !!observed && !("error" in observed),
    live: false,
    targetVerified: false,
    inventoryComplete: !!observed && !("error" in observed),
    source: target.source,
    expectedCommit: options.expectedCommit,
    appVersion: observed?.app?.value.version ?? null,
    imageDigest: imageDigest(observed?.app?.value.image ?? null),
    reason,
  });
  if (!/^[a-f0-9]{40}$/.test(options.expectedCommit) || !/^[a-f0-9]{40}$/.test(target.source))
    return result("inspection requires exact verifier source and Worker commit");
  if (!deps.env[target.gate.bearerEnv]) return result(`${target.gate.bearerEnv} is not set`);
  const budget = readBudget(deps);
  if (options.publicMetadata) {
    const health = await deps.readHealth(
      target.gate.healthUrl,
      deps.env[target.gate.bearerEnv],
      undefined,
      budget.signal,
    );
    if (budget.stopped()) return result("public metadata inspection interrupted; completeness unverified");
    const worker = decideWorker(health, options.expectedCommit);
    if (!worker.ok) return result(worker.reason);
    if ("error" in health || health.status !== 200 || worker.commit !== options.expectedCommit)
      return result("Worker health does not carry HTTP 200 and the exact pinned commit");
    if (!target.account || !deps.readPublicMetadata)
      return result("public metadata reader unavailable; completeness unverified");
    const publicMetadata = await deps.readPublicMetadata(
      target.dir,
      target.gate.containerApp,
      target.account,
      target.config,
      budget.signal,
      observePaging,
    );
    if (budget.stopped()) return result("public metadata inspection interrupted; completeness unverified");
    return { ...result(publicMetadata.reason), ok: publicMetadata.complete, publicMetadata };
  }
  let observed = await readSnapshot(options.expectedCommit, target, deps, budget, observePaging);
  if (budget.stopped()) observed = { error: "verification interrupted or deadline reached", app: observed.app };
  return result(
    "error" in observed ? observed.error : "observation only; target acceptance and full readiness unverified",
    observed,
  );
}

/** One observation against independently pinned deployed facts. No upload or
 * rollout is inferred from the verifier's source or the current profile tag. */
export async function verifySandboxOnce(
  options: SandboxVerificationOptions,
  target: Target,
  deps: SandboxGateDeps,
  observePaging?: PagingObserver,
): Promise<SandboxVerificationResult> {
  let inventoryVerified = false;
  const result = (ok: boolean, live: boolean, reason: string): SandboxVerificationResult => ({
    ok,
    live,
    inventoryVerified,
    source: target.source,
    expectedCommit: options.expectedCommit,
    reason,
  });
  if (
    !/^[a-f0-9]{40}$/.test(options.expectedCommit) ||
    !/^[a-f0-9]{40}$/.test(target.source) ||
    !Number.isSafeInteger(options.expectedAppVersion) ||
    options.expectedAppVersion < 0 ||
    !/^(?:[^\s?#]+@)?sha256:[a-f0-9]{64}$/.test(options.expectedImage)
  )
    return result(
      false,
      false,
      "verification requires exact source, Worker commit, application version and image digest",
    );
  const bearer = deps.env[target.gate.bearerEnv];
  if (!bearer) return result(false, false, `${target.gate.bearerEnv} is not set`);
  const budget = readBudget(deps);
  const { started, signal, stopped } = budget;
  const interrupted = () => result(false, false, "verification interrupted or deadline reached; readiness unverified");
  const snapshot = () => readSnapshot(options.expectedCommit, target, deps, budget, observePaging, options);
  if (stopped()) return interrupted();
  const before = await snapshot();
  if ("error" in before) return result(false, false, before.error);
  if (stopped()) return interrupted();
  inventoryVerified = true;
  if (options.inventoryOnly)
    return result(true, false, "inventory verified; echo probe not requested; full readiness unverified");
  if (stopped()) return interrupted();
  const key = probeThreadKey(options.expectedCommit);
  const probe = await deps.probeExec(new URL("/exec", target.gate.healthUrl).toString(), bearer, key, signal);
  if (stopped()) return interrupted();
  const after = await snapshot();
  if ("error" in after) {
    inventoryVerified = false;
    return result(false, false, after.error);
  }
  if (stopped()) {
    inventoryVerified = false;
    return interrupted();
  }
  const decision = decideSandboxLive({
    health: after.health,
    deployedCommit: options.expectedCommit,
    app: after.app,
    before: before.app,
    target: null,
    instances: after.instances,
    probe,
    probeThreadKey: key,
    elapsedMs: deps.now() - started,
  });
  return decision.kind === "live"
    ? result(
        true,
        true,
        `Worker and pinned application match; complete inventory agrees; echo ok exit 0 from ${key} (version ${options.expectedAppVersion})`,
      )
    : result(false, false, decision.reason);
}

/** CLI-only host boundary. The native config contains the existing account,
 * and owns its own directory; verification never renders upload configs. */
export function verifySandboxOnHost(
  profile: DeploymentProfile,
  options: SandboxVerificationOptions,
  log: (line: string) => void,
): Promise<SandboxVerificationResult>;
export function verifySandboxOnHost(
  profile: DeploymentProfile,
  options: SandboxInspectionOptions,
  log: (line: string) => void,
): Promise<SandboxInspectionResult>;
export async function verifySandboxOnHost(
  profile: DeploymentProfile,
  options: SandboxVerificationOptions | SandboxInspectionOptions,
  log: (line: string) => void,
): Promise<SandboxVerificationResult | SandboxInspectionResult> {
  const worker = workersFor(profile).find((row) => row.name === "sandbox");
  const refusal = (reason: string): SandboxVerificationResult | SandboxInspectionResult => ({
    ok: false,
    live: false,
    source: "unknown",
    expectedCommit: options.expectedCommit,
    reason,
    ...("inspect" in options
      ? { targetVerified: false as const, inventoryComplete: false, appVersion: null, imageDigest: null }
      : { inventoryVerified: false }),
  });
  if (!worker || worker.liveGate?.kind !== "sandbox") return refusal("profile has no Sandbox verification target");
  let source: string;
  try {
    if (OPERATOR_ROOT.mode === "package") source = packageSourceOnHost().commit;
    else {
      if (execFileSync("git", ["status", "--porcelain"], { cwd: OPERATOR_ROOT.root, encoding: "utf8" }).trim())
        return refusal("verification requires a clean verifier checkout");
      source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: OPERATOR_ROOT.root, encoding: "utf8" }).trim();
    }
  } catch {
    return refusal("verifier source unavailable");
  }
  const ready = await ensureWorkAreaOnHost([worker.dir], log);
  if (!ready.ok) return refusal(ready.problem);
  const directory = mkdtempSync(join(tmpdir(), "sandbox-verification-"));
  const config = join(directory, "wrangler.jsonc");
  const controller = new AbortController();
  const stop = () => controller.abort();
  let paging: ReturnType<typeof createPagingObserver> | undefined;
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    writeFileSync(config, JSON.stringify({ account_id: profile.account }), { mode: 0o600 });
    try {
      paging = createPagingObserver({
        log,
        source,
        expectedCommit: options.expectedCommit,
        env: process.env,
        ...(process.env.RUNNER_TEMP ? { artifactFile: join(process.env.RUNNER_TEMP, "paging-diagnostic.json") } : {}),
      });
    } catch {
      /* Diagnostic failure cannot alter verification. */
    }
    const target = { account: profile.account, dir: worker.dir, gate: worker.liveGate, config, source };
    const deps = { ...defaultSandboxGateDeps, signal: controller.signal };
    return "inspect" in options
      ? await inspectSandboxOnce(options, target, deps, paging?.observe)
      : await verifySandboxOnce(options, target, deps, paging?.observe);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    paging?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
