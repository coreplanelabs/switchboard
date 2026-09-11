// The refresh cycle as a Workflow instance (docs/reference/specs/resident-repos.md
// item 7): the `ResidentRefresh` entrypoint the Workflows binding names, the
// watchdog cron's instance-creation duty (`createRefreshInstance`) and the
// existence probe it confirms a duplicate-id refusal with. The steps' own work
// stays in worker.ts as the Durable Object's `refreshInstance*` methods: this
// module only sequences them through the DO stub. The entry re-exports the
// class (the binding resolves `class_name` against the entry module), and
// nothing here imports the entry at runtime — the shared pieces come from
// shared.ts, the entry's types `type`-only.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { systemClock } from "../../src/core/trace/clock.js";
import { startAdoptedRoot } from "../../src/core/trace/workerTrace.js";
import {
  REFRESH_STEP_RETRIES,
  refreshInstanceId,
  shouldCreateRefreshInstance,
  stepTimeoutMs,
  type RefreshRow,
} from "../../src/execution/residentInstanceId.js";
import { RESTORE_MAX_MS, type RefreshPlan } from "../../src/execution/residentRefresh.js";
import { residentText } from "../../src/execution/residentText.js";
import { graftResidentSteps } from "../../src/execution/residentTrace.js";
import {
  DEPS_STEP_OVERHEAD_MS,
  errMsg,
  GIT_NETWORK_TIMEOUT_MS,
  IDLE_REFRESH_INTERVAL_S,
  R2_TRANSFER_TIMEOUT_MS,
  REFRESH_BUILD_TIMEOUT_MS,
  REFRESH_INSTALL_TIMEOUT_MS,
  REFRESH_INTERVAL_S,
  residentStub,
  tracer,
  traceSinks,
} from "./shared";
import type { Env, InstanceStepTrace } from "./worker";

/** What a refresh instance is created with: the resident it runs for. Every
 *  other input is read from the resident's rows at each step, never carried. */
export interface RefreshInstanceParams {
  resource: string;
}

/** What the cron did about one resident's refresh instance this pass. */
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
const REFRESH_SNAPSHOT_STEP_BUDGET_MS = R2_TRANSFER_TIMEOUT_MS + GIT_NETWORK_TIMEOUT_MS; // the archives, then the reclaim pass and the disk sample

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

/** The cron's instance-creation duty for one resident (item 7). Only a
 *  `workflow` row gets an instance, at most one per ten-minute bucket, never
 *  while a cycle is live (`shouldCreateRefreshInstance`); the id is
 *  deterministic per resident and bucket, so a second firing in one bucket
 *  meets the engine's duplicate-id refusal, which is the expected no-op. A
 *  skipped live cycle and a duplicate are recorded on the row for `/status`.
 *  An `alarm` resident answers null: nothing here touches it. */
export async function createRefreshInstance(
  env: Env,
  stub: ReturnType<typeof residentStub>,
  resource: string,
  row: RefreshRow,
): Promise<RefreshInstanceAction | null> {
  if (row.lifecycle !== "workflow") return null;
  const now = systemClock();
  const decision = shouldCreateRefreshInstance(row, now, {
    intervalS: REFRESH_INTERVAL_S,
    idleIntervalS: IDLE_REFRESH_INTERVAL_S,
  });
  const slug = resource.slice("repo:".length);
  const slash = slug.indexOf("/");
  const id = refreshInstanceId(slug.slice(0, slash), slug.slice(slash + 1), now);
  if (!decision.create) {
    if (decision.why === "mid-cycle" || decision.why === "running")
      await stub.recordRefreshSkipped(id, now, decision.why);
    return { id, action: "skipped", why: decision.why };
  }
  try {
    await env.RESIDENT_REFRESH.create({ id, params: { resource } });
  } catch (err) {
    const message = errMsg(err);
    // The engine refuses an id that names an instance still inside its
    // retention, and the refusal carries no code — so the id is asked, not
    // the wording: an instance that answers for it exists, and the refusal
    // was the duplicate it looks like. Any other failure stays a failure.
    if (await refreshInstanceExists(env, id)) {
      await stub.recordRefreshSkipped(id, now, "duplicate");
      return { id, action: "duplicate", why: "duplicate" };
    }
    console.error(`resident-watchdog: creating refresh instance ${id} failed — ${message}`);
    return { id, action: "failed", why: residentText(message) };
  }
  await stub.recordRefreshInstance(id, now);
  console.log(`resident-watchdog: created refresh instance ${id}`);
  return { id, action: "created", why: decision.why };
}

/** What an instance answers when it ends: small facts for the engine's record. */
interface RefreshInstanceSummary {
  instance: string;
  /** `ok`, or the word a gate or a failure ended the cycle with. */
  outcome: string;
  step: "fetch" | "install" | "build" | "snapshot";
  action?: RefreshPlan["action"];
  sha?: string;
}

/** One refresh cycle as one short Workflow instance: `fetch`, `install` (only
 *  when the plan moved the lockfile key), `build` (only when the branch
 *  moved), `snapshot` — each a `step.do` calling the resident's own step
 *  method through the DO stub, under the retry policy `REFRESH_STEP_RETRIES`
 *  (six attempts, thirty seconds apart, doubling: about 15.5 minutes, past
 *  the 3 to 10 minutes a resident Worker rollover takes to settle) and a
 *  timeout equal to the method's own budget (never above the engine's 30
 *  minutes). Inputs to a step are the event's `resource`, the instance id and
 *  previous steps' returns — refs, shas, a key, a path — never a payload and
 *  never a credential. A step killed from outside (the container replaced
 *  under it) throws and the engine retries it into the same idempotent
 *  method; a gate that ends the cycle (idle, a container restart) or a
 *  failure of the repository's own (recorded as `degraded`, the last snapshot
 *  still serving) ends the instance with that word, and the next cron firing
 *  creates the next one from the row's state. The instance runs one cycle
 *  and returns: it is created by the watchdog cron per resident and
 *  ten-minute bucket (`createRefreshInstance`), never a loop.
 *
 *  The run is the cycle's root span, `resident.refresh` carrying the instance
 *  id (docs/reference/specs/tracing.md item 25), with every command a step ran
 *  grafted under it as a `resident.<step>` child — the same shape the alarm's
 *  root has. */
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
    /** The word a step that did not finish ends the instance with, and its outcome for the root. */
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
      const fetched = await step.do("fetch", { retries, timeout: stepTimeoutMs(REFRESH_FETCH_STEP_BUDGET_MS) }, () =>
        stub.refreshInstanceFetch({ resource, instance }),
      );
      graft(fetched);
      if (fetched.status !== "done") return (summary = ended("fetch", fetched));
      let depsEntry: string | null = null;
      if (fetched.install) {
        const installed = await step.do(
          "install",
          { retries, timeout: stepTimeoutMs(REFRESH_INSTALL_STEP_BUDGET_MS) },
          () => stub.refreshInstanceInstall({ resource, instance, sha: fetched.sha, lockfileKey: fetched.lockfileKey }),
        );
        graft(installed);
        if (installed.status !== "done") return (summary = ended("install", installed));
        depsEntry = installed.entry;
      }
      if (fetched.action !== "unchanged") {
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
        if (built.status !== "done") return (summary = ended("build", built));
      }
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
      if (snapped.status !== "done") return (summary = ended("snapshot", snapped));
      return (summary = { instance, outcome: "ok", step: "snapshot", action: fetched.action, sha: fetched.sha });
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
