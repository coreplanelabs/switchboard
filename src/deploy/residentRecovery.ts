import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createHash } from "node:crypto";
import { sameResidentImageTarget, type ResidentImageTarget } from "./residentMaintenance.js";
import type { PostAnswer } from "./residentDrain.js";
import { reconciledResources, residentImageReportsProblem } from "./residentReadiness.js";
import { rolloutTargetFromDeployOutput } from "./sandboxLiveGate.js";

export interface ResidentRecoveryPlan {
  commit: string;
  workerVersion: string;
  fence: Record<string, unknown>;
  imageTarget: ResidentImageTarget;
}

/** The host reads the original terminal CI run and its immutable artifact. */
export function qualifyResidentRecovery(input: {
  repository: string;
  account: string;
  script: string;
  hostname: string;
  controller: unknown;
  artifactPlan: unknown;
  log: string;
  observed: ResidentRecoveryObservation;
}): ResidentRecoveryPlan {
  const controller = z
    .object({
      status: z.literal("completed"),
      conclusion: z.enum(["failure", "cancelled", "timed_out"]),
      path: z.literal(".github/workflows/deploy-staging.yml"),
      repository: z.object({ full_name: z.string() }),
    })
    .parse(input.controller);
  const artifact = z
    .object({
      root: z.object({ mode: z.literal("checkout"), commit: z.string().regex(/^[a-f0-9]{40}$/) }),
      profile: z.object({
        selection: z.object({
          account: z.string(),
          workers: z.object({ resident: z.object({ script: z.string(), hostname: z.string() }) }),
        }),
      }),
    })
    .parse(input.artifactPlan);
  const profile = artifact.profile.selection;
  if (
    controller.repository.full_name !== input.repository ||
    profile.account !== input.account ||
    profile.workers.resident.script !== input.script ||
    profile.workers.resident.hostname !== input.hostname
  )
    throw new Error("Original deployment scope changed");
  const marker = `[deploy:all] ▶ resident (${input.script})`;
  const at = input.log.lastIndexOf(marker);
  if (at < 0) throw new Error("Original Resident upload receipt is missing");
  const section = input.log.slice(at).split(/\n\[deploy:all\] ▶ /)[0];
  const version = /Current Version ID: ([a-f0-9-]{36})/.exec(section)?.[1];
  const acquisition = /\[resident-deploy-fence-acquisition\] (\{[^\n]+\})/.exec(section)?.[1];
  const id = acquisition
    ? z.object({ id: z.string().uuid(), phase: z.literal("requested") }).parse(JSON.parse(acquisition)).id
    : undefined;
  const intended = rolloutTargetFromDeployOutput(section, `${input.script}-residentdo`);
  const fence = fenceSchema.parse(input.observed.registry.draining);
  const image = input.observed.imageTarget;
  if (
    !section.includes(`[build-stamp] ${artifact.root.commit} @`) ||
    !version ||
    version !== input.observed.workerVersion ||
    artifact.root.commit !== input.observed.commit ||
    id !== fence.swapAcquisitionId ||
    fence.swapVersion === version ||
    image.application !== `${input.script}-residentdo` ||
    intended?.image !== image.image ||
    !image.image.startsWith(`registry.cloudflare.com/${input.account}/${input.script}-residentdo@sha256:`)
  )
    throw new Error("Original upload and current native target do not agree");
  return { commit: artifact.root.commit, workerVersion: version, fence, imageTarget: image };
}

/** Fixed field order makes a preview stable across native JSON key order. */
export function residentRecoveryHash(plan: ResidentRecoveryPlan): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        commit: plan.commit,
        workerVersion: plan.workerVersion,
        fence: fenceSchema.parse(plan.fence),
        imageTarget: {
          application: plan.imageTarget.application,
          version: plan.imageTarget.version,
          image: plan.imageTarget.image,
        },
      }),
    )
    .digest("hex");
}

export interface ResidentRecoveryObservation {
  commit: string;
  workerVersion: string;
  imageTarget: ResidentImageTarget;
  registry: Record<string, unknown>;
}

export interface ResidentRecoveryIO {
  observe(): Promise<ResidentRecoveryObservation>;
  record(phase: string, detail?: unknown): Promise<void>;
  reconcile(target: ResidentImageTarget): Promise<PostAnswer>;
  reopen(): Promise<PostAnswer>;
}

const fenceSchema = z
  .object({
    since: z.string().datetime(),
    until: z.string().datetime(),
    by: z.string().min(1).max(80),
    reason: z.string().max(200),
    swapFence: z.literal(true),
    swapVersion: z.string().uuid(),
    swapAt: z.string().datetime(),
    swapBuild: z.string().min(1),
    swapAcquisitionId: z.string().uuid(),
  })
  .strict();

function observationProblem(plan: ResidentRecoveryPlan, seen: ResidentRecoveryObservation): string | undefined {
  if (
    seen.commit !== plan.commit ||
    seen.workerVersion !== plan.workerVersion ||
    !sameResidentImageTarget(seen.imageTarget, plan.imageTarget)
  )
    return "selected-upload-changed";
  if (!isDeepStrictEqual(seen.registry.draining, plan.fence)) return "selected-fence-changed";
  const maintenance = seen.registry.stagingMaintenance;
  if (maintenance !== null && maintenance !== undefined) return "staging-maintenance-present";
  if (
    seen.registry.inFlight !== 0 ||
    seen.registry.inFlightUnknown !== 0 ||
    !Array.isArray(seen.registry.residents) ||
    seen.registry.count !== seen.registry.residents.length
  )
    return "resident-work-unverified";
  return undefined;
}

/** Finish only the selected upload. There is deliberately no upload operation. */
export async function recoverResidentDeployment(
  plan: ResidentRecoveryPlan,
  io: ResidentRecoveryIO,
): Promise<{ state: "reopened" | "held"; reason?: string }> {
  const held = (reason: string) => ({ state: "held" as const, reason });
  const fence = fenceSchema.safeParse(plan.fence);
  if (
    !/^[a-f0-9]{40}$/.test(plan.commit) ||
    !z.string().uuid().safeParse(plan.workerVersion).success ||
    !fence.success ||
    fence.data.swapVersion === plan.workerVersion ||
    !sameResidentImageTarget(plan.imageTarget, plan.imageTarget)
  )
    return held("recovery-plan-invalid");
  const initial = observationProblem(plan, await io.observe());
  if (initial) return held(initial);

  // Save intent before each effect. The host refuses an existing journal so a
  // lost reply cannot turn another invocation into an implicit retry.
  await io.record("reconcile-requested");
  const answer = await io.reconcile(plan.imageTarget);
  const resources = reconciledResources(answer);
  if (
    resources === undefined ||
    !("body" in answer) ||
    !sameResidentImageTarget(answer.body.imageTarget, plan.imageTarget) ||
    !z.array(z.object({ verified: z.literal(true) })).safeParse(answer.body.reconciled).success
  ) {
    await io.record("reconcile-unverified");
    return held("reconcile-unverified");
  }
  await io.record("reconcile-answered", { resources });
  const current = await io.observe();
  const changed = observationProblem(plan, current);
  if (changed) return held(changed);
  if (residentImageReportsProblem({ status: 200, body: current.registry }, resources, plan.imageTarget))
    return held("reconciled-images-unverified");

  await io.record("reopen-requested");
  const reopened = await io.reopen();
  if (
    !("body" in reopened) ||
    reopened.status !== 200 ||
    reopened.body.draining !== null ||
    reopened.body.cleared !== true
  ) {
    await io.record("reopen-unverified");
    return held("reopen-unverified");
  }
  await io.record("reopen-answered");
  const final = await io.observe();
  if (
    final.commit !== plan.commit ||
    final.workerVersion !== plan.workerVersion ||
    !sameResidentImageTarget(final.imageTarget, plan.imageTarget) ||
    final.registry.draining !== null ||
    final.registry.inFlight !== 0 ||
    final.registry.inFlightUnknown !== 0 ||
    residentImageReportsProblem({ status: 200, body: final.registry }, resources, plan.imageTarget)
  )
    return held("reopen-readback-unverified");
  await io.record("reopened");
  return { state: "reopened" };
}
