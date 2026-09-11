// The refresh cycle as a Workflow instance (docs/reference/specs/resident-repos.md
// item 7): the `ResidentRefresh` entrypoint the Workflows binding names, the
// watchdog cron's instance-creation duty (`createRefreshInstance`), the admin
// `refresh-now` op's on-demand creation (`createRefreshInstanceNow`) and the
// existence probe a duplicate-id refusal is confirmed with. The steps' own
// work stays in worker.ts as the Durable Object's `refreshInstance*` methods:
// this module only sequences them through the DO stub. The entry re-exports
// the class (the binding resolves `class_name` against the entry module), and
// nothing here imports the entry at runtime — the shared pieces come from
// shared.ts, the entry's types `type`-only.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { systemClock } from "../../src/core/trace/clock.js";
import { startAdoptedRoot } from "../../src/core/trace/workerTrace.js";
import {
  REFRESH_STEP_RETRIES,
  refreshCycleBlocked,
  refreshInstanceId,
  shouldCreateRefreshInstance,
  stepTimeoutMs,
  type RefreshRow,
} from "../../src/execution/residentInstanceId.js";
import { RESTORE_MAX_MS, type RefreshPlan } from "../../src/execution/residentRefresh.js";
import { residentText } from "../../src/execution/residentText.js";
import { graftResidentSteps } from "../../src/execution/residentTrace.js";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  DEPS_STEP_OVERHEAD_MS,
  errMsg,
  GIT_NETWORK_TIMEOUT_MS,
  IDLE_REFRESH_INTERVAL_S,
  R2_TRANSFER_TIMEOUT_MS,
  REFRESH_BUILD_TIMEOUT_MS,
  REFRESH_INSTALL_TIMEOUT_MS,
  REFRESH_INTERVAL_S,
  residentStub,
  THREAD_POOL_SIZE,
  tracer,
  traceSinks,
} from "./shared";
import type { Env, InstanceStepTrace } from "./worker";

/** What a refresh instance is created with: the resident it runs for. Every
 *  other input is read from the resident's rows at each step, never carried. */
export interface RefreshInstanceParams {
  resource: string;
}

/** What a creator did about one resident's refresh instance. */
export interface RefreshInstanceAction {
  id: string;
  action: "created" | "duplicate" | "skipped" | "failed";
  why: string;
}

/** The refresh instance's step budgets: each `step.do` timeout is the DO
 *  method's own budget, capped at the engine's 30-minute step ceiling
 *  (`stepTimeoutMs`), so a step timeout and a command timeout agree. */
const REFRESH_FETCH_STEP_BUDGET_MS = RESTORE_MAX_MS + GIT_NETWORK_TIMEOUT_MS; // a wake's restore, then the fetch
const REFRESH_INSTALL_STEP_BUDGET_MS = REFRESH_INSTALL_TIMEOUT_MS + DEPS_STEP_OVERHEAD_MS; // the install's own lease
const REFRESH_BUILD_STEP_BUDGET_MS = GIT_NETWORK_TIMEOUT_MS + REFRESH_BUILD_TIMEOUT_MS; // the build's mutex lease
const REFRESH_SNAPSHOT_STEP_BUDGET_MS = R2_TRANSFER_TIMEOUT_MS + GIT_NETWORK_TIMEOUT_MS; // the archives, then the reclaim pass
/** The sweep: one cleanliness check per binding idle past an hour (at most the
 *  pool's worth, one exec budget each), then the removals under the mirror lock. */
const REFRESH_SWEEP_STEP_BUDGET_MS = THREAD_POOL_SIZE * DEFAULT_EXEC_TIMEOUT_MS + GIT_NETWORK_TIMEOUT_MS;
/** The measurement: `df`, the `du` over the parts and the store's listing (one
 *  network-class budget each), then the store's removals. */
const REFRESH_MEASURE_STEP_BUDGET_MS = 2 * GIT_NETWORK_TIMEOUT_MS + DEFAULT_EXEC_TIMEOUT_MS;

/** Whether the engine knows an instance by this id, in any status. A missing
 *  id rejects on `get` or on `status`; either way the answer is false. */
async function refreshInstanceExists(env: Env, id: string): Promise<boolean> {
  try {
    await (await env.RESIDENT_REFRESH.get(id)).status();
    return true;
  } catch {
    return false;
  }
}

/** The deterministic id for this resident's current bucket. */
function bucketInstanceId(resource: string, nowMs: number): string {
  const slug = resource.slice("repo:".length);
  const slash = slug.indexOf("/");
  return refreshInstanceId(slug.slice(0, slash), slug.slice(slash + 1), nowMs);
}

/** Create the instance `id` for `resource` and record the outcome on the row.
 *  The engine refuses an id that names an instance still inside its retention,
 *  and the refusal carries no code — so the id is asked, not the wording: an
 *  instance that answers for it exists, and the refusal was the duplicate it
 *  looks like. Any other failure stays a failure. */
async function createInstance(
  env: Env,
  stub: ReturnType<typeof residentStub>,
  resource: string,
  id: string,
  nowMs: number,
  why: string,
): Promise<RefreshInstanceAction> {
  try {
    await env.RESIDENT_REFRESH.create({ id, params: { resource } });
  } catch (err) {
    const message = errMsg(err);
    if (await refreshInstanceExists(env, id)) {
      await stub.recordRefreshSkipped(id, nowMs, "duplicate");
      return { id, action: "duplicate", why: "duplicate" };
    }
    console.error(`resident-watchdog: creating refresh instance ${id} failed — ${message}`);
    return { id, action: "failed", why: residentText(message) };
  }
  await stub.recordRefreshInstance(id, nowMs);
  console.log(`resident-watchdog: created refresh instance ${id} (${why})`);
  return { id, action: "created", why };
}

/** The cron's instance-creation duty for one resident (item 7): at most one
 *  instance per ten-minute bucket, never while a cycle is live, only once the
 *  cadence has elapsed (`shouldCreateRefreshInstance`); the id is
 *  deterministic per resident and bucket, so a second firing in one bucket
 *  meets the engine's duplicate-id refusal, which is the expected no-op. A
 *  skipped live cycle and a duplicate are recorded on the row for `/status`. */
export async function createRefreshInstance(
  env: Env,
  stub: ReturnType<typeof residentStub>,
  resource: string,
  row: RefreshRow,
): Promise<RefreshInstanceAction> {
  const now = systemClock();
  const decision = shouldCreateRefreshInstance(row, now, {
    intervalS: REFRESH_INTERVAL_S,
    idleIntervalS: IDLE_REFRESH_INTERVAL_S,
  });
  const id = bucketInstanceId(resource, now);
  if (!decision.create) {
    if (decision.why === "mid-cycle" || decision.why === "running")
      await stub.recordRefreshSkipped(id, now, decision.why);
    return { id, action: "skipped", why: decision.why };
  }
  return createInstance(env, stub, resource, id, now, decision.why);
}

/** The admin `refresh-now` op (item 13): this bucket's instance, created now,
 *  due or not — the cycle the cron would create at its next firing, started
 *  on demand. Never beside a live cycle (`refreshCycleBlocked`: a running
 *  instance, a young `refreshing` marker, a resident that is not serving —
 *  answered `skipped` with the why), and under the bucket's deterministic id,
 *  so a bucket the cron already served answers `duplicate` naming that
 *  instance: the next bucket is at most ten minutes away. */
export async function createRefreshInstanceNow(
  env: Env,
  stub: ReturnType<typeof residentStub>,
  resource: string,
): Promise<RefreshInstanceAction> {
  const now = systemClock();
  const id = bucketInstanceId(resource, now);
  const blocked = refreshCycleBlocked(await stub.refreshRow(), now);
  if (blocked) return { id, action: "skipped", why: blocked };
  return createInstance(env, stub, resource, id, now, "refresh-now");
}

/** What an instance answers when it ends: small facts for the engine's record. */
interface RefreshInstanceSummary {
  instance: string;
  /** `ok`, or the word a gate or a failure ended the cycle with. */
  outcome: string;
  /** The step the cycle's verdict came from. */
  step: "fetch" | "install" | "build" | "snapshot";
  action?: RefreshPlan["action"];
  sha?: string;
  /** The housekeeping steps' answers, when they ran. */
  swept?: { evicted: number; kept: number } | null;
  measured?: boolean;
}

/** One refresh cycle as one short Workflow instance: `fetch`, `install` (only
 *  when the plan moved the lockfile key), `build` (only when the branch
 *  moved), `snapshot`, then the housekeeping `sweep` (the worktree
 *  inactivity eviction, item 23) and `measure` (the disk sample, item 55) —
 *  each a `step.do` calling the resident's own step method through the DO
 *  stub, under the retry policy `REFRESH_STEP_RETRIES` (six attempts, thirty
 *  seconds apart, doubling: about 15.5 minutes, past the 3 to 10 minutes a
 *  resident Worker rollover takes to settle) and a timeout equal to the
 *  method's own budget (never above the engine's 30 minutes). Inputs to a
 *  step are the event's `resource`, the instance id and previous steps'
 *  returns — refs, shas, a key, a path — never a payload and never a
 *  credential. A step killed from outside (the container replaced under it)
 *  throws and the engine retries it into the same idempotent method; so does
 *  a gate that stopped the container on purpose (a stale image, a disk-full
 *  recycle) — the retry finds the container back and continues the cycle. A
 *  gate that ends the cycle (idle, an offboard) or a failure of the
 *  repository's own (recorded as `degraded`, the last snapshot still serving)
 *  ends the cycle with that word; the housekeeping steps still run for every
 *  verdict but an offboard (nothing is left to keep), and neither wakes a
 *  slept container. The instance runs one cycle and returns: it is created by
 *  the watchdog cron per resident and ten-minute bucket
 *  (`createRefreshInstance`) or by the admin `refresh-now` op, never a loop;
 *  the next cron firing creates the next one from the row's state.
 *
 *  The run is the cycle's root span, `resident.refresh` carrying the instance
 *  id (docs/reference/specs/tracing.md item 25), with every command a step ran
 *  grafted under it as a `resident.<step>` child. */
export class ResidentRefresh extends WorkflowEntrypoint<Env, RefreshInstanceParams> {
  async run(
    event: Readonly<WorkflowEvent<RefreshInstanceParams>>,
    step: WorkflowStep,
  ): Promise<RefreshInstanceSummary> {
    const { resource } = event.payload;
    const instance = event.instanceId;
    const stub = residentStub(this.env, resource);
    const root = startAdoptedRoot(tracer, "resident.refresh", {
      sinks: traceSinks,
      startedAt: event.timestamp.getTime(),
      attrs: { instanceId: instance },
    });
    const graft = (answer: InstanceStepTrace) =>
      graftResidentSteps(answer.trace, {
        parent: root,
        prefix: "resident",
        baseAt: answer.startedAt,
        clipAt: systemClock(),
      });
    const retries = REFRESH_STEP_RETRIES;
    /** The word a step that did not finish ends the cycle with. */
    const ended = (
      at: RefreshInstanceSummary["step"],
      answer: { status: "stopped"; why: string } | { status: "failed"; reason: string },
    ): RefreshInstanceSummary => ({
      instance,
      outcome: answer.status === "stopped" ? answer.why : "failed",
      step: at,
    });
    let summary: RefreshInstanceSummary | undefined;
    try {
      let cycle: RefreshInstanceSummary | undefined;
      const fetched = await step.do("fetch", { retries, timeout: stepTimeoutMs(REFRESH_FETCH_STEP_BUDGET_MS) }, () =>
        stub.refreshInstanceFetch({ resource, instance }),
      );
      graft(fetched);
      if (fetched.status !== "done") cycle = ended("fetch", fetched);
      else {
        let depsEntry: string | null = null;
        if (fetched.install) {
          const installed = await step.do(
            "install",
            { retries, timeout: stepTimeoutMs(REFRESH_INSTALL_STEP_BUDGET_MS) },
            () =>
              stub.refreshInstanceInstall({ resource, instance, sha: fetched.sha, lockfileKey: fetched.lockfileKey }),
          );
          graft(installed);
          if (installed.status !== "done") cycle = ended("install", installed);
          else depsEntry = installed.entry;
        }
        if (cycle === undefined && fetched.action !== "unchanged") {
          const built = await step.do("build", { retries, timeout: stepTimeoutMs(REFRESH_BUILD_STEP_BUDGET_MS) }, () =>
            stub.refreshInstanceBuild({
              resource,
              instance,
              sha: fetched.sha,
              factsSha: fetched.factsSha,
              lockfileKey: fetched.lockfileKey,
              depsEntry,
            }),
          );
          graft(built);
          if (built.status !== "done") cycle = ended("build", built);
        }
        if (cycle === undefined) {
          const snapped = await step.do(
            "snapshot",
            { retries, timeout: stepTimeoutMs(REFRESH_SNAPSHOT_STEP_BUDGET_MS) },
            () =>
              stub.refreshInstanceSnapshot({
                resource,
                instance,
                ref: fetched.ref,
                sha: fetched.sha,
                lockfileKey: fetched.lockfileKey,
                action: fetched.action,
                mintError: fetched.mintError,
              }),
          );
          graft(snapped);
          cycle =
            snapped.status !== "done"
              ? ended("snapshot", snapped)
              : { instance, outcome: "ok", step: "snapshot", action: fetched.action, sha: fetched.sha };
        }
      }
      // Housekeeping rides on every instance whatever the cycle's verdict — a
      // parked resident still releases its idle bindings and re-measures, and
      // neither step wakes a slept container — except an offboarded one:
      // nothing is left to keep.
      if (cycle.outcome !== "offboarded") {
        const swept = await step.do("sweep", { retries, timeout: stepTimeoutMs(REFRESH_SWEEP_STEP_BUDGET_MS) }, () =>
          stub.refreshInstanceSweep({ resource, instance }),
        );
        graft(swept);
        const measured = await step.do(
          "measure",
          { retries, timeout: stepTimeoutMs(REFRESH_MEASURE_STEP_BUDGET_MS) },
          () => stub.refreshInstanceMeasure({ instance }),
        );
        graft(measured);
        cycle = {
          ...cycle,
          swept:
            swept.status === "done" && swept.result
              ? { evicted: swept.result.evicted.length, kept: swept.result.kept }
              : null,
          measured: measured.status === "done" && measured.result !== null && measured.result.measured,
        };
      }
      return (summary = cycle);
    } catch (err) {
      // A step out of retries: the engine records the failed instance by id;
      // the row keeps its last state and the next cron firing starts the next cycle.
      root.fail(err);
      throw err;
    } finally {
      const outcome = summary?.outcome ?? "error";
      root.end(outcome === "ok" || (summary !== undefined && outcome !== "failed") ? "ok" : "error", { outcome });
    }
  }
}
