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
import { mergeTools } from "../../runner.js";
import { TOOLSETS } from "../../tools/workspace.js";
import { makeWebCapability } from "../../tools/web.js";
import { RestGithubApi, type GithubApi } from "../../execution/githubApi.js";
import type { GithubCapability } from "../../tools/github.js";
import type { OpenedPullRequest, OpenPrRef, PullRequestTarget, RepoShipInfo } from "../../execution/githubPulls.js";
import type { ExecutorSelection } from "../../execution/factory.js";
import type { ChatMessage } from "../../providers/types.js";
import type { McpToolsForRun } from "../../mcp/source.js";
import type { RepoContext } from "../repoContext.js";
import type { PrCommitList } from "../headMoved.js";
import { REPLAY_EVERYTHING, type RunHandle, type RunRegistry } from "../runRegistry.js";
import type { RunStore } from "../runStore.js";
import type { LedgerRun } from "../runLedger/writeThrough.js";
import type { ChannelVisibility } from "../authz/types.js";
import type { Clock, Span } from "../trace/types.js";
import type { IncomingMessage, StatusHandle } from "../types.js";
import type { AdmissionDeps, ResumeContext } from "./admission.js";
import type { AuthorizeDeps } from "./authorize.js";
import type { ProvisionDeps } from "./provision.js";
import type { RecordDeps } from "./record.js";
import { processSecrets } from "../../secrets.js";

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
    Pick<ProvisionDeps, "skills"> {
  config: ConfigStore;
  /**
   * The durable store of finished runs, READ by a review run for the PR
   * description a coding run submitted for the head it reviews
   * (docs/reference/specs/reading-diff.md item 7). The same store `runHistoryWriter`
   * writes; `NullRunStore` in a process without run history (routing-and-config
   * item 16: a Null Object, never a branch), so the lookup simply finds nothing.
   */
  runStore: RunStore;
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
   * Repo facts for the agent:ship gate (docs/reference/specs/agent-ship.md item 9): the
   * `allow_auto_merge` flag — ship refuses when it is enabled OR unknown
   * (fail-closed: an LGTM into auto-merge would merge with no human) — and
   * the repo's default branch, the PR base of last resort. Default: one REST
   * GET via githubPulls' `fetchRepoShipInfo` (App token, never `gh`).
   * Injectable so tests assert the refusal without a network call.
   */
  fetchRepoShipInfo?: (repo: string) => Promise<RepoShipInfo | undefined>;
}

/** What `claimRun` reads off the dispatch. */
export interface ClaimContext {
  msg: IncomingMessage;
  agent: AgentDef;
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
  } = ctx;
  const { resident, binding } = selection;
  let ledgerRun = ctx.ledgerRun;
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
          readonly: agent.toolset === "readonly",
          selection: resident === true ? "resident" : "sandbox",
          ...(binding?.workspace !== undefined ? { workspace: binding.workspace } : {}),
          ...(requestRow !== undefined ? { request: requestRow } : {}),
        },
        card: card.handle ?? null,
        // The row reserved before the attach (item 42), promoted in place;
        // its hooks (a stop, a fence) were wired at the reservation and stay.
        reservation: reserved,
        system,
        tools: mergeTools(TOOLSETS[agent.toolset] ?? [], mcpForRun?.tools).map(
          ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
        ),
        seed: { messages, budgetMs: agent.maxMinutes * 60_000 },
        // A stop asked of another container (`/runs/stop` there) reaches this
        // run through its heartbeat and is honored like a local one; a fence
        // (another generation took the run) is a hard stop — nothing more may
        // run or reply here (D9).
        onStop: (mode) => void run.control.requestStop(mode),
        onFenced: () => void run.control.requestStop("hard"),
      }),
    );
    if (opened) {
      ledgerRun = opened;
      // Every event published so far (the request, run_meta, context) and
      // every one to come, in `seq` order, through the batched flusher. The
      // ledger is a store: the viewer replay budget never applies to it.
      registry.subscribe(run.id, run.token, {
        onEvent: (event, seq) => opened.event(event, seq),
        ...REPLAY_EVERYTHING,
      });
    }
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
 *  double) plus the REQUESTING USER's per-repo write gate — `canUseRepo`, the
 *  same allowlist that admits a user to a repo's resident — so an issue
 *  write from a plain mention is authorized like a coding run on that repo. */
let sharedGithubApi: GithubApi | undefined;
export function githubCapabilityFor(deps: RunDeps, userId: string): GithubCapability {
  const api = deps.githubApi ?? (sharedGithubApi ??= new RestGithubApi());
  return { api, canWrite: (repo) => deps.config.canUseRepo(userId, repo) };
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
