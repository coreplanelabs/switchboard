import { sameCommit, servedCommit, type HealthzBody } from "./liveGate.js";
import type { DeployPlan, DeployStep } from "./plan.js";
import { DEPLOY_FORCE_ENV } from "./plan.js";

// A deploy never rolls an older build over a newer one (release-and-deploy.md
// item 32). The deploy-production concurrency group queues a second deploy
// instead of racing it (item 2) — but a queued re-run of an OLDER release's
// failed deploy still runs after the newer release went live, and would roll
// every Worker one release back with /healthz reporting the older commit as
// "live". So before anything uploads, `deploy all` reads each selected
// Worker's live `/healthz` `build.commit` and refuses a Worker whose live
// commit already CONTAINS the commit being deployed (`git merge-base
// --is-ancestor <deploying> <live>`): that release is superseded. `--force`
// (or the force env set to 1) overrides for a deliberate rollback, with a
// warning that says so. The guard refuses only what it can prove: a live
// commit it cannot read, or an ancestry git cannot answer (an unknown sha, a
// `-dirty` or `unknown` build), deploys as before — the live gates own those
// cases. Ancestry is the checkout's git's to answer; from the published
// package there is no git, so nothing is judged. No node:* imports — the
// runner (src/deploy/run.ts) supplies the reads.

/** What the guard reads from the world — the runner's real fetch and git, faked in tests. */
export interface SupersedeReads {
  env: Record<string, string | undefined>;
  /** GET a Worker's `/healthz` (with the bearer `bearerEnv` names, when it names one);
   *  the parsed body, or undefined when unreachable, not 2xx, or not JSON. */
  readLive(url: string, bearerEnv?: string): Promise<HealthzBody | undefined>;
  /** `git merge-base --is-ancestor <deploying> <live>`: exit 0 → true, exit 1 → false,
   *  anything else (an unknown commit, no git) → undefined. */
  liveContains(deploying: string, live: string): Promise<boolean | undefined>;
}

/** Where a step's live `build.commit` is read from: its live gate's `/healthz` (the
 *  sandbox's with its bearer), the preflight heartbeat's, or the wake URL — every
 *  Worker carries one of the three (src/deploy/plan.ts `planDeploy`). */
export function stepHealth(step: DeployStep): { url: string; bearerEnv?: string } | undefined {
  if (step.liveGate)
    return step.liveGate.kind === "sandbox"
      ? { url: step.liveGate.healthUrl, bearerEnv: step.liveGate.bearerEnv }
      : { url: step.liveGate.healthUrl };
  const url = step.healthUrl ?? step.wakeUrl;
  return url === undefined ? undefined : { url };
}

/** What the guard found: the refusals (each names both commits), and the warnings
 *  a forced rollback prints instead of refusing. */
export interface SupersedeOutcome {
  problems: string[];
  notes: string[];
}

/**
 * The supersede guard, over every planned step: refuse a Worker whose live
 * build already contains the commit being deployed — deploying would roll it
 * backwards — naming both commits and the way out (nothing to re-run: the
 * newer release carries this one). Equal or older live commits proceed; so
 * does anything the guard cannot prove. Forced (`--force`, or the force env),
 * each would-be refusal becomes a note: a deliberate rollback.
 */
export async function supersededSteps(
  plan: Pick<DeployPlan, "steps" | "force" | "root">,
  deploying: string,
  reads: SupersedeReads,
): Promise<SupersedeOutcome> {
  const problems: string[] = [];
  const notes: string[] = [];
  if (plan.root.mode !== "checkout") return { problems, notes };
  const forced = plan.force || reads.env[DEPLOY_FORCE_ENV] === "1";
  for (const step of plan.steps) {
    const health = stepHealth(step);
    if (!health) continue;
    const body = await reads.readLive(health.url, health.bearerEnv);
    const live = body ? servedCommit(body) : undefined;
    if (live === undefined || sameCommit(live, deploying)) continue;
    if ((await reads.liveContains(deploying, live)) !== true) continue;
    const pair = `${step.name} is live on ${live.slice(0, 7)} which already contains ${deploying.slice(0, 7)}`;
    if (forced)
      notes.push(
        `${pair} — deploying anyway (${plan.force ? "--force" : `${DEPLOY_FORCE_ENV}=1`}): a deliberate rollback`,
      );
    else problems.push(`refused: ${pair}; this release is superseded — re-run nothing, the newer release carries it`);
  }
  return { problems, notes };
}
