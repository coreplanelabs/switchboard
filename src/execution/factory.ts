import { resolve } from "node:path";
import { FIRST_ATTACH_WAIT_MS, minutesToMs } from "../core/budgets.js";
import { RUN_DEADLINE_RESERVE_MS, attachBoundWithinRun } from "./bashTimeout.js";
import { oneLine } from "../core/redact.js";
import type { Backend } from "../core/trace/attrs.js";
import type { Span } from "../core/trace/types.js";
import type { ResidentLiveStateObserver } from "../core/runLiveState.js";
import type { ResidentStep } from "./residentStepTrace.js";
import { residentTraceOf, type ResidentTrace } from "./residentTrace.js";
import { mkdirSync } from "node:fs";
import type { AgentDef, Identity, MachineClass } from "../agents/registry.js";
import type { RunProfile } from "../config/profile.js";
import { LocalExecutor, execDeadline, isDeadlineMiss, isRunStopError, type Executor } from "./executor.js";
import { E2BExecutor } from "./e2b.js";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";
import {
  SEED_CHECKOUT_DIR,
  seedForThread,
  seedDoorRemote,
  seedRetryDecision,
  seededSandboxNote,
  readyEnvironmentCommand,
  readyEnvironmentOutcome,
  type ReadyEnvironmentRequirement,
  type SandboxSeed,
  type SeedAnswer,
  type SeedHandle,
  type SeededSandbox,
} from "./seedPlan.js";
import {
  DRAIN_FALLBACK_WAIT_MS,
  drainWaitOf,
  ResidentExecutor,
  ResidentLeaseSpentError,
  ResidentNeedsRefError,
  ResidentRegistrationMismatchError,
  waitOnStatus,
  wakeStopped,
  type ResidentBinding,
  type ResidentExecutorOptions,
  type ResidentStatusProbe,
} from "./resident.js";
import { repoResourceId } from "../core/residentAdmin.js";
import { nearMatch } from "../core/nearMatch.js";
import { githubAppConfigured, resolveGithubIdentity, type GithubTokenScope } from "./githubApp.js";
import { bindingOf, type BindingSource } from "./authorBinding.js";
import { pairOfBinding, requesterPairFor } from "./identityRewrite.js";
import { isServiceable } from "./residentState.js";
import { systemClock } from "../core/trace/clock.js";
import { processSecrets, type Secret, type Secrets } from "../secrets.js";
import { shellQuote } from "./shellQuote.js";
import { parseRevParseOutput } from "../core/reviewedHead.js";

export interface ResidentExecutionConfig {
  /** base URL of the resident Worker (deploy/cloudflare-resident/) */
  baseUrl: string;
  /** env var holding the operator bearer (default RESIDENT_OPERATOR_TOKEN) */
  tokenEnv?: string;
  /** env var holding the ADMIN bearer for `repo onboard/offboard/...` chat
   *  commands (default RESIDENT_ADMIN_TOKEN). Unset env = repo-management
   *  commands answer with a named configuration error; runs are unaffected. */
  adminTokenEnv?: string;
  /** /status probe deadline in ms (default `PROBE_TIMEOUT_MS`, 8000); a probe
   *  that misses it = not warm for this dispatch, never an outage. */
  probeTimeoutMs?: number;
}

export interface ExecutionConfig {
  /**
   * "local" (default): run tools on the bot host.
   * "e2b": per-thread E2B micro-VM.
   * "cloudflare": per-thread Cloudflare Sandbox via the proxy Worker
   *   (deploy/cloudflare-sandbox/).
   */
  type?: "local" | "e2b" | "cloudflare";
  /** env var holding the sandbox provider API key/token (e2b, cloudflare) */
  apiKeyEnv?: string;
  /** sandbox idle lifetime in minutes (e2b only, default 30) */
  timeoutMinutes?: number;
  /** base URL of the sandbox proxy Worker (cloudflare only) */
  url?: string;
  /**
   * Resident repo environments (deploy/cloudflare-resident/): when set AND
   * the request resolved a target repo (ctx.repo) for a `repo-resident` run,
   * a warm resident serves the thread; any other resident state falls back to
   * the per-thread backend above with a named note. No ctx.repo → per-thread,
   * no probe. The `blank` and `repo-cold` classes never consult it.
   */
  resident?: ResidentExecutionConfig;
}

export interface GithubCredentialProvider {
  /** Test seam for profile validation; model workspaces never receive an App token. */
  assertProfileIdentity(identity: Identity, machine: MachineClass): void;
}

export interface ExecutorFactoryOptions {
  execution?: ExecutionConfig;
  workspaceDir: string; // local mode: base dir for per-thread workspaces
  dataDir: string; // e2b mode: where the thread->sandbox map is persisted
  /** Where a requester's stored GitHub binding is read (`ConfigStore`):
   *  `gitIdentityEnvs` resolves the author pair from it (record 0062). Absent
   *  (a test, a caller without config), no binding is read and the bot pair
   *  authors. */
  bindings?: BindingSource;
  /** Profile validation seam. Production checks the App; tests may inject it. */
  githubCredentials?: GithubCredentialProvider;
}

/** What executor selection knows about the run it is provisioning for.
 *  The profile's machine class decides what is provisioned and its identity
 *  whom the machine acts as; repo/ref carry resident-repo inference (populated
 *  by the dispatcher's repo resolver; undefined means the per-thread path, no
 *  probe). */
export interface ExecutorContext {
  threadKey: string;
  /** Durable run identity; an old lease update may only change its own registration. */
  runId?: string;
  /** Process generation owning the durable run. */
  ownerGen?: string;
  /** Minted by the durable run ledger after confirming this run's current owner. */
  residentClaim?: () => Promise<number | undefined>;
  /** Time left for setup before the harness may start its separate run lease. */
  setupRemainingMs?: () => number;
  /** Run-bound credential accepted only by the trusted GitHub door. */
  githubDoor?: { baseUrl: string; bearer: string; ghConfigDir?: string };
  /** the resolved agent (never mutated here) — named in the null executor's error */
  agent: AgentDef;
  /** The run's EFFECTIVE profile (docs/decisions/0026-capability-profiles-and-request-routing.md):
   *  the class provisioned and the identity minted are read from here and
   *  never from `agent`, so nothing a boundary capped can leak back in. */
  profile: RunProfile;
  /** inferred target repo, e.g. "org/name" */
  repo?: string;
  /** inferred git ref within `repo` */
  ref?: string;
  /** the commit `ref` is expected to be at (a resolved PR head) — the resident
   *  fetches a mirror whose tip lags it (docs/reference/specs/resident-repos.md item 51) */
  headSha?: string;
  /** An opt-in pilot write gate, supplied by trusted admission from the
   * onboarded repository's test command. It runs before the model. A refused
   * gate is a typed hold for the caller to retain its original unit/brief. */
  readyEnvironment?: ReadyEnvironmentRequirement;
  /** The pull request the thread's OWN run opened, whose head branch `ref` is
   *  (`ownPrOf`; docs/reference/specs/resident-repos.md item 16): the one reason
   *  the resident may move a default-bound thread onto `ref` — the tree is
   *  then provisioned there, clean. Never a PR a person named. Absent for
   *  every other resolution, and never sent on a resume (the tree stays
   *  exactly as the run left it). */
  ownPr?: { number: number; ref: string };
  /** A resumed run's recorded binding (docs/reference/specs/run-history.md item 54):
   *  where the run's workspace is. Set, the factory re-attaches THERE and never
   *  provisions again: the recorded backend is the only one consulted, the
   *  resident is asked to keep the tree as it stands, and a refusal or an
   *  unreachable backend is a `WorkspaceReattachRefusedError`, never a fallback.
   *  Absent for every fresh run, which provisions as it always did. */
  reattach?: WorkspaceBinding;
  /** The run's hard stop (`RunControl.hardSignal`), where the caller has one:
   *  the first attach's wake wait ends at once on it, and a stopped run is
   *  never provisioned cold. Absent for a caller without a run control. */
  stopSignal?: AbortSignal;
  /** The run's remaining wall clock (`RunControl.remainingMs`; undefined until
   *  the harness starts the lease), where the caller has one: the resident
   *  executor built here carries it, so every attach it opens for the run's
   *  life — a recovery attach, the wake wait's re-attach — is clipped to the
   *  run (execution.md item 9). Absent for a caller without a run: the attach
   *  default alone bounds. */
  remainingMs?: () => number | undefined;
  /** The run's requester (the platform-namespaced user id), whose stored
   *  GitHub binding names the commits' author pair (record 0062;
   *  `gitIdentityEnvs`). Absent, the bot pair authors. */
  requester?: string;
  /** Awaited observations from the resident's two wait states. */
  onLiveStateObservation?: ResidentLiveStateObserver;
}

/** Where a run's workspace is (docs/reference/specs/run-history.md item 54):
 *  recorded on the run's ledger row at the claim (`state.binding`) and read
 *  back by the generation that resumes the run, so it re-attaches where the
 *  run ran instead of provisioning as for a new one. */
export interface WorkspaceBinding {
  /** The backend the run's commands execute on: the one a resume consults, and the only one. */
  backend: Backend;
  /** The worktree the resident bound for the thread; absent on a per-thread
   *  backend, whose workspace is the container's own. */
  workspace?: string;
  /** The pool user the resident runs the thread's commands as. */
  user?: string;
  /** The identity of the container the workspace is in (docs/reference/specs/harness-pi.md
   *  item 8), when the attach answered one: the resident's is its VM's boot id. */
  container?: string;
  /** A resident fallback's seed identity, retained so re-attach can verify the same checkout. */
  seeded?: Pick<SeededSandbox, "slug" | "ref" | "workspace">;
}

const BACKENDS: readonly Backend[] = ["local", "resident", "sandbox", "e2b"];

/** The binding a previous generation wrote on the row, when it has the shape
 *  this build reads; anything else is no binding (the run provisions afresh, once). */
export function workspaceBindingOf(value: unknown): WorkspaceBinding | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.backend !== "string" || !(BACKENDS as readonly string[]).includes(v.backend)) return undefined;
  const seed = typeof v.seeded === "object" && v.seeded !== null ? (v.seeded as Record<string, unknown>) : undefined;
  const seeded =
    v.backend === "sandbox" &&
    seed &&
    typeof seed.slug === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(seed.slug) &&
    typeof seed.ref === "string" &&
    seed.ref.length > 0 &&
    seed.ref.length <= 255 &&
    typeof seed.workspace === "string" &&
    seed.workspace === SEED_CHECKOUT_DIR
      ? { slug: seed.slug, ref: seed.ref, workspace: seed.workspace }
      : undefined;
  return {
    backend: v.backend as Backend,
    ...(typeof v.workspace === "string" && v.workspace ? { workspace: v.workspace } : {}),
    ...(typeof v.user === "string" && v.user ? { user: v.user } : {}),
    ...(typeof v.container === "string" && v.container ? { container: v.container } : {}),
    ...(seeded ? { seeded } : {}),
  };
}

/** The binding to record for a selection: the backend and, from a resident
 *  attach, the worktree, the pool user and the container. Nothing for a class
 *  without a workspace (`none`): there is nothing to re-attach. */
export function workspaceBindingFor(
  selection: ExecutorSelection,
  machine: MachineClass = "repo-resident",
): WorkspaceBinding | undefined {
  if (machine === "none" || selection.backend === undefined) return undefined;
  const b = selection.binding;
  return {
    backend: selection.backend,
    ...(b?.workspace !== undefined ? { workspace: b.workspace } : {}),
    ...(b?.user !== undefined ? { user: b.user } : {}),
    ...(b?.container !== undefined ? { container: b.container } : {}),
    ...(selection.backend === "sandbox" && selection.seeded
      ? {
          seeded: {
            slug: selection.seeded.slug,
            ref: selection.seeded.ref,
            workspace: selection.seeded.workspace,
          },
        }
      : {}),
  };
}

/** A resumed run's workspace could not be re-attached where its row says it
 *  ran (docs/reference/specs/run-history.md item 54): the resident refused to
 *  keep the tree, could not be reached or cannot serve, or its answer named
 *  another tree than the run's. Nothing else was provisioned (the run's work
 *  is on that backend or nowhere, so no other backend is tried), and the
 *  dispatcher restarts the run from its request, saying why. */
export class WorkspaceReattachRefusedError extends Error {
  constructor(
    readonly recorded: WorkspaceBinding,
    readonly why: string,
  ) {
    super(`the run's workspace on the ${recorded.backend} backend could not be re-attached: ${why}`);
    this.name = "WorkspaceReattachRefusedError";
  }
}

export type ReadyEnvironmentReason =
  | "repository_unresolved"
  | "repository_not_onboarded"
  | "backend_unavailable"
  | "snapshot_missing"
  | "dependencies_missing"
  | "dependencies_stale"
  | "binding_mismatch"
  | "seed_failed"
  | "tool_missing"
  | "test_command_invalid"
  | "check_failed";

/** This refusal happens before a model turn. The delegation caller retains
 * the original task and brief, then retries this same admission after setup. */
export class ReadyEnvironmentError extends Error {
  readonly retryable = true;
  readonly beforeModel = true;

  constructor(
    readonly reason: ReadyEnvironmentReason,
    readonly nextAction: string,
  ) {
    super(`The coding environment is not ready (${reason.replaceAll("_", " ")}). ${nextAction}`);
    this.name = "ReadyEnvironmentError";
  }
}

const readyFailure = (reason: ReadyEnvironmentReason, nextAction: string): ReadyEnvironmentError =>
  new ReadyEnvironmentError(reason, nextAction);

/** The declared test command is parsed but never run here. Fixed markers keep
 * shell output, including possible workspace content, out of the refusal. */
async function checkReadyEnvironment(
  executor: Executor,
  workspace: string,
  requirement: ReadyEnvironmentRequirement,
  signal?: AbortSignal,
  seededFromSha?: string,
): Promise<void> {
  let command: string;
  try {
    command = readyEnvironmentCommand(workspace, requirement, seededFromSha);
  } catch {
    throw readyFailure(
      "test_command_invalid",
      "Correct the pilot repository's declared test command and tools, then retry this task.",
    );
  }
  let output: string;
  try {
    output = await executor.exec(command, { timeoutMs: 10_000, ...(signal ? { signal } : {}) });
  } catch (err) {
    if (isRunStopError(err)) throw err;
    throw readyFailure("check_failed", "Check the repository environment and retry this task on the same unit.");
  }
  const outcome = readyEnvironmentOutcome(output);
  if (outcome.ready) return;
  switch (outcome.reason) {
    case "dependencies_missing":
      throw readyFailure(
        "dependencies_missing",
        "Restore or install the repository dependencies, then retry this task.",
      );
    case "dependencies_stale":
      throw readyFailure(
        "dependencies_stale",
        "Install dependencies for the exact target head, then retry this task on the same unit.",
      );
    case "tool_missing":
      throw readyFailure(
        "tool_missing",
        `Make ${outcome.tool} available in the repository image, then retry this task.`,
      );
    case "test_command_invalid":
      throw readyFailure(
        "test_command_invalid",
        "Correct the repository's declared test command, then retry this task.",
      );
    default:
      throw readyFailure("check_failed", "Check the repository environment and retry this task on the same unit.");
  }
}

/** A resumed run's re-attach not opened, or not finished: the run's lease is
 *  inside its write-up reserve, or under what an attach needs past it
 *  (`attachBoundWithinRun` says `exhausted`; execution.md item 9) — read at the
 *  entry, again after the probe's wait, and off the executor's own
 *  `ResidentLeaseSpentError` when the lease ran out under the attach's wake
 *  wait — so no request was made or none more will be: the resident would run
 *  an attach to its end for a run that is ending. Not a refusal: the caller
 *  ends the run on its budget instead of restarting it from its request.
 *  `leftMs` is the run's wall clock when it was decided and `note` the bound's
 *  own sentence for it (`attachBoundWithinRun`'s, the one source — worded by
 *  the bound that refused), which the relaunch's record carries on. Thrown
 *  only where the lease has started (a relaunch's re-attach carries the run's
 *  clock); a dispatch-time resume, before the lease, never meets it. */
export class WorkspaceReattachLeaseSpentError extends Error {
  constructor(
    readonly recorded: WorkspaceBinding,
    readonly leftMs: number,
    readonly note: string,
  ) {
    super(`the run's workspace on the ${recorded.backend} backend was not re-attached: ${note}`);
    this.name = "WorkspaceReattachLeaseSpentError";
  }
}

/** The card's and the note's word for a wait the selection spent — the probe's
 *  through a blip, the attach's through a wake — one wording on the fresh
 *  selection, the attach-failed and the re-attach paths alike; nothing when
 *  nothing was waited. */
function waitedNote(waitedMs: number): string {
  return waitedMs > 0 ? ` after waiting ${Math.round(waitedMs / 1000)}s` : "";
}

/** How long a resumed run's re-attach may PROBE — the first attach's budget,
 *  clipped to what the run's lease has left past its write-up reserve where
 *  the executor carries the run's clock (execution.md item 9), so the probe's
 *  wait and the attach's wake wait cannot spend the run into the reserve and
 *  hand the lease's end to a refusal. A fresh run's first attach, before the
 *  lease starts, keeps the whole budget. */
function leaseClippedBudget(remainingMs: number | undefined): number {
  if (remainingMs === undefined) return FIRST_ATTACH_WAIT_MS;
  return Math.max(0, Math.min(FIRST_ATTACH_WAIT_MS, Math.trunc(remainingMs - RUN_DEADLINE_RESERVE_MS)));
}

/** How long a re-attach holds the /await-restore request (item 27 on the
 *  re-attach): the restore ceiling, clipped to the run's lease less its
 *  write-up reserve so no hold spends the run into the reserve — the lease is
 *  read again after the hold, and its end is the run's end on its budget,
 *  never a refusal. Without a lease (no run control yet), the ceiling alone. */
function restoreHoldBudget(remainingMs: number | undefined): number {
  if (remainingMs === undefined) return AWAIT_RESTORE_TIMEOUT_MS;
  return Math.max(0, Math.min(AWAIT_RESTORE_TIMEOUT_MS, Math.trunc(remainingMs - RUN_DEADLINE_RESERVE_MS)));
}

/** Executor selection result. `note` is present when resident selection fell
 *  back to the per-thread backend — the NAMED reason (state + reason)
 *  the dispatcher surfaces on the status card — or when the resident was
 *  attached in a non-warm but serviceable state (`refreshing`/`degraded`: the
 *  last snapshot serves). Never silent. `resident` is the backend
 *  discriminant: true only when a ResidentExecutor was returned, so the
 *  dispatcher can pick the resident system-prompt variant without an
 *  `instanceof` on the executor implementation. */
export interface ExecutorSelection {
  executor: Executor;
  note?: string;
  resident?: boolean;
  /** The sandbox was seeded from the resident's snapshot before the run
   *  (docs/reference/specs/execution.md item 26): where the checkout is and
   *  what it is on — the dispatcher's seeded prompt variant and the card read
   *  it. Unset on every other path, the cold sandbox included. */
  seeded?: SeededSandbox;
  /** Where the run's commands execute (docs/reference/specs/tracing.md): recorded on its
   *  `exec.*` spans. Every production selection names one; a test double may
   *  leave it out. */
  backend?: Backend;
  /** The resident's step trace for the attach (docs/reference/specs/tracing.md item 19):
   *  the dispatcher grafts it under its attach span. On the resident path, or
   *  on the sandbox fallback after a resident attach failed (the steps that
   *  led to the failure). */
  trace?: ResidentStep[];
  /** The resident's own total for the attach, for the clock-skew attr. */
  attachMs?: number;
  /** The resident's attach answer (ref, advisory sha, worktree path) on the
   *  resident path — the dispatcher names the path to the model and observes
   *  the checkout HEAD through the executor before a review runs. Unset on
   *  every other path. */
  binding?: ResidentBinding;
  /** The drain's share of a failed attach's wait (issue 2101): on the sandbox
   *  fallback after a drained fleet refused the run, so the dispatcher still
   *  publishes the run's `drain_wait` note — the resident path carries it on
   *  the binding instead. */
  drainWaitMs?: number;
}

// Resident lifecycle states the bot attaches in — `isServiceable` in
// residentState.ts (shared with the resident Worker's own state union). The
// resident's contract (docs/reference/specs/resident-repos.md items 7/12) is that
// `refreshing` keeps SERVING the last snapshot — the mirror lock serializes an
// attach against a refresh's fetch/rebuild — and that `degraded` does too when
// the failure happened BEFORE the checkout was touched (fetch/bookkeeping
// reasons); a failure inside the rebuild can leave a broken dep cache, so
// those reasons stay cold. Gating on `warm` alone would send every run cold
// for the whole of every refresh window: with an active default branch (a
// dozen merges a day, each a 1–2 min rebuild every 10-min cycle) plus each
// resident deploy's restore, that is most of a working day of "resident
// refreshing — using fresh sandbox" on run after run.
// The engine-owned states stay excluded: `onboarding` (nothing to attach),
// `restoring` (the disk is being rehydrated; attach's own ensureHydrated would
// wait, but a restore is short and the note is more honest), `down` (only a
// rebuild escapes).

// Negative cache (circuit breaker) for resident /status probe TRANSPORT
// failures that did not reach the host: a resident-service outage costs one
// failed connect, not one per concurrent dispatch. A probe whose own deadline
// passed reached a host that answered slowly — one such miss in 1,633 probes
// sent a run cold off a healthy resident and, through this breaker, every
// dispatch of the next 30 s with it — so a deadline miss falls cold for its
// dispatch alone and arms nothing. Not-warm lifecycle states are definite
// answers and are NEVER cached (the next dispatch must see a recovery
// immediately). In-process only — deliberately not persisted (restart-survival
// invariant).
const PROBE_OUTAGE_WINDOW_MS = 30_000;

/** The /status probe's default deadline. Wide enough for the route's fan-out
 *  (the registry and four resident reads) on a busy Durable Object; a resident
 *  that is gone fails the connect long before it, and a wedged one costs the
 *  dispatch these seconds once, then the cold fallback. */
export const PROBE_TIMEOUT_MS = 8_000;

/** How long the bot holds its one /await-restore request (item 27): generous
 *  next to the resident's own restore ceiling, so the server's answer — the
 *  restore event — wins; past it the run falls cold with the wait named. */
const AWAIT_RESTORE_TIMEOUT_MS = 10 * 60_000;
let probeOutage: { until: number; error: string } | undefined;

/** Test seam: clears the module-level probe circuit breaker. */
export function resetResidentProbeCache(): void {
  probeOutage = undefined;
}

export async function makeExecutor(
  opts: ExecutorFactoryOptions,
  ctx: ExecutorContext,
  /** The caller's span (the dispatcher's `dispatch.workspace.attach`): the
   *  probe and the attach become its `http.client` children (tracing.md item 21). */
  span?: Span,
): Promise<ExecutorSelection> {
  // The profile's machine class decides what is provisioned
  // (docs/reference/specs/execution.md item 18). `none` → nothing: no workspace
  // dir, no sandbox created or reconnected, no credential required. The
  // general and research agents land here.
  const machine = ctx.profile.machine;
  const ready = ctx.readyEnvironment;
  if (ready !== undefined) {
    if (
      ctx.profile.identity !== "write" ||
      machine !== "repo-resident" ||
      !ctx.repo ||
      !ctx.ref ||
      !ctx.headSha ||
      !/^[0-9a-f]{40}$/.test(ctx.headSha)
    )
      throw readyFailure(
        "repository_unresolved",
        "Resolve the pilot repository, branch, exact head and write profile, then retry this task.",
      );
    if (
      opts.execution?.type !== "cloudflare" ||
      !opts.execution.resident ||
      !opts.execution.resident.baseUrl ||
      !opts.execution.url ||
      !processSecrets.named(opts.execution.apiKeyEnv ?? "SANDBOX_TOKEN") ||
      !processSecrets.named(opts.execution.resident.tokenEnv ?? "RESIDENT_OPERATOR_TOKEN")
    )
      throw readyFailure("backend_unavailable", "Configure the pilot resident and sandbox, then retry this task.");
  }
  if (machine === "none") {
    return { executor: new NullExecutor(ctx.agent.name), backend: "local" };
  }
  if (machine !== "blank" && ctx.profile.identity !== "none" && !ctx.githubDoor)
    throw new Error(
      `profile identity "${ctx.profile.identity}" requires a GitHub door run bearer before workspace attach`,
    );
  if (machine !== "blank" && ctx.profile.identity !== "none" && !githubAppConfigured() && !opts.githubCredentials)
    throw new Error(`profile identity "${ctx.profile.identity}" requires the GitHub App for the trusted door`);
  // A resume re-attaches where the row says the run ran (run-history item 54)
  // and never provisions again: the branches below are a fresh run's.
  if (ctx.reattach !== undefined) {
    if (ready !== undefined)
      throw readyFailure(
        "binding_mismatch",
        "Recheck the pilot task's recorded checkout and dependencies before resuming its model turn.",
      );
    return reattachWorkspace(opts, ctx, ctx.reattach, span);
  }
  // `blank` → the per-thread backend with an empty workspace: no repository,
  // whatever the context carries (a blank run never resolves one), and no
  // credential (nothing says this run acts as anyone). No resident probe.
  if (machine === "blank") {
    assertProfileIdentity(ctx.profile.identity, machine);
    return {
      executor: await makePerThreadExecutor(opts, { threadKey: ctx.threadKey, resolveEnvs: async () => ({}) }),
      backend: perThreadBackend(opts),
    };
  }
  // `repo-cold` → the per-thread backend with the checkout and the run's
  // credential, even when the repository has a serviceable resident: the
  // resident registry and Worker are never consulted, so an outage there can
  // neither refuse nor delay the run. Cold is the class, not a fallback, so
  // there is no note.
  if (machine === "repo-cold") {
    return {
      executor: await makePerThreadExecutor(opts, perThreadCheckout(opts, ctx)),
      backend: perThreadBackend(opts),
    };
  }

  // The same ledger owner must authorize both resident attach and every cold
  // fallback. A stale generation cannot bypass the fence when the probe fails.
  if (ctx.residentClaim !== undefined) await ctx.residentClaim();
  const recheckOwner = async (): Promise<number | undefined> =>
    ctx.residentClaim === undefined ? undefined : ctx.residentClaim();

  // `repo-resident`. Resident selection: only when a target repo was resolved
  // AND the resident backend is configured. A SERVICEABLE state → ResidentExecutor;
  // anything else (engine-owned state, probe timeout, outage) → the per-thread
  // backend below, with the reason carried in `note` (never a silent
  // stall). A repo that is simply not onboarded also runs per-thread, but
  // carries a note so the cold fall-through is visible (with the onboarding fix).
  let note: string | undefined;
  /** Why the resident was not used, when a sandbox is the fallback for a
   *  repository that HAS a resident — the seed's chance (item 26): the not-
   *  onboarded case has no snapshot and keeps its own note. */
  let reason: string | undefined;
  /** The steps of a resident attach that failed before the sandbox fallback. */
  let failedAttach: ResidentTrace | undefined;
  /** The drain's share of a failed attach's wait, for the run's `drain_wait` note. */
  let drainWaitMs: number | undefined;
  if (ctx.repo && opts.execution?.resident) {
    const resident = opts.execution.resident;
    const tokenEnv = resident.tokenEnv ?? "RESIDENT_OPERATOR_TOKEN";
    const token = processSecrets.named(tokenEnv);
    if (!token) throw new Error(`execution.resident is configured but ${tokenEnv} is not set`);
    const resource = repoResourceId(ctx.repo);
    const through = await probeThroughBlip(resident, token, resource, span, ctx.stopSignal);
    let probe: ResidentStatusProbe = through.probe;
    /** How long the selection probe waited through a blip the Worker typed
     *  transient (execution.md item 9): drawn from the first attach's budget
     *  and named on the card with the attach's own wait. */
    const probeWaitMs = through.waitedMs;
    /** Set when the run held the one /await-restore request (item 27) — the
     *  card names the wait whichever way the answer went. */
    let waitedForRestore = false;
    if (probe.kind === "status" && probe.state === "restoring") {
      // Item 27: a probe that finds the resident restoring opens the ONE held
      // /await-restore request instead of falling to the cold fleet — the DO
      // answers when its state leaves `restoring` (event-driven; no polling,
      // no retry timer). An older Worker's 404 falls back cold, the wait named.
      const wait = await ResidentExecutor.awaitRestore(
        resident.baseUrl,
        token.reveal(),
        resource,
        AWAIT_RESTORE_TIMEOUT_MS,
        span,
        ctx.stopSignal,
      );
      // The run's own stop ended the hold: the stop's typed shape, read by the
      // dispatch as the stop it is — a stopped run is never provisioned cold.
      if (wait.kind === "stopped") throw wakeStopped("/await-restore");
      if (wait.kind === "status") {
        waitedForRestore = true;
        // The state the restore landed on; the probe's seed handle (item 25)
        // stays, so a landing the bot cannot attach to can still seed a sandbox.
        probe = { ...probe, state: wait.state, reason: wait.reason };
      } else if (wait.kind === "unsupported") {
        reason = oneLine(
          `resident restoring${probe.reason ? ` (${probe.reason})` : ""} — this Worker has no /await-restore route, ` +
            `so waiting for the resident's restore is not possible`,
        );
      } else {
        reason = oneLine(`resident restoring — waiting for the resident's restore failed (${wait.error})`);
      }
    }
    if (reason !== undefined) {
      // The wait ended cold: the sandbox fallback below decides between a seed
      // from the probe's handle (item 26) and a fresh sandbox, the wait named.
    } else if (probe.kind === "status" && (ready ? probe.state === "warm" : isServiceable(probe.state, probe.reason))) {
      // The resident can degrade between the /status probe and /attach: 503
      // (mirror-busy) or 429 (pool-exhausted) surface only at attach time.
      // Needs-ref keeps the dispatcher's ask-once flow. A registration
      // mismatch is an ownership fence. Other attach failures may use the
      // per-thread fallback, with the failure named on the card.
      // The probe (and optional restore wait) may have outlived this ledger
      // owner. Claim again outside the fallback catch and send the new fence.
      const ownerFence = await recheckOwner();
      let selection: ExecutorSelection | undefined;
      try {
        // Non-warm but serviceable: the note says so while the run
        // still gets the worktree it came for; openResident adds ref@sha.
        const nonWarm =
          probe.state === "warm" ? undefined : oneLine(`${probe.state}${probe.reason ? ` (${probe.reason})` : ""}`);
        // A `read` identity gets a read-only worktree — decided from the
        // run's profile, never from the prompt
        // (docs/reference/specs/resident-repos.md item 50).
        const readonly = ctx.profile.identity === "read" ? true : undefined;
        // The resolved PR head rides along so the resident fetches a mirror
        // whose ref tip lags it (item 51) instead of cloning a stale tip; the
        // thread's own PR rides along as the reason for the hint (item 16).
        selection = await openResident(
          {
            baseUrl: resident.baseUrl,
            token: token.reveal(),
            resource,
            threadKey: ctx.threadKey,
            ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
            ...(ctx.ownerGen !== undefined ? { ownerGen: ctx.ownerGen } : {}),
            ...(ownerFence !== undefined ? { ownerFence } : {}),
            refHint: ctx.ref,
            readonly,
            runBudgetMs: minutesToMs(ctx.profile.minutes),
            ...(ctx.setupRemainingMs !== undefined ? { setupRemainingMs: ctx.setupRemainingMs } : {}),
            sha: ctx.headSha,
            // The run bearer and commit identity pairs ride each exec. The
            // resident keeps its App credential only at the root-owned mirror.
            resolveEnvs: async () => ({
              ...(ctx.githubDoor ? residentDoorEnvs(ctx.githubDoor, ctx.repo) : {}),
              ...(await gitIdentityEnvs(ctx.profile.identity, authorSourceOf(opts, ctx))),
            }),
            ...(ctx.githubDoor ? { githubDoor: ctx.githubDoor } : {}),
            ...(ctx.ownPr !== undefined ? { ownPr: ctx.ownPr } : {}),
            ...(ctx.remainingMs !== undefined ? { remainingMs: ctx.remainingMs } : {}),
            ...(ctx.onLiveStateObservation !== undefined ? { onLiveStateObservation: ctx.onLiveStateObservation } : {}),
          },
          nonWarm,
          span,
          // A refusal the Worker typed transient is waited through here, under
          // what the probe's wait left of the factory's own budget and the
          // run's stop (item 9); the card names both waits' total.
          {
            signal: ctx.stopSignal,
            budgetMs: Math.max(0, FIRST_ATTACH_WAIT_MS - probeWaitMs),
            waitedMs: probeWaitMs,
            // A drained fleet is waited for under the FALLBACK's own cost, not
            // the deploy's (issue 2101): this attach has the seeded sandbox
            // below to fall to, so the drain wait ends in minutes.
            drainBoundMs: DRAIN_FALLBACK_WAIT_MS,
          },
        );
      } catch (err) {
        if (err instanceof ResidentNeedsRefError || err instanceof ResidentRegistrationMismatchError) throw err;
        // A stopped run is not a run to provision cold for: the stop that ended
        // the attach's wait ends the dispatch, as the runner's stop path would.
        // Read by the error's typed shape: another failure beside a pending stop
        // is that failure, and falls cold as it always did.
        if (isRunStopError(err)) throw err;
        failedAttach = residentTraceOf(err);
        drainWaitMs = drainWaitOf(err);
        // Item 27: an attach that fails after a wait names the wait too — the
        // probe's through a typed blip (item 9) and the restore's alike, so a
        // run that started late says why even when it then fell cold.
        const restoreWait = waitedForRestore ? " after waiting for the resident's restore" : "";
        reason = oneLine(
          `resident attach failed (${err instanceof Error ? err.message : String(err)})${waitedNote(probeWaitMs)}${restoreWait}`,
        );
      }
      if (selection) {
        // Attach can wait while a newer generation reclaims the run. A claim
        // after it settles stops this generation before it can use the tree.
        // The executor keeps the fence sent at attach for a guarded release;
        // a newer owner's registration cannot be detached by this cleanup.
        try {
          await recheckOwner();
        } catch (err) {
          await selection.executor.release?.("always");
          throw err;
        }
        if (ready !== undefined) {
          try {
            if (!probe.seed)
              throw readyFailure("snapshot_missing", "Refresh the pilot resident snapshot, then retry this task.");
            if (!probe.seed.depsBackupId)
              throw readyFailure(
                "dependencies_missing",
                "Refresh the pilot dependency snapshot, then retry this task.",
              );
            if (
              !selection.binding ||
              selection.binding.ref !== ctx.ref ||
              (ctx.headSha !== undefined && selection.binding.sha !== ctx.headSha) ||
              !selection.binding.workspace
            )
              throw readyFailure(
                "binding_mismatch",
                "Verify the original task's repository branch and head, then retry it.",
              );
            if (
              selection.binding.deps === undefined ||
              (selection.binding.deps === "none" && !selection.binding.depsKey)
            )
              throw readyFailure(
                "dependencies_missing",
                "Restore or install the resident's dependency view, then retry this task.",
              );
            await checkReadyEnvironment(selection.executor, selection.binding.workspace ?? "", ready, ctx.stopSignal);
            await recheckOwner();
          } catch (err) {
            await selection.executor.release?.("always").catch(() => undefined);
            throw err;
          }
        }
        // Item 27: the wait is on the card whichever state the restore landed on.
        return waitedForRestore
          ? {
              ...selection,
              note: oneLine(`${selection.note ?? "resident"} · after waiting for the resident's restore`),
            }
          : selection;
      }
    } else if (probe.kind === "unreachable") {
      // A probe waited through a typed blip that never cleared names the wait.
      reason = oneLine(`resident unreachable (${probe.error})${waitedNote(probeWaitMs)}`);
    } else if (probe.state !== "not-onboarded") {
      // Item 27: a restore that landed on a non-serviceable state still names the wait.
      const wait = waitedForRestore ? " after waiting for the resident's restore" : "";
      reason = oneLine(`resident ${probe.state}${probe.reason ? ` (${probe.reason})` : ""}${wait}`);
    } else {
      // not-onboarded is the ordinary per-thread case — but still make the cold
      // fall-through visible: the user needs to know coding ran cold in a
      // per-thread sandbox instead of on a warm, deps-ready resident, and how to
      // fix it. Routing is unchanged; only the note is added. Record 0054: the
      // note names the resident they probably meant, when the registry answers
      // with one near match (one bounded read; silence changes nothing).
      if (ready !== undefined)
        throw readyFailure(
          "repository_not_onboarded",
          "Onboard the pilot repository as a resident, then retry this task.",
        );
      const near = await nearOnboarded(resident, ctx.repo);
      note =
        `repo not onboarded as a resident — running in a cold per-thread sandbox; ` +
        `onboard it (\`repo onboard ${ctx.repo}\`) for a warm, deps-ready environment` +
        (near ? ` (did you mean \`${near}\`?)` : "");
    }
    if (reason !== undefined) {
      // The seed (docs/reference/specs/execution.md item 26): the resident could
      // not take the run, but its probe carried the snapshot handle — the
      // sandbox restores it before the run's first command instead of cloning
      // and installing from nothing. Nothing to seed from (an unreachable
      // resident answers no body; a Worker that is not the cloudflare one has
      // no /seed) → the cold path as before, and so does a refused seed, with
      // the refusal on the note.
      await recheckOwner();
      const handle = probe.kind === "status" ? probe.seed : undefined;
      if (ready !== undefined && (!handle || !handle.depsBackupId))
        throw readyFailure(
          handle ? "dependencies_missing" : "snapshot_missing",
          handle
            ? "Refresh the pilot dependency snapshot, then retry this task."
            : "Restore or onboard the pilot repository, then retry this task.",
        );
      const executor = await makePerThreadExecutor(opts, perThreadCheckout(opts, ctx));
      await recheckOwner();
      const outcome =
        handle && executor instanceof CloudflareSandboxExecutor
          ? await seedSandbox(
              executor,
              handle,
              ctx,
              () => probeResident(resident, token, resource, span, ctx.stopSignal),
              span,
            )
          : undefined;
      if (outcome !== undefined) await recheckOwner();
      if (outcome && "seeded" in outcome) {
        if (ready !== undefined) {
          await checkReadyEnvironment(executor, outcome.seeded.workspace, ready, ctx.stopSignal, outcome.sourceSha);
          await recheckOwner();
        }
        return {
          executor,
          note: seededSandboxNote(reason, outcome.seeded),
          backend: perThreadBackend(opts),
          seeded: outcome.seeded,
          ...(failedAttach ? { trace: failedAttach.steps } : {}),
          ...(drainWaitMs !== undefined ? { drainWaitMs } : {}),
        };
      }
      if (ready !== undefined && outcome?.why === "seed source did not match the bound snapshot")
        throw readyFailure("binding_mismatch", "Verify the original task's repository branch and head, then retry it.");
      if (ready !== undefined && outcome?.why === "dependency snapshot missing on seed retry")
        throw readyFailure("dependencies_missing", "Refresh the pilot dependency snapshot, then retry this task.");
      if (ready !== undefined)
        throw readyFailure(
          "seed_failed",
          "Restore the pilot sandbox from its resident snapshot, then retry this task.",
        );
      return {
        executor,
        note: `${reason} — using fresh sandbox${outcome ? ` (${outcome.why})` : ""}`,
        backend: perThreadBackend(opts),
        ...(failedAttach ? { trace: failedAttach.steps } : {}),
        ...(drainWaitMs !== undefined ? { drainWaitMs } : {}),
      };
    }
  }

  if (ready !== undefined)
    throw readyFailure("repository_not_onboarded", "Onboard the pilot repository as a resident, then retry this task.");
  await recheckOwner();
  const executor = await makePerThreadExecutor(opts, perThreadCheckout(opts, ctx));
  await recheckOwner();
  return {
    executor,
    note,
    backend: perThreadBackend(opts),
    ...(failedAttach ? { trace: failedAttach.steps } : {}),
  };
}

/** Seed the thread's sandbox from the resident's handle (item 26): one
 *  `POST /seed` with the thread's own ref and head riding along; a handle whose
 *  objects are gone (`seed-missing` — a rotation took them) re-reads `/status`
 *  once and retries with the newer handle; any other refusal, or a Worker that
 *  has no `/seed` (an older release answers 404, an infra error here), sends
 *  the run cold with the reason for the note. The seed's own wait for a full
 *  fleet or a starting container is the executor's, as for every route. */
async function seedSandbox(
  executor: CloudflareSandboxExecutor,
  handle: SeedHandle,
  ctx: ExecutorContext,
  reprobe: () => Promise<ResidentStatusProbe>,
  span?: Span,
): Promise<{ seeded: SeededSandbox; sourceSha: string } | { why: string }> {
  let seed: SandboxSeed = seedForThread(handle, {
    slug: ctx.repo!,
    ...(ctx.ref ? { ref: ctx.ref } : {}),
    ...(ctx.headSha ? { headSha: ctx.headSha } : {}),
  });
  for (let retried = false; ; retried = true) {
    let answer: SeedAnswer;
    try {
      answer = await executor.seed(seed, { span, signal: ctx.stopSignal });
    } catch (err) {
      // A stop ends setup, not just this attempt to seed. Falling through to
      // a fresh sandbox would hide the stop and start work the run no longer owns.
      if (isRunStopError(err)) throw err;
      return { why: oneLine(`seed failed (${err instanceof Error ? err.message : String(err)})`) };
    }
    if (answer.seeded) {
      if (
        ctx.readyEnvironment !== undefined &&
        (answer.slug !== seed.slug ||
          answer.ref !== (seed.fetchRef ?? seed.ref) ||
          !/^[0-9a-f]{40}$/.test(answer.sha) ||
          (seed.fetchSha !== undefined && answer.sha !== seed.fetchSha) ||
          answer.from?.checkoutBackupId !== seed.checkoutBackupId ||
          answer.from?.depsBackupId !== seed.depsBackupId ||
          answer.from?.ref !== seed.ref ||
          answer.from?.sha !== seed.sha)
      )
        return { why: "seed source did not match the bound snapshot" };
      return {
        sourceSha: seed.sha,
        seeded: {
          slug: answer.slug,
          ref: answer.ref,
          sha: answer.sha,
          workspace: SEED_CHECKOUT_DIR,
          cached: answer.cached,
          ms: answer.ms,
        },
      };
    }
    const fresh = answer.reason === "seed-missing" && !retried ? await reprobe() : undefined;
    // As on the selection probe, a transport ended by the run's signal is
    // the stop, not a missing snapshot that permits a cold fallback.
    if (fresh?.kind === "unreachable" && fresh.transport && ctx.stopSignal?.aborted) throw wakeStopped("/status");
    const decision = seedRetryDecision({
      answer,
      attempted: seed,
      fresh: fresh?.kind === "status" ? fresh.seed : undefined,
      alreadyRetried: retried,
    });
    if (decision.action === "cold") return { why: oneLine(decision.why) };
    if (ctx.readyEnvironment !== undefined && !decision.seed.depsBackupId)
      return { why: "dependency snapshot missing on seed retry" };
    seed = decision.seed;
  }
}

/** The resumed run's re-attach (run-history item 54): the recorded backend
 *  and only that one. A per-thread backend is keyed by the thread, so the same
 *  executor reaches the same container (or its replacement, which the pi
 *  harness tells apart by the container's identity), and the resident is never
 *  probed for it: a run that started cold is not moved onto the resident. A
 *  recorded resident is probed and asked to keep the thread's tree as it
 *  stands (`reuse`); anything short of a binding on the run's own tree
 *  (unreachable, not serviceable, a refusal, a needs-ref since a resume never
 *  binds a branch, an answer naming another tree or user) is a
 *  `WorkspaceReattachRefusedError`, and no sandbox is provisioned in its place. */
async function reattachWorkspace(
  opts: ExecutorFactoryOptions,
  ctx: ExecutorContext,
  recorded: WorkspaceBinding,
  span?: Span,
): Promise<ExecutorSelection> {
  const refuse = (why: string) => new WorkspaceReattachRefusedError(recorded, oneLine(why));
  // The run's lease first, and again after every wait below: inside the
  // write-up reserve, or under what an attach needs past it, nothing is probed
  // or asked for, whatever the backend — the run ends on its budget, and its
  // caller reads this apart from a refusal (execution.md item 9). The clock is
  // read each time, since the probe's wait and the attach's wake wait spend it.
  const leaseSpent = (): WorkspaceReattachLeaseSpentError | undefined => {
    const left = ctx.remainingMs?.();
    if (left === undefined) return undefined;
    const bound = attachBoundWithinRun(left);
    return bound.kind === "exhausted" ? new WorkspaceReattachLeaseSpentError(recorded, left, bound.note) : undefined;
  };
  const spentAtEntry = leaseSpent();
  if (spentAtEntry) throw spentAtEntry;
  if (recorded.backend !== "resident") {
    if (ctx.profile.machine === "blank") assertProfileIdentity(ctx.profile.identity, ctx.profile.machine);
    const input =
      ctx.profile.machine === "blank"
        ? { threadKey: ctx.threadKey, resolveEnvs: async () => ({}) }
        : perThreadCheckout(opts, ctx);
    const executor = await makePerThreadExecutor(opts, input);
    if (!recorded.seeded) return { executor, backend: perThreadBackend(opts) };
    if (recorded.backend !== "sandbox" || ctx.repo?.toLowerCase() !== recorded.seeded.slug.toLowerCase())
      throw refuse("the seeded checkout's repository does not match the recorded run");
    const git = `git -C ${shellQuote(recorded.seeded.workspace)}`;
    const observed = async (command: string): Promise<string | undefined> =>
      executor.exec(`${git} ${command}`, { timeoutMs: 30_000, span }).catch(() => undefined);
    const ref = await observed("rev-parse --abbrev-ref HEAD");
    const headOutput = await observed("rev-parse HEAD");
    // Read the stored origin: a seeded checkout must name only its bound repository.
    const origin = await observed("config --get remote.origin.url");
    const sha = headOutput === undefined ? undefined : parseRevParseOutput(headOutput);
    const doorRemote = ctx.githubDoor ? seedDoorRemote(ctx.githubDoor.baseUrl, recorded.seeded.slug) : undefined;
    const storedOrigin = origin?.trim();
    const legacyOrigin = `https://github.com/${recorded.seeded.slug}.git`;
    if (
      ref?.trim() !== recorded.seeded.ref ||
      sha === undefined ||
      doorRemote === undefined ||
      (storedOrigin?.toLowerCase() !== doorRemote.toLowerCase() &&
        storedOrigin?.toLowerCase() !== legacyOrigin.toLowerCase())
    )
      throw refuse("the seeded checkout's origin, ref or head could not be verified");
    if (storedOrigin?.toLowerCase() === legacyOrigin.toLowerCase()) {
      await observed(`remote set-url origin ${shellQuote(doorRemote)}`);
      const moved = await observed("config --get remote.origin.url");
      if (moved?.trim().toLowerCase() !== doorRemote.toLowerCase())
        throw refuse("the seeded checkout's origin could not be moved to the Git door");
    }
    return {
      executor,
      backend: perThreadBackend(opts),
      seeded: { ...recorded.seeded, sha, cached: true, ms: 0 },
    };
  }
  const resident = opts.execution?.resident;
  if (!resident) throw refuse("no resident backend is configured in this process");
  if (!ctx.repo) throw refuse("the run's row names no repository to re-attach on");
  const tokenEnv = resident.tokenEnv ?? "RESIDENT_OPERATOR_TOKEN";
  const token = processSecrets.named(tokenEnv);
  if (!token) throw new Error(`execution.resident is configured but ${tokenEnv} is not set`);
  const resource = repoResourceId(ctx.repo);
  // The selection probe waited through a blip the Worker typed transient, as a
  // fresh run's is (execution.md item 9): drawn from the first attach's budget
  // clipped to the run's lease, the run's stop riding in, named on the note. A
  // refusal at once here would close the run and dispatch its request again for
  // a blip a re-probe clears; a wait that spent the lease is the lease's end.
  const budgetMs = leaseClippedBudget(ctx.remainingMs?.());
  const { probe, waitedMs: probeWaitMs } = await probeThroughBlip(
    resident,
    token,
    resource,
    span,
    ctx.stopSignal,
    budgetMs,
  );
  const spentProbing = leaseSpent();
  if (spentProbing) throw spentProbing;
  if (probe.kind === "unreachable") throw refuse(`resident unreachable (${probe.error})${waitedNote(probeWaitMs)}`);
  // A restoring resident is waited through, never refused at once (execution.md
  // item 27 on the re-attach; issue 1364 part 1): the run's worktree lives on
  // this resident or nowhere (run-history item 54), so a refusal here would
  // close the run and dispatch its request again — the tree, the transcript and
  // a coordinator child's round lost to a rehydrate that ends on its own. The
  // one held /await-restore request, bounded by the restore ceiling clipped to
  // the run's lease less its reserve; the run's stop ends the hold at once.
  let landed = { state: probe.state, reason: probe.reason };
  /** Set when the re-attach held the /await-restore request — the note names the wait. */
  let waitedForRestore = false;
  if (landed.state === "restoring") {
    const wait = await ResidentExecutor.awaitRestore(
      resident.baseUrl,
      token.reveal(),
      resource,
      restoreHoldBudget(ctx.remainingMs?.()),
      span,
      ctx.stopSignal,
    );
    // The stop's typed shape, never a refusal that would restart the stopped
    // run from its request; the lease spent under the hold is the run's end on
    // its budget — both read before any refusal, as after the probe's wait.
    if (wait.kind === "stopped") throw wakeStopped("/await-restore");
    const spentHolding = leaseSpent();
    if (spentHolding) throw spentHolding;
    if (wait.kind === "unsupported")
      throw refuse(
        "resident restoring — this Worker has no /await-restore route, so waiting for the resident's restore is not possible",
      );
    if (wait.kind === "unreachable")
      throw refuse(`resident restoring — waiting for the resident's restore failed (${wait.error})`);
    waitedForRestore = true;
    landed = { state: wait.state, reason: wait.reason };
  }
  const restoreNote = waitedForRestore ? " · after waiting for the resident's restore" : "";
  if (!isServiceable(landed.state, landed.reason))
    throw refuse(
      `resident ${landed.state}${landed.reason ? ` (${landed.reason})` : ""}${waitedNote(probeWaitMs)}${restoreNote}`,
    );
  const nonWarm =
    landed.state === "warm" ? undefined : oneLine(`${landed.state}${landed.reason ? ` (${landed.reason})` : ""}`);
  const executor = new ResidentExecutor({
    baseUrl: resident.baseUrl,
    token: token.reveal(),
    resource,
    threadKey: ctx.threadKey,
    ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
    ...(ctx.ownerGen !== undefined ? { ownerGen: ctx.ownerGen } : {}),
    ...(ctx.residentClaim !== undefined ? { ownerFence: await ctx.residentClaim() } : {}),
    refHint: ctx.ref,
    readonly: ctx.profile.identity === "read" ? true : undefined,
    sha: ctx.headSha,
    reuse: true,
    ...(ctx.githubDoor ? { githubDoor: ctx.githubDoor } : {}),
    // The run bearer and commit identity pairs ride each exec. The resident's
    // App credential remains at the root-owned mirror.
    resolveEnvs: async () => ({
      ...(ctx.githubDoor ? residentDoorEnvs(ctx.githubDoor, ctx.repo) : {}),
      ...(await gitIdentityEnvs(ctx.profile.identity, authorSourceOf(opts, ctx))),
    }),
    ...(ctx.remainingMs !== undefined ? { remainingMs: ctx.remainingMs } : {}),
    runBudgetMs: minutesToMs(ctx.profile.minutes),
    ...(ctx.setupRemainingMs !== undefined ? { setupRemainingMs: ctx.setupRemainingMs } : {}),
    ...(ctx.onLiveStateObservation !== undefined ? { onLiveStateObservation: ctx.onLiveStateObservation } : {}),
  });
  let binding: ResidentBinding;
  try {
    // This dispatch's first attach, like a fresh run's: a refusal the Worker
    // typed transient is waited through under what the probe's wait left of
    // the same lease-clipped budget, and the run's stop ends the wait at once.
    binding = await executor.attach(span, {
      signal: ctx.stopSignal,
      budgetMs: Math.max(0, budgetMs - probeWaitMs),
    });
  } catch (err) {
    // The run's own stop ended the attach: the executor's typed `aborted` error
    // is that stop, never a re-attach refusal — which would close this run and
    // dispatch its request again. The lease's end under the attach's wake wait
    // is the run's end on its budget, never a refusal either — whether the
    // executor said so itself (`ResidentLeaseSpentError`: the re-attach was not
    // opened, the run inside its reserve or under the attach floor) or the
    // attach failed some other way with the lease spent meanwhile: a wake
    // budget struck out, a re-attach request cut short. The lease is read
    // again here, as after the probe's wait, before any refusal. Any other
    // failure beside a pending stop is the refusal it is.
    if (isRunStopError(err)) throw err;
    if (err instanceof ResidentLeaseSpentError)
      throw new WorkspaceReattachLeaseSpentError(recorded, err.leftMs, err.note);
    const spentWaking = leaseSpent();
    if (spentWaking) throw spentWaking;
    throw refuse(`${err instanceof Error ? err.message : String(err)}${restoreNote}`);
  }
  // The tree the resident answered must be the run's: the same worktree, the
  // same pool user. Another (a rebinding since) is not the run's work.
  const same = (recordedValue: string | undefined, answered: string | undefined) =>
    recordedValue === undefined || answered === undefined || recordedValue === answered;
  if (!same(recorded.workspace, binding.workspace) || !same(recorded.user, binding.user)) {
    const name = (workspace: string | undefined, user: string | undefined) =>
      `${workspace ?? "(unnamed)"} as ${user ?? "(unnamed)"}`;
    throw refuse(
      `the resident's worktree for this thread is ${name(binding.workspace, binding.user)}, not the run's recorded ${name(recorded.workspace, recorded.user)}`,
    );
  }
  const where = `${resource.replace(/^repo:/, "")} · ${binding.ref}@${binding.sha.slice(0, 7)}`;
  // The waits are on the note as a fresh run's are: the probe's and the attach's, one total.
  const wokeSeconds = Math.round((probeWaitMs + (binding.wokeAfterMs ?? 0)) / 1000);
  const woke = wokeSeconds > 0 ? ` · after waiting ${wokeSeconds}s for the resident` : "";
  return {
    executor,
    resident: true,
    backend: "resident",
    ...(binding.trace ? { trace: binding.trace } : {}),
    ...(binding.attachMs !== undefined ? { attachMs: binding.attachMs } : {}),
    binding,
    note: nonWarm
      ? `resident ${nonWarm} · ${where} · re-attached to the run's worktree${woke}${restoreNote}`
      : `resident · ${where} · re-attached to the run's worktree${woke}${restoreNote}`,
  };
}

/** Attach to a serviceable resident and name the result POSITIVELY: the note
 *  reads `resident · <owner/name> · <ref>@<sha7>` (warm) or `resident <state>
 *  (<reason>) · <owner/name> · <ref>@<sha7> — attached to the last snapshot` (refreshing/degraded)
 *  so a reader can tell the resident path from Slack alone, never only from
 *  the absence of a fallback note (named in both directions). Needs-ref (no binding for this thread, no branch named): when
 *  the resident's 409 names its default branch, bind to it ONCE here and say
 *  so in the note — the cold path already works on the default branch without
 *  asking, and a coding run branches off it anyway. A 409 without a
 *  defaultRef (an older Worker) still propagates to the dispatcher's ask-once
 *  flow; a second needs-ref after binding by default is a resident bug and
 *  becomes a plain Error — the caller's named `resident attach failed` fallback
 *  note — never a loop. */
async function openResident(
  opts: ResidentExecutorOptions,
  /** `<state>[ (<reason>)]` of a serviceable non-warm resident; undefined when warm. */
  nonWarm?: string,
  span?: Span,
  /** How a refusal the Worker typed transient is waited through: the run's
   *  stop, which ends the wait at once, and the budget past which the attach
   *  fails with the wake's strike; `waitedMs` is a wait the caller already
   *  spent before this attach (the selection probe's), added to the total the
   *  card names; `drainBoundMs` bounds a drained fleet's wait by the caller's
   *  fallback cost (issue 2101). */
  wait: { signal?: AbortSignal; budgetMs?: number; waitedMs?: number; drainBoundMs?: number } = {},
): Promise<ExecutorSelection> {
  let executor = new ResidentExecutor(opts);
  let binding: ResidentBinding;
  let byDefault = false;
  // One budget across the attach and its retry by default: the second attach
  // gets what the first's WAIT left — the time spent waiting for the wake, never
  // the first request's own latency (a stale-mirror fetch before the 409 is the
  // attach's, not the wake's) — and the card names the total waited.
  try {
    binding = await executor.attach(span, wait);
  } catch (err) {
    if (!(err instanceof ResidentNeedsRefError) || !err.defaultRef) throw err;
    byDefault = true;
    const firstWaitMs = err.wokeAfterMs ?? 0;
    const budgetLeft = wait.budgetMs === undefined ? undefined : Math.max(0, wait.budgetMs - firstWaitMs);
    // Said to the resident too (`refByDefault`), so the binding it makes is
    // recorded as bound by default — the one kind that may later move onto the
    // thread's own PR branch (item 16).
    executor = new ResidentExecutor({ ...opts, refHint: err.defaultRef, refByDefault: true });
    try {
      binding = await executor.attach(span, { ...wait, budgetMs: budgetLeft });
      const totalWaitMs = firstWaitMs + (binding.wokeAfterMs ?? 0);
      if (totalWaitMs > 0) binding = { ...binding, wokeAfterMs: totalWaitMs };
    } catch (again) {
      if (again instanceof ResidentNeedsRefError) {
        throw new Error(
          `resident attach: ${opts.resource} refused its own default ref "${err.defaultRef}" (${again.message})`,
          { cause: again },
        );
      }
      throw again;
    }
  }
  // The note is the binding at open time — the worktree the run STARTS on. A
  // mid-run re-attach (evicted worktree) may move to a newer sha; that later
  // state is `executor.binding`, not the card's opening line. It NAMES the
  // repo: a run that bound the wrong repo (a request about one repo landing on
  // another repo's resident) must be readable from the card, not only from a
  // sha nobody recognizes.
  const where = `${opts.resource.replace(/^repo:/, "")} · ${binding.ref}@${binding.sha.slice(0, 7)}`;
  const why = byDefault ? " (repo default — no branch named)" : "";
  const moved = rebindLabel(binding);
  // The wake wait is on the card, as item 27's restore wait is: a run that
  // started late says why. A blip cleared under a second started nobody late.
  const wokeSeconds = Math.round(((wait.waitedMs ?? 0) + (binding.wokeAfterMs ?? 0)) / 1000);
  const woke = wokeSeconds > 0 ? ` · after waiting ${wokeSeconds}s for the resident` : "";
  return {
    executor,
    resident: true,
    backend: "resident",
    ...(binding.trace ? { trace: binding.trace } : {}),
    ...(binding.attachMs !== undefined ? { attachMs: binding.attachMs } : {}),
    binding,
    note: nonWarm
      ? `resident ${nonWarm} · ${where}${why}${moved} — attached to the last snapshot${woke}`
      : `resident · ${where}${why}${moved}${woke}`,
  };
}

/** The card's word on the binding's move (docs/reference/specs/resident-repos.md
 *  item 16), beside the binding line the way the repo-default note is said:
 *  the resident moved the thread onto its own PR's branch, moved it back to
 *  the default because the thread's branch is gone (naming the PR whose
 *  branch it was when the resident named one, else the branch itself), or
 *  kept the binding and named why — so a follow-up running somewhere other
 *  than where the thread's last run did is readable from the card. Empty when
 *  none of these happened. */
export function rebindLabel(binding: Pick<ResidentBinding, "rebound" | "rebindRefused" | "returned">): string {
  if (binding.rebound) return ` · rebound to ${binding.rebound.to} (this thread's PR #${binding.rebound.pr})`;
  if (binding.returned) {
    const r = binding.returned;
    return r.pr !== undefined
      ? ` · returned to ${r.to} (the branch of this thread's PR #${r.pr} is gone)`
      : ` · returned to ${r.to} (this thread's branch ${r.from} is gone)`;
  }
  if (binding.rebindRefused) {
    const r = binding.rebindRefused;
    return ` · rebind to ${r.to} (this thread's PR #${r.pr}) refused: ${r.reason}`;
  }
  return "";
}

/** The repo resolver's "is this slug an onboarded resident?" probe (the
 *  prose-slug guard): one operator `GET /status` per candidate,
 *  through the same negative cache as executor selection. `true` for any
 *  lifecycle state of an onboarded resource — even `down` is a real repo;
 *  `not-onboarded` (and a non-transport HTTP error) is `false`; a registry
 *  that did not ANSWER — transport failure, timeout, outage window — is
 *  `"unreachable"`, so the resolver can refuse an explicit address loudly
 *  instead of treating silence as a refusal (both are fail-closed: neither
 *  ever binds a repo). Undefined when the resident is not configured or its
 *  bearer is unset — the resolver then binds weak tokens unvetted, as in
 *  local/dev. */
export function residentOnboardedProbe(
  cfg: ResidentExecutionConfig | undefined,
  secrets: Secrets = processSecrets,
): ((slug: string) => Promise<boolean | "unreachable">) | undefined {
  const token = cfg?.baseUrl ? secrets.named(cfg.tokenEnv ?? "RESIDENT_OPERATOR_TOKEN") : undefined;
  if (!cfg?.baseUrl || !token) return undefined;
  return async (slug) => {
    const probe = await probeResident(cfg, token, repoResourceId(slug));
    if (probe.kind === "unreachable" && probe.transport) return "unreachable";
    return probe.kind === "status" && probe.state !== "not-onboarded";
  };
}

/** The repo resolver's registry listing — every onboarded `owner/name` — for
 *  resolving a bare `in <name>` address (resident-repos.md item 29). ONE
 *  `GET /residents` per call, read with the ADMIN bearer (the route is
 *  read-scoped; the operator bearer does not open it) through the same
 *  negative cache as the probes. Any failure — no bearer, an outage window, a
 *  non-2xx, a malformed body — answers undefined: a name then binds nothing,
 *  never a guess. Undefined when the resident is not configured or the admin
 *  bearer is unset (local/dev): names are ignored, slug addressing still works. */
export function residentSlugsLister(
  cfg: ResidentExecutionConfig | undefined,
  secrets: Secrets = processSecrets,
): (() => Promise<string[] | undefined>) | undefined {
  const token = cfg?.baseUrl ? secrets.named(cfg.adminTokenEnv ?? "RESIDENT_ADMIN_TOKEN") : undefined;
  if (!cfg?.baseUrl || !token) return undefined;
  return async () => {
    if (probeOutage && systemClock() < probeOutage.until) return undefined;
    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/residents`, {
        headers: { authorization: `Bearer ${token.reveal()}` },
        signal: execDeadline(cfg.probeTimeoutMs ?? PROBE_TIMEOUT_MS),
      });
    } catch (err) {
      // A failed connect opens the window like the selection probe's would; a
      // deadline miss is the host answering slowly and arms nothing (item 25).
      if (!isDeadlineMiss(err)) armOutage(err instanceof Error ? err.message : String(err));
      return undefined;
    }
    if (!res.ok) return undefined;
    const data = (await res.json().catch(() => ({}))) as { residents?: unknown };
    if (!Array.isArray(data.residents)) return undefined;
    return data.residents
      .map((rec) =>
        typeof rec === "object" && rec !== null ? String((rec as { resource?: unknown }).resource ?? "") : "",
      )
      .filter((resource) => resource.startsWith("repo:"))
      .map((resource) => resource.slice("repo:".length).toLowerCase());
  };
}

/** The one resident a typed repo name is near (record 0054), over the same
 *  bounded listing the resolver uses: `undefined` when the list does not
 *  answer, when no candidate is within budget, or when several tie — the cold
 *  fall-through note then names only the fix, never a wrong repo. */
async function nearOnboarded(cfg: ResidentExecutionConfig | undefined, typed: string): Promise<string | undefined> {
  const list = residentSlugsLister(cfg);
  const candidates = await list?.().catch(() => undefined);
  if (!candidates || candidates.length === 0) return undefined;
  return nearMatch(typed, candidates).guess;
}

/** /status probe through the negative cache: inside an outage window the
 *  cached transport failure answers without a fetch. */
async function probeResident(
  cfg: ResidentExecutionConfig,
  token: Secret,
  resource: string,
  span?: Span,
  /** The run's stop, where the caller has one: it rides into every probe —
   *  the selection's first and each re-probe of its blip wait alike. The
   *  deadline is the selection's own, configured or 2 s, for every probe — an
   *  operator who set it to keep a cold fallback fast gets that pace through
   *  the wait too. */
  stop?: AbortSignal,
): Promise<ResidentStatusProbe> {
  if (probeOutage && systemClock() < probeOutage.until) {
    return { kind: "unreachable", error: `${probeOutage.error}; probe skipped during outage window`, transport: true };
  }
  const probe = await ResidentExecutor.probeStatus(
    cfg.baseUrl,
    token.reveal(),
    resource,
    cfg.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
    span,
    stop,
  );
  // The run's own stop aborted the request: the stop's signal decides before
  // the error's name, as at every send — the caller's stop, never the network,
  // and no outage window for every other dispatch in the process. A deadline
  // miss arms none either: the host was reached and answered slowly, which is
  // this dispatch's cold fallback and nobody else's (item 25).
  if (probe.kind === "unreachable" && probe.transport && !probe.timedOut && !stop?.aborted) armOutage(probe.error);
  return probe;
}

/** Open the outage window (resident-repos.md item 25): the resident service is
 *  not answering — the transport failing, or the edge's own page for a whole
 *  blip wait — so the next dispatches in the process fall cold without a probe. */
function armOutage(error: string): void {
  probeOutage = { until: systemClock() + PROBE_OUTAGE_WINDOW_MS, error };
}

/** The selection probe, waited through the platform's blip (execution.md
 *  item 9) — a fresh run's selection and a resumed run's re-attach alike, one
 *  function: a 5xx the Worker typed `transient` (the Durable Object reset or
 *  lost under the probe, which the attach's own wait would have waited through
 *  a moment later) or one carrying no Worker document at all (the edge's own
 *  error page, where the Worker never ran) is re-probed on the wake path's one
 *  loop (`waitOnStatus`): at once first — a blip already recovered from costs
 *  no pause, as the wake wait's first view costs none — then every poll, under
 *  the first attach's budget, each probe under the selection's own deadline,
 *  the run's stop riding into the first probe and every re-probe and ending
 *  the wait with its typed error. Every probe goes through `probeResident`,
 *  so a transport failure met inside the wait opens the outage breaker
 *  exactly as the first probe's would (a stop's abort never does); it, the
 *  Worker's own untyped 5xx or any other answer ends the wait at once. A wait
 *  SPENT on the edge's page — more of its views the edge's own page, no Worker
 *  document, than the Worker's typed blip — opens the breaker too (item 25):
 *  that is the platform not answering, and an outage costs one wait, not one
 *  per concurrent dispatch; a wait spent on the Worker's own typed blip does
 *  not, whatever view either ended on. Answers the last view and how long
 *  was waited, on a clock that starts before the first probe — nothing when
 *  the first view was not the blip. */
async function probeThroughBlip(
  cfg: ResidentExecutionConfig,
  token: Secret,
  resource: string,
  span?: Span,
  stopSignal?: AbortSignal,
  /** How long the wait may probe: the first attach's budget, or what a resumed run's lease leaves of it (`leaseClippedBudget`). */
  budgetMs: number = FIRST_ATTACH_WAIT_MS,
): Promise<{ probe: ResidentStatusProbe; waitedMs: number }> {
  const since = systemClock();
  const first = await probeResident(cfg, token, resource, span, stopSignal);
  // The stop aborted the probe: the stop's own typed error, as the loop throws
  // it after each of its probes — never a cold fallback on the view the stop
  // itself produced. A stop pending beside an answer is read where the
  // dispatch reads it, at the attach (execution.md item 9).
  if (first.kind === "unreachable" && first.transport && stopSignal?.aborted) throw wakeStopped("/status");
  // The blip is an ANSWER the platform's transient — the Worker's typed 5xx or
  // the edge's page — never the transport failing, which is the breaker's case
  // and ends the wait at once (awaitWake reads the transport case differently:
  // after a transient refusal it is the same blip there).
  const blip = (view: ResidentStatusProbe): boolean => view.kind === "unreachable" && view.transient === true;
  if (!blip(first)) return { probe: first, waitedMs: 0 };
  let reprobed = false;
  // What the wait was SPENT on, counted over every view it read: the edge's
  // page (no Worker document) against the Worker's own typed blip. The
  // breaker's case is the platform not answering for the wait, never the one
  // view the wait happened to end on — an edge wait that ends on one typed
  // view is still an edge wait; one edge page after a minute of typed blips is not.
  let edgeViews = 0;
  let typedViews = 0;
  const count = (view: ResidentStatusProbe): void => {
    if (view.kind === "unreachable" && view.edge) edgeViews++;
    else typedViews++;
  };
  count(first);
  return waitOnStatus<{ probe: ResidentStatusProbe; waitedMs: number }>({
    first,
    since,
    probe: (signal) => probeResident(cfg, token, resource, span, signal),
    budgetMs,
    signal: stopSignal,
    route: "/status",
    judge: async (view, spent) => {
      if (!blip(view)) return { end: { probe: view, waitedMs: spent() } };
      if (reprobed) count(view); // the first view is counted once, above
      const verdict = reprobed ? "wait" : "again";
      reprobed = true;
      return verdict;
    },
    spent: (last, spentMs) => {
      if (edgeViews > typedViews)
        armOutage(
          `the resident host answered the edge's own page (no Worker document) for ${edgeViews} of ${edgeViews + typedViews} probes over ${Math.round(spentMs / 1000)}s`,
        );
      return { probe: last, waitedMs: spentMs };
    },
  });
}

/** The thread's local workspace directory under `baseDir`: the threadKey is
 *  sanitized to a filesystem-safe slug before resolving. Shared by the local
 *  executor path here and the dispatcher's local Operations backend. */
export function localWorkspaceDir(baseDir: string, threadKey: string): string {
  const safe = threadKey.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return resolve(baseDir, safe);
}

/** What a per-thread backend is built from: the thread, the checkout it
 *  clones (absent = an empty workspace) and the env each command gets. */
interface PerThreadInputs {
  threadKey: string;
  /** the repository to clone and the ref to check out; absent = an empty workspace */
  repo?: string;
  ref?: string;
  /** the sandbox env, resolved per command (docs/reference/specs/execution.md item 5) */
  resolveEnvs: () => Promise<Record<string, string>>;
}

/** A per-thread checkout carries the resolved repo/ref, the run bearer and
 * commit identity pairs. No App credential enters the model workspace. */
function perThreadCheckout(opts: ExecutorFactoryOptions, ctx: ExecutorContext): PerThreadInputs {
  const github = opts.githubCredentials ?? processGithubCredentials;
  github.assertProfileIdentity(ctx.profile.identity, ctx.profile.machine);
  const scope = githubTokenScopeFor(ctx.profile.identity);
  if (scope) {
    if (!ctx.githubDoor)
      throw new Error(`profile identity "${ctx.profile.identity}" requires a GitHub door run bearer`);
    const door = ctx.githubDoor;
    return {
      threadKey: ctx.threadKey,
      repo: ctx.repo,
      ref: ctx.ref,
      resolveEnvs: async () => ({
        ...githubDoorEnvs(door, ctx.repo),
        ...(await gitIdentityEnvs(ctx.profile.identity, authorSourceOf(opts, ctx))),
      }),
    };
  }
  return { threadKey: ctx.threadKey, repo: ctx.repo, ref: ctx.ref, resolveEnvs: async () => ({}) };
}

/** Every model command gets a revocable run bearer for the trusted door,
 * never an installation token or a credential-store copy of it. The checkout
 * itself carries the exact door URL; public GitHub clones stay direct. */
function githubDoorEnvs(
  door: NonNullable<ExecutorContext["githubDoor"]>,
  repo?: string,
  credentialHelper = "!gh auth git-credential",
): Record<string, string> {
  const base = new URL(door.baseUrl);
  const entries = [
    ["credential.helper", ""],
    [`credential.${base.origin}.helper`, credentialHelper],
    ...(base.protocol === "http:" ? [[`url.${base.origin}/.insteadOf`, `https://${base.host}/`]] : []),
  ];
  const gitConfig = Object.fromEntries(
    entries.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  );
  return {
    GH_HOST: base.host,
    GH_ENTERPRISE_TOKEN: door.bearer,
    GIT_DOOR_ORIGIN: base.origin,
    ...(repo ? { GH_REPO: `${base.host}/${repo}`, GIT_DOOR_REMOTE: seedDoorRemote(base.origin, repo) } : {}),
    ...(door.ghConfigDir ? { GH_CONFIG_DIR: door.ghConfigDir } : {}),
    GIT_CONFIG_COUNT: String(entries.length),
    ...gitConfig,
  };
}

function residentDoorEnvs(door: NonNullable<ExecutorContext["githubDoor"]>, repo?: string): Record<string, string> {
  // The resident image has git but does not require gh. This helper reads
  // only the run bearer from the command's own environment, for the door.
  return githubDoorEnvs(
    door,
    repo,
    `!f() { test -n "$GH_ENTERPRISE_TOKEN" || exit 1; printf '%s\\n' 'username=x-access-token' "password=$GH_ENTERPRISE_TOKEN"; }; f`,
  );
}

/** Profile validation stays separate from the GitHub door's trusted-side mint.
 * A model workspace receives only its revocable run bearer. */
const processGithubCredentials: GithubCredentialProvider = {
  assertProfileIdentity,
};

function assertProfileIdentity(identity: Identity, machine: MachineClass): void {
  if (machine === "blank") {
    if (identity !== "none") {
      throw new Error(`machine class "blank" cannot honor profile identity "${identity}"; use identity "none"`);
    }
    return;
  }
  if (identity !== "none" && !githubAppConfigured())
    throw new Error(`profile identity "${identity}" requires the GitHub App for the trusted door`);
}

/** The per-thread backends (the pre-resident selection, unchanged). */
async function makePerThreadExecutor(opts: ExecutorFactoryOptions, input: PerThreadInputs): Promise<Executor> {
  const { threadKey } = input;
  const type = opts.execution?.type ?? "local";

  if (type === "local") {
    const dir = localWorkspaceDir(opts.workspaceDir, threadKey);
    mkdirSync(dir, { recursive: true });
    return new LocalExecutor(dir, input.resolveEnvs);
  }

  if (type === "e2b") {
    const apiKeyEnv = opts.execution?.apiKeyEnv ?? "E2B_API_KEY";
    const apiKey = processSecrets.named(apiKeyEnv);
    if (!apiKey) throw new Error(`execution.type is "e2b" but ${apiKeyEnv} is not set`);
    return E2BExecutor.open({
      apiKey: apiKey.reveal(),
      threadKey,
      timeoutMs: (opts.execution?.timeoutMinutes ?? 30) * 60_000,
      statePath: resolve(opts.dataDir, "sandboxes.json"),
      resolveEnvs: input.resolveEnvs,
      repo: input.repo,
      ref: input.ref,
    });
  }

  if (type === "cloudflare") {
    if (!opts.execution?.url) {
      throw new Error(`execution.type is "cloudflare" but execution.url is not set`);
    }
    const apiKeyEnv = opts.execution.apiKeyEnv ?? "SANDBOX_TOKEN";
    const token = processSecrets.named(apiKeyEnv);
    if (!token) throw new Error(`execution.type is "cloudflare" but ${apiKeyEnv} is not set`);
    const executor = new CloudflareSandboxExecutor({
      url: opts.execution.url,
      token: token.reveal(),
      threadKey,
      resolveEnvs: input.resolveEnvs,
      repo: input.repo,
      ref: input.ref,
      scrubLegacyCredentials: true,
    });
    return executor;
  }

  throw new Error(`Unknown execution.type "${type}" (valid: local, e2b, cloudflare)`);
}

/** Executor for the `none` machine class. Provisions nothing; a tool call
 *  reaching it is a wiring bug (an agent with workspace tools on a machine-less
 *  class) and surfaces as a legible tool error, not a crash. */
class NullExecutor implements Executor {
  constructor(private agentName: string) {}

  private fail(): never {
    throw new Error(
      `Agent "${this.agentName}" runs on machine class "none", so it has no execution workspace. ` +
        `Declare a machine class that provisions one (\`repo-resident\`, \`repo-cold\` or \`blank\`) if its tools need one.`,
    );
  }

  async exec(): Promise<string> {
    this.fail();
  }
  async readFile(): Promise<string> {
    this.fail();
  }
  async writeFile(): Promise<string> {
    this.fail();
  }
}

/** The trusted-side repository probe's scope, derived from the profile.
 * Model commands use the door and never hold the resulting App credential. */
export function githubTokenScopeFor(identity: Identity): GithubTokenScope | undefined {
  return identity === "none" ? undefined : identity;
}

/** Where `gitIdentityEnvs` reads the author from: the run's requester and the
 *  binding store, off the factory's inputs. */
function authorSourceOf(opts: ExecutorFactoryOptions, ctx: ExecutorContext): AuthorEnvSource {
  return {
    ...(ctx.requester !== undefined ? { requester: ctx.requester } : {}),
    ...(opts.bindings !== undefined ? { bindings: opts.bindings } : {}),
  };
}

/** Where the commit identity's author comes from: the run's requester (the
 *  platform-namespaced user id) and the store their binding is read from.
 *  Either absent → no binding is read and the bot pair authors. */
export interface AuthorEnvSource {
  requester?: string;
  bindings?: BindingSource;
}

/** The seams `gitIdentityEnvs` resolves the pairs over — the production
 *  defaults in the bot process, stubs in tests. */
interface GitIdentitySeams {
  bot?: typeof resolveGithubIdentity;
  binding?: typeof bindingOf;
}

/** The commit identity for a run's workspace (record 0062): a `write`
 *  identity's commits are committed by the bot pair always and authored by the
 *  requester's stored binding's pair when the author env is on and the
 *  requester is bound (`bindingOf` — the stored binding only), else by the bot
 *  pair; a `read` or `none` identity gets none of the four. An unknown bot
 *  pair (no GitHub credential) yields none: the images' fallback identity
 *  stands, whose address is off the GitHub domain. The sandbox and E2B receive
 *  the four through the resolver they share with the credential
 *  (docs/reference/specs/execution.md item 5); the resident receives them in
 *  each `/exec` body's `env`. */
export async function gitIdentityEnvs(
  identity: Identity,
  author: AuthorEnvSource,
  seams: GitIdentitySeams = {},
): Promise<Record<string, string>> {
  if (identity !== "write") return {};
  const bot = await (seams.bot ?? resolveGithubIdentity)();
  if (bot === undefined) return {};
  const botPair = pairOfBinding(bot);
  const bound =
    author.requester !== undefined && author.bindings !== undefined
      ? await (seams.binding ?? bindingOf)(author.requester, author.bindings).catch(() => undefined)
      : undefined;
  const authorPair = requesterPairFor(bound) ?? botPair;
  return {
    GIT_AUTHOR_NAME: authorPair.name,
    GIT_AUTHOR_EMAIL: authorPair.email,
    GIT_COMMITTER_NAME: botPair.name,
    GIT_COMMITTER_EMAIL: botPair.email,
  };
}

/** The per-thread executor's backend, from the configured execution type. */
function perThreadBackend(opts: ExecutorFactoryOptions): Backend {
  const type = opts.execution?.type ?? "local";
  return type === "e2b" ? "e2b" : type === "cloudflare" ? "sandbox" : "local";
}
