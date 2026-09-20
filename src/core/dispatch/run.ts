// The run stage of the dispatch pipeline (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// what the model turn needs around it. The ledger claim once the prompt exists;
// the tools' process-wide capabilities (the web fetcher, the GitHub API with
// the requesting user's write gate); and the shutdown notice every live card
// shows during a deploy rollout. The loop itself — the model turn and
// everything that rides on it — is runLoop.ts; `dispatch()` owns the
// transition into it and everything after (the reply is reply.ts, the record
// is record.ts).
import type { ConfigStore, ResolvedRequest } from "../../config.js";
import type { AgentDef } from "../../agents/registry.js";
import type { RouteDecided } from "./route.js";
import {
  coordinatorFields,
  unitOfIdempotencyKey,
  type CoordinatorTag,
  type WorkflowSender,
} from "../coordinator/contract.js";
import type { CoordinatorInstanceStore } from "../coordinator/instanceStore.js";
import type { RunProfile } from "../../config/profile.js";
import { mergeTools, TOOLSETS } from "../../tools/toolsets.js";
import { makeWebCapability } from "../../tools/web.js";
import { RestGithubApi, type GithubApi } from "../../execution/githubApi.js";
import type { GithubCapability } from "../../tools/github.js";
import type { ArtifactStore } from "../../artifacts/store.js";
import type { OpenedPullRequest, OpenPrRef, PullRequestTarget, RepoShipInfo } from "../../execution/githubPulls.js";
import type { DispatchIdentityRewrite } from "../../execution/identityRewrite.js";
import type { ReviewCommentTarget } from "../../execution/githubComments.js";
import { workspaceBindingFor, type ExecutorSelection } from "../../execution/factory.js";
import type { ChatMessage } from "../chatMessage.js";
import type { McpToolsForRun } from "../../mcp/source.js";
import type { RepoContext } from "../repoContext.js";
import type { PrCommitList } from "../headMoved.js";
import { REPLAY_EVERYTHING, type RunHandle, type RunRegistry } from "../runRegistry.js";
import type { RunSeed } from "../runRecord.js";
import type { RunStore } from "../runStore.js";
import type { PlaneService } from "../planeService.js";
import type { RunsService } from "../runsService.js";
import type { LedgerRun } from "../runLedger/writeThrough.js";
import type { Actor, ChannelVisibility } from "../authz/types.js";
import type { Clock, Span } from "../trace/types.js";
import type { IncomingMessage, StatusHandle } from "../types.js";
import type { AdmissionDeps, ResumeContext } from "./admission.js";
import type { AuthorizeDeps } from "./authorize.js";
import type { ProvisionDeps } from "./provision.js";
import type { RecordDeps } from "./record.js";
import { processSecrets } from "../../secrets.js";
import { oneLine, redactAndCap } from "../redact.js";
import type { HarnessRoster } from "../harness/roster.js";
import type { HarnessContainer } from "../harness/container.js";
import type { HarnessRegistry } from "../harness/pi/relay.js";
import type { Executor } from "../../execution/executor.js";
import type { MachineClass } from "../../agents/registry.js";

/** What a run on a harness needs from the process (docs/reference/specs/
 *  harness.md; harness-pi.md): the roster of harness objects runs are driven
 *  by, the registry the harness routes answer from, the bot's URL as the
 *  process reaches it (the public one from a run's container, the bot's own
 *  loopback from the bot host, harness-pi item 12) and, for a test, the
 *  container to drive in place of the run's own. */
export interface HarnessProcessDeps {
  /** The roster (harness.md item 8): every harness this process can drive a
   *  run on, by the name its object declares — `PiHarness` and
   *  `OpenCodeHarness` in production. A fresh run opens on the one the
   *  preset's configuration word names (`harnessForPreset`), a resumed row on
   *  the one its facts name; the loop calls that object — `open`, `find`,
   *  `end` — and compares no word. */
  harnesses: HarnessRoster;
  registry: HarnessRegistry;
  /** `PUBLIC_BASE_URL`, where a run's container reaches the proxy and the
   *  routes; without it no preset with a workspace can go on pi and the run says so. */
  harnessUrl?: string;
  /** `http://127.0.0.1:<PORT>`, where a pi on the bot host reaches this
   *  process's own server; without it no preset without a workspace can go on
   *  pi and the run says so. */
  loopbackUrl?: string;
  /** The container for a run, given its executor and machine class; absent →
   *  `harnessContainerFor`: over the executor for a class with a workspace, the
   *  bot host for `none`. */
  containerFor?: (executor: Executor, machine: MachineClass) => HarnessContainer;
  /** How often the harness polls pi's log and checks the budgets, and the
   *  sleep that paces it, for a test that drives a scripted pi (one under fake
   *  timers hands the harness a clock of its own); absent, the harness's own
   *  cadence on the process's timers. */
  pollMs?: number;
  tickMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** What the run stage reads off the dispatcher's dependencies: the tools'
 *  capabilities (the GitHub API and the per-user write gate), the GitHub seams
 *  the post-steps call, the ledger for the claim, the skills store for the
 *  tool context, the record writer for the finish. `CoreDeps` extends this; a
 *  caller's shape is unchanged. */
export interface RunDeps
  extends
    RecordDeps,
    Pick<AdmissionDeps, "runLedger">,
    Pick<AuthorizeDeps, "fetchPrHead">,
    Pick<ProvisionDeps, "skills" | "runBearers" | "dataDir"> {
  config: ConfigStore;
  /**
   * The harness's process-wide pieces (docs/reference/specs/harness.md): the
   * object runs are driven by and what it needs from the process. Absent (a
   * test of the stages before the loop) → no run can start here, and the run
   * stage says so by name.
   */
  harness?: HarnessProcessDeps;
  /**
   * The durable store of finished runs, READ by a review run for the PR
   * description a coding run submitted for the head it reviews
   * (docs/reference/specs/reading-diff.md item 7). The same store `runHistoryWriter`
   * writes; `NullRunStore` in a process without run history (routing-and-config
   * item 16: a Null Object, never a branch), so the lookup simply finds nothing.
   */
  runStore: RunStore;
  /**
   * The identity rewrite's seam (record 0062; identityRewrite.ts): the start
   * state read at attach, the rewrite before the PR post-step opens or edits,
   * the head pin, the assignee pre-check and write, and the requester's bound
   * login. `dispatchIdentityRewrite(config)` in production; absent (a test of
   * the other paths, a build predating the rewrite) the post-step opens as
   * before.
   */
  identityRewrite?: DispatchIdentityRewrite;
  /**
   * The coordinator's instance records (run-history item 49) — the PR
   * post-step's second guard: a coordinator child whose tag lost the plan's
   * base across a roll reads `instance.base` by `parentInstanceId` before
   * building its PR target, rather than letting the binding ref (the unit
   * branch itself) stand in. Absent → no lookup, and a base still unknown is
   * reported as lost.
   */
  coordinatorInstances?: CoordinatorInstanceStore;
  /**
   * The Workflow sender over the shim's event relay (`shimWorkflowSender`) —
   * the sender the check-run intake already uses — through which the
   * dispatcher nudges a unit's instance when a thread event lands on it
   * (record 0051's reply-as-event rule). Absent (a test, a process without a shim): the
   * nudge fails like any other send failure — the event stays appended and
   * the sender is acked as queued.
   */
  workflow?: WorkflowSender;
  /**
   * The runs service behind the `list_runs` / `get_run_status` tools
   * (docs/reference/specs/agent-conductor.md item 4): the ONE service every
   * surface reads — the command registry's, the run pages' — so a run sees
   * other runs exactly as its requester would. Production wires the service
   * it builds (src/index.ts); absent → one over the registry and `runStore`,
   * without a ledger's foreign rows.
   */
  runs?: RunsService;
  /**
   * The plane service behind the orchestrator preset's `plane_show` tool
   * (record 0070; docs/reference/specs/orchestration-plane.md item 11): the ONE
   * service `plane show` and the `/plane` panel read, so a row the chat cites
   * is the row the panel paints. The loop binds it with the requester's own
   * `runs:read` predicate. Absent → the tool reports the tables unavailable.
   */
  plane?: () => Promise<PlaneService>;
  /**
   * The artifact store (docs/reference/specs/execution.md item 20): where a
   * run's files move by reference when `artifacts:` is configured. Absent →
   * `attach_file` keeps its inline path and no inbound file is copied.
   */
  artifacts?: ArtifactStore;
  /**
   * The GitHub API behind the `github_*` tools (docs/reference/specs/github-tools.md).
   * Absent → the production REST client on the App credential; tests inject an
   * `InMemoryGithubApi`. The per-run capability adds the requesting user's
   * `canUseRepo` write gate (`githubCapabilityFor`).
   */
  githubApi?: GithubApi;
  /**
   * The commits a PR head carries over its base (agent-review.md item 12):
   * asked once for the reviewed head and once for the current one when the
   * head moved during a review run, to tell a rebase of the same commits from
   * a real change. Default: one REST GET per side via repoContext's
   * `prCommitsSince`; undefined (or a throw) → the move is unclassified and
   * the post-step falls back to item 10 (pinned post + note).
   */
  fetchPrCommits?: (q: { repo: string; base: string; sha: string }) => Promise<PrCommitList | undefined>;
  /**
   * Opens the PR for a coding run's pushed branch — or edits the one already
   * open for it (open-or-edit idempotency) — after the run submitted its typed
   * `PrDescription` (docs/reference/specs/pr-description.md item 5). Default: the real
   * GitHub REST call with the App installation token
   * (src/execution/githubPulls.ts; no `gh` shell-out — AGENTS.md invariant 5).
   * Injectable so tests assert the typed inputs without a network call.
   */
  openPullRequest?: (target: PullRequestTarget) => Promise<OpenedPullRequest>;
  /**
   * The open PR heading a branch, or null (githubPulls.findOpenPrByHead): the
   * post-step asks it when a proven-pushed branch comes with no description,
   * so a follow-up that repushed an existing PR's branch is reported as that
   * PR updated, never as "open one manually". Injectable for the same reason.
   */
  findOpenPrByHead?: (repo: string, branch: string) => Promise<OpenPrRef | null>;
  /**
   * Edits a pull request by number (githubPulls.updatePullRequest): the
   * post-step asks it when a description arrives from a workspace on the base
   * in a thread whose own run opened the pull request — the run pushed
   * nothing, so the description is for that PR (docs/reference/specs/pr-description.md
   * item 5). Injectable for the same reason.
   */
  updatePullRequest?: (repo: string, number: number, patch: { title: string; body: string }) => Promise<void>;
  /**
   * The branch's commits over the base (githubPulls.commitsOverBase): the
   * post-step asks it when a proven-pushed branch comes with no description
   * and no open pull request, so a branch with nothing over the base is
   * reported as nothing to open instead of a compare link over an empty diff
   * (docs/reference/specs/agent-ship.md item 12). Injectable for the same reason.
   */
  commitsOverBase?: (repo: string, base: string, branch: string) => Promise<number | undefined>;
  /**
   * Repo facts for the agent:ship entry (docs/reference/specs/agent-ship.md items 9
   * and 10): the repo's default branch, the PR base of last resort — a failed
   * lookup proceeds with none; auto-merge is the pull request's own fact, read
   * with the PR facts and named, never refused. Default: one REST GET via
   * githubPulls' `fetchRepoShipInfo` (App token, never `gh`). Injectable so
   * tests assert the entry without a network call.
   */
  fetchRepoShipInfo?: (repo: string) => Promise<RepoShipInfo | undefined>;
  /**
   * Posts a review back to a PR (docs/reference/specs/agent-review.md item 8): the
   * review post-step, run inside the run loop for a `review` run against a
   * resolved PR unless the request opted out. Default: the real GitHub REST
   * post with the App installation token (App `pull_requests:write`; no `gh`
   * shell-out — AGENTS.md invariant 5). Injectable so tests assert the
   * decision without a network call.
   */
  postReviewComment?: (target: ReviewCommentTarget, body: string) => Promise<void>;
}

/** What `claimRun` reads off the dispatch. */
export interface ClaimContext {
  msg: IncomingMessage;
  agent: AgentDef;
  /** The run's effective profile: the budget the seed carries and the
   *  read-only flag on the row are read from here, never from the preset. */
  profile: RunProfile;
  resolved: ResolvedRequest;
  repoCtx: RepoContext;
  channelVisibility: ChannelVisibility;
  run: RunHandle;
  registry: RunRegistry;
  selection: ExecutorSelection;
  /** The request as the reservation's row carries it (a fresh request or a restart). */
  requestRow: Record<string, unknown> | undefined;
  reserved: LedgerRun | undefined;
  system: string;
  mcpForRun: McpToolsForRun;
  messages: ChatMessage[];
  resume: ResumeContext | undefined;
  /** The handle a resume adopted at admission; undefined for a fresh request. */
  ledgerRun: LedgerRun | undefined;
  card: StatusHandle;
  clock: Clock;
  root: Span;
  /** The run that spawned this one (run-history item 46), when it is a child. */
  parentRunId?: string;
  /** The coordinator's instance and key (item 48), when a coordinator spawned it. */
  coordinator?: CoordinatorTag;
  /** Where the run's conversation starts (item 52), on the row so a reclaim keeps it. */
  seed?: RunSeed;
  /** The router's decision when it chose the preset, on the row (run-history item 35). */
  route?: RouteDecided;
  /** The run this dispatch restarts (record 0064; run-history item 54), on the
   *  row's meta so the plane reads the claim as a restart. */
  restartOf?: string;
  /** Marks the run's card `untracked by the ledger` when the promotion's claim
   *  goes untracked — the same label the reserve-time untracked path sets in
   *  the dispatcher, wired from there because the card's shell lives there. */
  markUntracked?: () => void;
  /** For a seed read from the session's log (session-log item 9): the rows of
   *  the log the first messages of `messages` are, so the write-through
   *  appends only what follows them. */
  seedLog?: { from: number; turns: number };
  /** The author of each seed message by index (record 0057): rides the open
   *  request so the write-through stores the actor on the rows it writes. */
  seedActors?: readonly (string | undefined)[];
}

/**
 * The ledger claim (docs/reference/specs/run-history.md item 35): the run's row on
 * the state Worker with everything a resume must hand the model again, claimed
 * once the prompt exists — a reserved fresh run promotes its reservation; a
 * resume re-subscribes its adopted row past the events already on the ledger.
 * Returns the run's ledger handle: the opened row, the adopted one, or
 * undefined for an untracked run. A throw here leaves the caller's handle as it
 * was, exactly as the inline assignment did.
 */
export async function claimRun(deps: RunDeps, ctx: ClaimContext): Promise<LedgerRun | undefined> {
  const {
    msg,
    agent,
    resolved,
    repoCtx,
    channelVisibility,
    run,
    registry,
    profile,
    selection,
    requestRow,
    reserved,
    system,
    mcpForRun,
    messages,
    resume,
    card,
    clock,
    root,
    parentRunId,
    coordinator,
    seed,
    route,
    seedLog,
    markUntracked,
    seedActors,
  } = ctx;
  const { resident, binding } = selection;
  let ledgerRun = ctx.ledgerRun;
  // Where the run's workspace is (run-history item 54), on the row's state
  // beside the harness facts: the generation that resumes the run re-attaches
  // there instead of provisioning as for a new run.
  const workspaceBinding = workspaceBindingFor(selection, profile.machine);
  // The ledger claim (docs/reference/specs/run-history.md item 35): the run's row on the
  // state Worker, with everything a resume must hand the model again — the
  // composed system prompt and the tool definitions verbatim, the card, the
  // repo context — plus the conversation as its seed. Claimed HERE, once the
  // prompt exists, not at the in-process admission above: a row without a
  // prompt could not be resumed. Awaited (one round trip per run) so the
  // first step's record never precedes its claim. An untracked run (a stale
  // row on the thread, no routes, a claim that kept failing) runs exactly as
  // before — the write-through warned once.
  // Only a reserved run is claimed (item 42): a reservation the ledger refused
  // — another run's row on the thread, no routes, a claim that kept failing —
  // already made this run untracked, with the one warning; asking again
  // would only warn again.
  if (!resume && reserved) {
    const ledger = deps.runLedger;
    const opened = await root.span("dispatch.ledger_claim", () =>
      ledger.open({
        runId: run.id,
        threadKey: msg.threadKey,
        startedAt: registry.snapshot(run.id, run.token)?.startedAt ?? clock(),
        meta: {
          agent: agent.name,
          model: resolved.modelRef,
          channelId: msg.channelId,
          userId: msg.userId,
          threadKey: msg.threadKey,
          channelVisibility,
          ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
          ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
          ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
          ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
          ...(repoCtx.ref !== undefined ? { ref: repoCtx.ref } : {}),
          ...(repoCtx.headSha !== undefined ? { headSha: repoCtx.headSha } : {}),
          ...(repoCtx.pr !== undefined ? { pr: repoCtx.pr } : {}),
          readonly: profile.identity === "read",
          profile,
          ...(parentRunId !== undefined ? { parentRunId } : {}),
          ...(ctx.restartOf !== undefined ? { restartOf: ctx.restartOf } : {}),
          ...coordinatorFields(coordinator),
          ...(seed !== undefined ? { seed } : {}),
          ...(route !== undefined ? { route } : {}),
          selection: resident === true ? "resident" : "sandbox",
          ...(binding?.workspace !== undefined ? { workspace: binding.workspace } : {}),
          ...(requestRow !== undefined ? { request: requestRow } : {}),
        },
        card: card.handle ?? null,
        ...(workspaceBinding !== undefined ? { state: { binding: workspaceBinding } } : {}),
        // The row reserved before the attach (item 42), promoted in place;
        // its hooks (a stop, a fence) were wired at the reservation and stay.
        reservation: reserved,
        system,
        tools: mergeTools(TOOLSETS[agent.toolset] ?? [], mcpForRun?.tools).map(
          ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
        ),
        // The seed carries the EFFECTIVE budget, so a resume runs on what
        // this run was admitted with, not on the preset's own number — and,
        // for a seed read from the log, the rows it reuses (session-log item 9).
        seed: {
          messages,
          budgetMs: profile.minutes * 60_000,
          ...(seedLog ? { log: seedLog } : {}),
          ...(seedActors !== undefined ? { actors: seedActors } : {}),
        },
        // A stop asked of another container (`/runs/stop` there) reaches this
        // run through its heartbeat and is honored like a local one; a fence
        // (another generation took the run) is a hard stop — nothing more may
        // run or reply here (D9).
        onStop: (mode) => void run.control.requestStop(mode),
        onFenced: () => void run.control.requestStop("hard"),
        // The promotion's claim went untracked (failing retries or
        // RouteMissingError) while the reserved row stood: the row is now
        // abandoned and the run is untracked. Publish the note so the record
        // says why, and mark the card as the reserve-time path does — the same
        // one place as the reservation's own note (D9).
        onUntracked: (why) => {
          registry.publish(run.id, {
            type: "run_note",
            kind: "ledger_untracked",
            summary: redactAndCap(
              oneLine(
                `not tracked by the run ledger: ${why} — no handoff, resume or reclaim reaches this run; its record still reaches the store`,
              ),
              500,
            ),
            at: clock(),
          });
          markUntracked?.();
        },
      }),
    );
    // Anything but `tracked` — untracked (the note went through `onUntracked`),
    // fenced, or a process without a ledger — and the run goes on exactly as it
    // did before the ledger existed.
    if (opened.kind === "tracked") {
      const tracked = opened.run;
      ledgerRun = tracked;
      // Every event published so far (the request, run_meta, context) and
      // every one to come, in `seq` order, through the batched flusher. The
      // ledger is a store: the viewer replay budget never applies to it.
      registry.subscribe(run.id, run.token, {
        onEvent: (event, seq) => tracked.event(event, seq),
        ...REPLAY_EVERYTHING,
      });
    }
  }
  // The coordinator tag as a fact of the run (run-history item 48a): published
  // once at dispatch — after the claim's subscription, so the ledger row
  // carries it — so a run re-attached after a bot roll, whose spawn's dispatch
  // options are gone with the process, reads the plan's base back off its own
  // events (carriedCoordinatorTag, dispatch/reattach.ts). A resume republishes
  // nothing: the event is on the adopted row already.
  if (!resume && coordinator) {
    const unit = unitOfIdempotencyKey(coordinator.idempotencyKey);
    registry.publish(run.id, {
      type: "coordinator_tag",
      parentInstanceId: coordinator.parentInstanceId,
      ...(unit !== undefined ? { unit } : {}),
      ...(coordinator.base !== undefined ? { base: coordinator.base } : {}),
      at: clock(),
    });
  }
  if (resume && ledgerRun) {
    // The events before the restart are on the ledger already (and in the
    // registry by replay); only what this generation publishes is appended.
    const adopted = ledgerRun;
    registry.subscribe(run.id, run.token, {
      onEvent: (event, seq) => adopted.event(event, seq),
      afterSeq: resume.lastSeq,
      ...REPLAY_EVERYTHING,
    });
  }
  return ledgerRun;
}

/** The web capability (undici Agent with the SSRF-checking connector + the
 *  search adapter) is built ONCE per process, not per run: the Agent owns the
 *  connection pool, so sharing it lets every run reuse warm TLS sockets to the
 *  same hosts instead of paying a fresh DNS+TCP+TLS handshake per fetch — and a
 *  per-run Agent was never closed, so its keep-alive sockets accumulated. */
let sharedWeb: ReturnType<typeof makeWebCapability> | undefined;
export const webCapability = () => (sharedWeb ??= makeWebCapability(processSecrets));

/** The `github_*` tools' capability for one run (docs/reference/specs/github-tools.md):
 *  the process-wide REST client on the App credential (or the injected test
 *  double) plus the REQUESTING ACTOR's per-repo write gate — `canUseRepo` on
 *  the actor `resolveChatActor` yields (a relay's app ∩ person, a bound
 *  credential's own grants), the same allowlist that admits a user to a
 *  repo's resident — so an issue write from a plain mention is authorized
 *  like a coding run on that repo. */
let sharedGithubApi: GithubApi | undefined;
export function githubCapabilityFor(deps: RunDeps, actor: Actor): GithubCapability {
  const api = deps.githubApi ?? (sharedGithubApi ??= new RestGithubApi());
  return { api, canWrite: (repo) => deps.config.canUseRepo(actor, repo) };
}

/** The notice the drain (src/index.ts) sets on SIGTERM from a deploy rollout.
 *  Exported so the Slack adapter's orphan sweep can strip it from a frozen
 *  card's title — an interrupted card must not keep the stale
 *  "finishing this run" clause. Shared like LIVE_CARD_PREFIXES, so the text
 *  the drain appends and the text the sweep strips cannot drift apart. */
export const DEPLOY_RESTART_NOTICE = "⏸ deploy in progress — this run continues through the bot restart";

/** Set by the process-wide drain (SIGTERM from a deploy rollout) and appended to
 *  every live card's heartbeat frame, so a reader can tell "finishing this run
 *  before the bot restarts" from a run that is merely slow. `undefined` clears
 *  it (tests). A plain module-level value: the drain is process-wide by nature
 *  and every in-flight run must show it, not only runs started after it. */
let notice: string | undefined;
/** The notice every live card shows right now, or undefined outside a drain. */
export function shutdownNotice(): string | undefined {
  return notice;
}
export function setShutdownNotice(next: string | undefined): void {
  notice = next;
}
