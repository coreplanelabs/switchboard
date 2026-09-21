// The agent:ship fork of the dispatch pipeline (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md,
// docs/reference/specs/agent-ship.md items 1, 2, 10, 16): `dispatch()` hands a
// resolved, gated ship request here BEFORE the top-level attach, and the
// branch owns everything from there — the preflight refusals, the one run
// record and card, the hand-off to the plan runner, the reply. The pipeline
// itself — coding → review → fix to LGTM — is the runner's: a Workflow instance
// in the bot's shim Worker whose rounds are child `dispatch()` runs as the
// requesting user (coordinator/handOff.ts writes its input and asks the shim;
// the runner's steps call back into the bot from there), so no round runs in
// this branch and a bot death under a pipeline interrupts a child, never the
// pipeline. The branch reads the run slice plus the seams only ship needs.
import type { AgentDef } from "../../agents/registry.js";
import { chatActorOf } from "../authz/actor.js";
import type { RunProfile } from "../../config/profile.js";
import type { RequestDirectives, ThreadDirectives } from "../../directives.js";
import type { OperatorEventFields } from "./commandRun.js";
import type { LedgerRun, OpenOutcome } from "../runLedger/writeThrough.js";
import type { HostingState } from "../runLedger/types.js";
import { hostKeyOf } from "../runLedger/hostKey.js";
import { systemClock } from "../trace/index.js";
import type { RunOwner } from "../trace/streamSpans.js";
import type { RequestTrace } from "../requestTrace.js";
import type { RepoContext, ResidentSlugs } from "../repoContext.js";
import { residentSlugsLister } from "../../execution/factory.js";
import {
  fetchPullRequestFacts,
  fetchRefExists,
  fetchRepoShipInfo,
  type PullRequestFacts,
} from "../../execution/githubPulls.js";
import { handOffToCoordinator, type HandOffOutcome } from "../coordinator/handOff.js";
import { ALLOWANCES, ASKS, fit, HOSTED_DEADLINE_MARGIN_MINUTES, minutesToMs } from "../budgets.js";
import {
  createInstanceViaShim,
  fetchInstanceStatusViaShim,
  processShimOptions,
} from "../coordinator/instancesClient.js";
import { NullCoordinatorInstanceStore, type CoordinatorInstanceStore } from "../coordinator/instanceStore.js";
import type { CreateInstanceAnswer, InstanceStatusAnswer } from "../coordinator/instancesRoute.js";
import { resolveAddressSeverity, resolveGrant, resolveIdleDays, resolveShipCaps } from "../shipPipeline.js";
import { shipPreflight } from "../ship/preflight.js";
import { redactSecrets, type AgentSource } from "../runEvents.js";
import type { LiveThread } from "../threadAdmission.js";
import type { RouteDecided } from "./route.js";
import { utf8ByteLength, type RunStatus } from "../runRecord.js";
import { assembleRunRecord, channelVisibilityOf, profileRecordOf } from "./record.js";
import { attachmentSuffix, composeRunLabel, humanizeMessageText, isMrkdwnChannel, liveViewLink } from "./reply.js";
import type { DispatchFollowUp } from "./admission.js";
import type { FastPathDeps } from "./fastPath.js";
import { contextMessageTexts } from "./messages.js";
import { analyzeRunFriction, type FrictionDiagnosis } from "../runFriction.js";
import { githubCapabilityFor, shutdownNotice, type RunDeps } from "./run.js";
import { defaultRunRegistry, REPLAY_EVERYTHING } from "../runRegistry.js";
import { createCardShell } from "../statusCardFrame.js";
import type { RunEnding } from "../runEnding.js";
import { messageIdOf, type ChannelIO, type HistoryItem, type IncomingMessage, type StatusHandle } from "../types.js";
import { refusalOf, type Refusal } from "../refusal.js";
import { renderRefusal, replyAck } from "./reply.js";
import { shows, type Verbosity } from "../verbosity.js";
import { REFUSAL_SENTENCES } from "./reply.js";

/** What the ship branch reads: the run slice (the config, the registry and
 *  history writers, the GitHub client the hand-off reads the plan with), the
 *  clock — and the seams only ship uses: the preflight's GitHub facts and the
 *  runner's records and shim. */
export interface ShipDeps extends RunDeps, Pick<FastPathDeps, "clock" | "runRegistry"> {
  /**
   * One PR's entry-check facts for agent:ship (item 10): open/closed, same-repo
   * head, head ref/sha, base, the auto-merge fact — the adopt and resume checks.
   * Default: githubPulls' `fetchPullRequestFacts`. Injectable for tests.
   */
  fetchPrFacts?: (pr: { repo: string; number: number }) => Promise<PullRequestFacts | undefined>;
  /**
   * Whether a branch exists on a repository — the preflight's base check
   * (item 10, issue 1827), one GET refs call before the pipeline branch is
   * cut. Default: githubPulls' `fetchRefExists`. Injectable for tests.
   */
  fetchRefExists?: (repo: string, ref: string) => Promise<boolean | undefined>;
  /**
   * The coordinator's instance records and unit rows on the state Worker
   * (run-history items 49 and 50) — what the hand-off writes before it asks
   * for the Workflow instance. Absent (a process without run history on the
   * Worker): the hand-off refuses by name and nothing runs.
   */
  coordinatorInstances?: CoordinatorInstanceStore;
  /**
   * The bot's request for a coordinator instance: `POST /admin/coordinator/instances`
   * on its own shim with the `coordinator` bearer (agent-ship.md item 16).
   * Default: `createInstanceViaShim` over `PUBLIC_BASE_URL` and the process's
   * token map — unanswered by name when either is missing. Injectable so tests
   * see the id without a network call.
   */
  createCoordinatorInstance?: (id: string) => Promise<CreateInstanceAnswer>;
  /**
   * The bot's read of an earlier attempt's instance status on its own shim
   * (`GET /admin/coordinator/instances/<id>`), before a plan is re-issued.
   * Default: `fetchInstanceStatusViaShim` over the same base URL and token map.
   */
  fetchCoordinatorInstanceStatus?: (id: string) => Promise<InstanceStatusAnswer>;
  /**
   * The resident registry listing, for the no-repo refusal's best guess
   * (record 0054): one bounded call — the probe's timeout, skipped inside a
   * probe-outage window — whose failure leaves the question without a guess.
   * Default: the production lister over the configured resident. Injectable so
   * tests assert the guess without a network call.
   */
  residentSlugs?: ResidentSlugs;
  /**
   * The ship branch itself, so `dispatch()`'s outer finally — the second net
   * of run-history item 42 — is testable with a branch double that opens a
   * registry row and returns without finishing it. Default: `runShipBranch`.
   */
  shipBranch?: typeof runShipBranch;
}

/** How the branch ended, for `dispatch()`'s outer finally (run-history item
 *  42): `hostedLive` names the one run deliberately left `running` — the
 *  hosted parent of a completed hand-off (record 0060), which the plan
 *  runner's `finish` ends — so the second net leaves it live and finishes any
 *  other run the branch left unfinished. The return travels only on the
 *  return path; the net's own signal is the fork's `onHosted`, fired at the
 *  hand-off, so a branch that throws after hosting still leaves the parent live. */
export interface ShipBranchEnd {
  hostedLive: boolean;
}

/** What the agent:ship fork carries out of dispatch()'s prelude — values the
 *  branch must not re-derive, because the gates already ran against them. */
export interface ShipContext {
  /** The ship preset as this deployment declares it (`shipPresetFor`: its
   *  budget is the `ship.maxMinutes` knob) — labels and run meta only. */
  agent: AgentDef;
  /** The run's effective profile (docs/reference/specs/agent-ship.md item 8):
   *  the preset's declared budget as the profile gate clipped it, the
   *  identity and class it admitted. Its minutes are the pipeline's wall
   *  clock, handed to the runner as its caps; the ledger row and the record
   *  carry it like every run's. */
  profile: RunProfile;
  /** The modelRef resolved for the ship request — recorded on the run, never
   *  called; the runner's children resolve their own per-agent models. */
  modelRef: string;
  label: string;
  /** The request's level (routing-and-config item 28): the hand-off's ack is
   *  `verbose` material, the runner instance's id `debug`. */
  verbosity: Verbosity;
  startedAt: number;
  /** The coalesced ack card; the ship branch owns its close from here, and the
   *  runner's `round` route redraws it from the boundaries the machine reports. */
  card: StatusHandle;
  directives: RequestDirectives;
  sticky: ThreadDirectives;
  history: HistoryItem[];
  repoCtx: RepoContext;
  /** The thread's admission slot this dispatch holds (thread-admission item
   *  1): the ship branch names its run on it once registered, so a refused
   *  follow-up in a live ship thread links the run page like any other. */
  live: LiveThread<DispatchFollowUp>;
  /** The dispatch's run ending: the ship run seals after its reply like any other. */
  ending: RunEnding;
  /** The request's trace (docs/reference/specs/tracing.md): the ship run binds to it, its steps are spans under the root. */
  trace: RequestTrace;
  /** The card's shape and queued lines at a close, from the dispatch's window. */
  closeLines: (end: number, finished: boolean, owner?: RunOwner) => { shape?: string; queued?: string };
  /** A refusal as one `dispatch.refuse` span: the site's `Refusal`, the side
   *  work inside the span, the sentence rendered in one place. */
  refuse: (refusal: Refusal, side?: () => Promise<void>) => Promise<void>;
  /** The done card's shape and queued lines, from the finish-site diagnosis. */
  doneLines: (diagnosis: FrictionDiagnosis | undefined) => { shape?: string; queued?: string };
  /** How the ship preset was chosen (`run_meta.agentSource`). */
  agentSource: AgentSource;
  /** Called the moment the parent becomes the hosted run of a completed
   *  hand-off (record 0060), BEFORE anything after it can throw: the second
   *  net (run-history item 42) reads this signal, not the return value, so
   *  a throw on the reply or card-close path never finishes the hosted
   *  parent `failed`. */
  onHosted?: () => void;
  /** The router's decision when it chose ship (routing-and-config item 21):
   *  the record's `route` event, published like the main path's. */
  route?: RouteDecided;
  /** The operator's decision when it bound ship (routing-and-config item 29;
   *  run-history item 60): the record's `operator` event, published beside
   *  `run_meta` like the main path's registration does. */
  operator?: OperatorEventFields;
}

/**
 * The agent:ship branch (docs/reference/specs/agent-ship.md): preflight refusals, then
 * the ONE run record + card shell around the hand-off to the plan runner — the
 * ship counterpart of the main path's run shell, reusing the same label,
 * event, record, and friction vocabulary so /runs shows the request exactly
 * like any run; the runner's `finish` writes the plan's story under this run's
 * id once the instance ends. Handled endings — the runner took it, or refused
 * it by name — reply here; an unexpected throw closes the card, persists the
 * `failed` record, and propagates to dispatch()'s outer catch for the error
 * reply.
 */
export async function runShipBranch(
  deps: ShipDeps,
  msg: IncomingMessage,
  io: ChannelIO,
  ctx: ShipContext,
): Promise<ShipBranchEnd> {
  const { agent, profile, card, directives, history, repoCtx, label, ending, trace, closeLines, refuse, doneLines } =
    ctx;
  const root = trace.root;
  const clock = deps.clock ?? systemClock;
  // The same one-builder card shell as the main path, on the same label and clock.
  const shell = createCardShell({ label, startedAt: ctx.startedAt, now: clock });
  // Record 0054: only a request that resolved NO repository pays for the
  // registry listing, and only to guess the one the person meant.
  const listSlugs = deps.residentSlugs ?? residentSlugsLister(deps.config.config.execution?.resident);
  const repoCandidates = repoCtx.repo ? undefined : await listSlugs?.().catch(() => undefined);
  const pre = await root.span("dispatch.ship_preflight", () =>
    shipPreflight({
      channelId: msg.channelId,
      threadKey: msg.threadKey,
      // The request handle's capability (record 0060, agent-ship item 1): the
      // runner opens each unit's thread through this handle, so what admits a
      // channel is that it can — never a prefix list.
      canOpenThread: io.openThread !== undefined,
      requestText: directives.text,
      repoCtx,
      ...(repoCandidates && repoCandidates.length > 0 ? { repoCandidates } : {}),
      gates: {
        canRunAgent: (a) => deps.config.canRunAgent(chatActorOf(deps.config, msg), a),
        adminsHint: () => deps.config.adminsHint(),
      },
      repoInfo: deps.fetchRepoShipInfo ?? fetchRepoShipInfo,
      prFacts: deps.fetchPrFacts ?? fetchPullRequestFacts,
      refExists: deps.fetchRefExists ?? fetchRefExists,
      runsBase: process.env.PUBLIC_BASE_URL,
    }),
  );
  if (!pre.ok) {
    console.log(`[ship] ${msg.threadKey} not started: ${pre.where}`);
    const refusal =
      pre.guess === undefined
        ? pre.refusal
        : {
            ...pre.refusal,
            guess: {
              proposal: { ...msg, text: pre.guess.line },
              line: pre.guess.line,
              evidence: pre.guess.evidence,
            },
          };
    await refuse(refusal, () =>
      card.done(shell.close({ kind: "refused", icon: "🚫", reason: pre.card, ...closeLines(clock(), false) })),
    );
    return { hostedLive: false };
  }
  const entry = pre.entry;

  // The runner's caps (agent-ship.md item 8): the rounds cap is the config
  // block's; the wall clock is the parent's effective budget — the preset's
  // declared `ship.maxMinutes` as a boundary or a `budget:` directive clipped
  // it — so every child round the runner spawns is clipped to what remains of THAT.
  const caps = { ...resolveShipCaps(deps.config.config.ship), maxMinutes: profile.minutes };
  // The fit at the fork (agent-ship item 8, decision 0046): a boundary or a
  // `budget:` directive that clipped the pipeline under the loop it allows is
  // refused here with the sum on the card, never carved into a child that
  // cannot do useful work. The check runs BEFORE the run record or ledger row
  // is created, so a refused start writes no live row and the thread's next
  // run is tracked.
  const held = fit(caps);
  if (!held.ok) {
    const reason = `budget ${caps.maxMinutes} min cannot hold the ship loop (${caps.maxRounds} review rounds need ${held.need} min)`;
    console.log(`[ship] ${msg.threadKey} not started: ${reason}`);
    await refuse(
      refusalOf(
        "ship_budget",
        REFUSAL_SENTENCES.ship_budget({
          maxMinutes: caps.maxMinutes,
          maxRounds: caps.maxRounds,
          need: held.need,
          provision: ALLOWANCES.provision,
          coding: ASKS.coding,
        }),
      ),
      () => card.done(shell.close({ kind: "refused", icon: "🚫", reason, ...closeLines(clock(), false) })),
    );
    return { hostedLive: false };
  }

  // The one run record: registered and stamped exactly like the main
  // path — input, run_meta, bounded context, the tombstone.
  const registry = deps.runRegistry ?? defaultRunRegistry;
  const channelVisibility = await root.span("dispatch.channel_visibility", () =>
    channelVisibilityOf(deps, msg.channelId),
  );
  const runLabel = composeRunLabel({
    agent: agent.name,
    repo: repoCtx.repo,
    channelId: msg.channelId,
    userId: msg.userId,
    channelName: msg.channelName,
    userName: msg.userName,
    text: directives.text,
  });
  const run = registry.create(runLabel, {
    hosted: true,
    agent: agent.name,
    model: ctx.modelRef,
    channelId: msg.channelId,
    userId: msg.userId,
    threadKey: msg.threadKey,
    channelVisibility,
    receivedAt: trace.receivedAt,
    ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
    ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
    ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
    ...(msg.authenticatedAs !== undefined ? { authenticatedAs: msg.authenticatedAs } : {}),
  });
  let ledgerRun: LedgerRun | undefined;
  let outcome: HandOffOutcome | undefined;
  let shipDiagnosis: FrictionDiagnosis | undefined;
  // The parent stays live after a tracked, taken hand-off (record 0060): set
  // once the instance exists and the ledger still mirrors this run, and from
  // then on the branch skips the finish, `finishing` and the seal — the
  // runner's `finish` ends the run, and a reclaim re-hosts or closes the row.
  // Every other exit after the host-key claim — a refused hand-off, a throw —
  // finishes as today, so no host-keyed row outlives a request that handed
  // nothing off.
  let hostedLive = false;
  // From the registry row on, everything runs inside the try whose finally
  // finishes the run: a throw before the hand-off — the ledger claim with the
  // state Worker down — ends like a throw inside it, a finished `failed` run
  // with its record and a closed card. On every exit but the hosted one a
  // registry row left `running` would have no runner behind it — it cannot be
  // stopped (a stop is a request to the runner) and holds the process's drain
  // to its deadline — so no such exit leaves one; the hosted row stays
  // `running` deliberately, with the plan runner behind it (record 0060).
  try {
    io.runStarted?.({ id: run.id });
    const publishText = (
      type: "input" | "context" | "answer",
      text: string,
      source?: { url?: string; channel?: string; user?: string },
    ) => {
      const redacted = redactSecrets(text);
      const body = { text: redacted, ...(source ? { source } : {}), at: clock() };
      registry.publish(
        run.id,
        type === "input" ? { type, messageId: messageIdOf(msg, run.id), ...body } : { type, ...body },
      );
      console.log(`[event] ${msg.threadKey} type=${type} bytes=${utf8ByteLength(redacted)}`);
    };
    const humanize = isMrkdwnChannel(msg.channelId);
    const attachments = attachmentSuffix(msg.images, msg.documents);
    const source = {
      ...(msg.sourceUrl ? { url: msg.sourceUrl } : {}),
      ...(msg.channelName ? { channel: msg.channelName } : {}),
      ...(msg.userName ? { user: msg.userName } : {}),
    };
    const request = humanize ? humanizeMessageText(directives.text) : directives.text;
    publishText(
      "input",
      attachments ? `${request} ${attachments}` : request,
      Object.keys(source).length > 0 ? source : undefined,
    );
    registry.publish(run.id, {
      type: "run_meta",
      agent: agent.name,
      agentSource: ctx.agentSource,
      model: ctx.modelRef,
      traceId: root.traceId,
      ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
      ...(entry.resume !== undefined ? { pr: entry.resume.pr } : {}),
      at: clock(),
    });
    if (ctx.route) registry.publish(run.id, { type: "route", ...ctx.route, at: clock() });
    if (ctx.operator) registry.publish(run.id, { type: "operator", ...ctx.operator, at: clock() });
    if (deps.config.config.runHistory?.includeContext !== false) {
      for (const text of contextMessageTexts(history, humanize)) publishText("context", text);
    }
    // Tombstone-first, like the main path: the provisional terminal record
    // stands until the hand-off answers, so a kill between the two still leaves
    // a record that says the request never reached the runner.
    const startSnap = registry.snapshot(run.id, run.token);
    if (startSnap) {
      deps.runHistoryWriter.write(
        assembleRunRecord({
          run,
          snap: startSnap,
          agent: agent.name,
          model: ctx.modelRef,
          msg,
          channelVisibility,
          repo: repoCtx.repo,
          hosted: true, // the ship parent's run is created hosted (record 0060)
          finishedAt: startSnap.startedAt,
          status: "interrupted",
          diagnosis: analyzeRunFriction(startSnap.events, {
            finished: false,
            truncated: startSnap.truncated,
          }),
          profile: profileRecordOf(agent, profile),
        }),
        { provisional: true },
      );
    }
    // The ledger claim (run-history item 35) for the live index and the finish,
    // under the HOST KEY (record 0060; run-history item 29): the thread key plus
    // `#host`, while the row's metadata names the thread itself — the ledger's
    // occupancy check never sees the parent, every listing and record files it
    // under its conversation, and a second pipeline in the thread is the one
    // claim the host key refuses. The request has no model loop of its own — the
    // runner's children each run `runAgent` as runs of their own — so it is
    // claimed without a seed or step records (and registers no session) and
    // closes `interrupted` at a reclaim. Untracked for any reason but
    // `thread-live` (a process without a ledger, missing routes) → the hand-off
    // runs as before; `thread-live` on the host key is refused below by name.
    const hostKey = (() => {
      try {
        return hostKeyOf(msg.threadKey);
      } catch (err) {
        // A thread key the suffix cannot ride (over the ledger's cap, or already
        // suffixed): the claim the ledger would refuse anyway is never made, and
        // the run goes on untracked, as any refused claim leaves it.
        console.warn(`[ship] ${msg.threadKey} not tracked: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    })();
    const opened: OpenOutcome = !hostKey
      ? { kind: "untracked", why: "the thread key cannot carry the host suffix" }
      : await root.span("dispatch.ledger_claim", () =>
          deps.runLedger.open({
            runId: run.id,
            threadKey: hostKey,
            startedAt: registry.snapshot(run.id, run.token)?.startedAt ?? clock(),
            meta: {
              hosted: true,
              label: runLabel,
              agent: agent.name,
              model: ctx.modelRef,
              channelId: msg.channelId,
              userId: msg.userId,
              threadKey: msg.threadKey,
              channelVisibility,
              ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
              ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
              ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
              ...(msg.authenticatedAs !== undefined ? { authenticatedAs: msg.authenticatedAs } : {}),
              ...(msg.postedBy !== undefined ? { postedBy: msg.postedBy } : {}),
              ...(entry.resume !== undefined ? { pr: entry.resume.pr } : {}),
              profile,
            },
            card: card.handle ?? null,
            system: "",
            tools: [],
            onStop: (mode) => void run.control.requestStop(mode),
            onFenced: () => void run.control.requestStop("hard"),
          }),
        );
    ledgerRun = opened.kind === "tracked" ? opened.run : undefined;
    if (ledgerRun) {
      const tracked = ledgerRun;
      registry.subscribe(run.id, run.token, {
        onEvent: (event, seq) => tracked.event(event, seq),
        ...REPLAY_EVERYTHING,
      });
    }
    // One pipeline per thread (record 0060; agent-ship item 16): the host key's
    // claim answering `thread-live` means another pipeline is hosted in this
    // thread right now — refused by name, never run untracked beside it. Every
    // other non-tracked answer hands off as before.
    const hostRefused = opened.kind === "untracked" && opened.why === "thread-live";

    const liveUrl = liveViewLink(run.id, run.token);
    ctx.live.runId = run.id;
    if (liveUrl) ctx.live.runLink = liveUrl;
    trace.bindRun(run.id, (e) => registry.publish(run.id, e));

    console.log(
      `[run] ${msg.threadKey} user=${msg.userId} agent=ship model=${ctx.modelRef} entry=${entry.resume ? `resume ${entry.repo}#${entry.resume.pr}` : `round0 ${entry.branch}`}`,
    );
    card.update(shell.live({ notice: shutdownNotice() }));
    shell.setLink(liveUrl ? { url: liveUrl, label: "Live run" } : undefined);
    // The severity to address, resolved once here — the request's
    // `severity:` directive over the user's scope over the channel's over the
    // org's — and handed to the runner on the instance beside `merge`.
    const scopes = deps.config.scopes(msg.channelId, msg.userId);
    const addressSeverity = resolveAddressSeverity({
      org: deps.config.config.review?.addressSeverity,
      channel: scopes.channel.review?.addressSeverity,
      user: scopes.user.review?.addressSeverity,
      run: directives.severity,
    });
    // The grant (decision 0046, the renewable lease), resolved once here the
    // same way — the request's `renewals:` count over the user's scope over the
    // channel's over the org's `ship.grant` — and written on the instance beside
    // `merge`. Zero renewals by default: nothing renews until someone says so.
    const grant = resolveGrant({
      org: deps.config.config.ship?.grant,
      channel: scopes.channel.ship?.grant,
      user: scopes.user.ship?.grant,
      run: directives.renewals,
    });
    // The idle flag (record 0051), resolved once here the same way — user over
    // channel over the org's `ship.idleDays` — and written on the instance
    // beside the grant. Zero by default: nothing idles until someone says so.
    const idleDays = resolveIdleDays({
      org: deps.config.config.ship?.idleDays,
      channel: scopes.channel.ship?.idleDays,
      user: scopes.user.ship?.idleDays,
    });
    const shim = processShimOptions;
    // The hand-off (agent-ship.md item 16): the request — a plan, a task, or a
    // resume at review — becomes a plan runner instance; the bot writes the
    // records, asks its shim for the Workflow, and this run ends with where the
    // plan runs. A deployment without the runner's prerequisites — run history
    // on the state Worker, `PUBLIC_BASE_URL`, the `coordinator` bearer — is
    // refused by name here, never run some other way. A thread whose pipeline
    // is live (the host key's `thread-live`) is refused the same way: an
    // aborted outcome through the refusal seam, nothing handed to the runner.
    outcome = hostRefused
      ? {
          status: "aborted",
          reply: REFUSAL_SENTENCES.ship_thread_live(),
          refusal: refusalOf("ship_thread_live", REFUSAL_SENTENCES.ship_thread_live()),
        }
      : await root.span("dispatch.ship_hand_off", () =>
          handOffToCoordinator(
            {
              readFile: (repo, path, ref, opts) =>
                githubCapabilityFor(deps, chatActorOf(deps.config, msg)).api.readFile(repo, path, ref, opts),
              instances: deps.coordinatorInstances ?? new NullCoordinatorInstanceStore(),
              create: deps.createCoordinatorInstance ?? ((id) => createInstanceViaShim(shim(), id)),
              status: deps.fetchCoordinatorInstanceStatus ?? ((id) => fetchInstanceStatusViaShim(shim(), id)),
            },
            {
              entry,
              requestText: directives.text,
              msg,
              agentSource: ctx.agentSource,
              runId: run.id,
              label,
              caps,
              addressSeverity,
              grant,
              verbosity: ctx.verbosity,
              idleDays,
              ...(card.handle !== undefined ? { card: card.handle } : {}),
              now: clock(),
            },
          ),
        );
    // The instance the hand-off created enters the stream first (record 0051
    // R2): projected onto `RunRecord.instanceId`, it is how the thread's owner
    // rule finds the plan runner from the page's ship run. None after a refusal.
    if (outcome.instanceId !== undefined) {
      registry.publish(run.id, { type: "ship_handoff", instanceId: outcome.instanceId, at: clock() });
      if (outcome.status === "completed" && ledgerRun?.tracked() === true) {
        // The runner took it and the ledger mirrors this run: the parent stays
        // live, hosting the instance. The row's state carries the instance and
        // the deadline a reclaim judges it by — the pipeline's wall clock plus
        // an hour of the runner's own scheduling slack — and the stream gets a
        // second `run_meta` naming the instance, the fact every reader of a
        // run's instance id resolves from the last `run_meta` carrying one.
        hostedLive = true;
        ctx.onHosted?.();
        const hosting: HostingState = {
          instanceId: outcome.instanceId,
          until: clock() + minutesToMs(caps.maxMinutes + HOSTED_DEADLINE_MARGIN_MINUTES),
        };
        ledgerRun.setState({ hosting });
        registry.publish(run.id, {
          type: "run_meta",
          agent: agent.name,
          agentSource: ctx.agentSource,
          model: ctx.modelRef,
          traceId: root.traceId,
          instanceId: outcome.instanceId,
          at: clock(),
        });
      }
    }
    // The run record is the source of truth: the answer enters the stream
    // BEFORE finish() below (a publish on a finished run is a no-op).
    publishText("answer", outcome.reply);
  } finally {
    // A throw passes through to dispatch()'s outer catch (the error reply, the
    // drain); this block still finishes the run, registers its `failed` record
    // and closes the card. A hosted hand-off skips it whole: the run is live
    // for the pipeline's life, and the runner's `finish` writes its record.
    // RunStatus is the run-store contract (shared with the memory worker): a
    // refused hand-off still answered the request, so record and registry say
    // `completed` — the refusal lives in the reply and the card close below.
    if (!hostedLive) {
      const status: RunStatus = outcome === undefined ? "failed" : "completed";
      registry.finish(run.id, status);
      const snap = registry.snapshot(run.id, run.token);
      const finishedAt = snap?.finishedAt ?? clock();
      const diagnosis = analyzeRunFriction(snap?.events ?? [], {
        finished: true,
        truncated: snap?.truncated ?? false,
        window: { start: trace.receivedAt, end: finishedAt },
      });
      shipDiagnosis = diagnosis;
      io.runFinished?.({ id: run.id, status });
      ending.finished(run.id);
      shell.freeze(finishedAt);
      // Mirrors the main path: a completed hand-off whose final reply throws is
      // recorded `failed` — the thread never saw where the plan runs. Written by
      // the drain after the seal; a throw reaches dispatch()'s outer catch, which
      // drains. A tracked run finishes through the ledger sink, which also
      // closes its row.
      ending.register({
        runId: run.id,
        flipOnPostFinishFailure: true,
        write: (seal, failedAfterFinish) =>
          deps.runHistoryWriter.write(
            assembleRunRecord({
              run,
              snap,
              agent: agent.name,
              model: ctx.modelRef,
              msg,
              channelVisibility,
              repo: repoCtx.repo,
              hosted: true,
              finishedAt,
              status: failedAfterFinish && status === "completed" ? "failed" : status,
              diagnosis,
              seal,
              profile: profileRecordOf(agent, profile),
            }),
            { span: root, ...(ledgerRun ? { via: ledgerRun.sink } : {}) },
          ),
      });
      // A hand-off that threw closes its card here, after the finish, so the
      // card's total is the run's.
      if (outcome === undefined)
        await root
          .span("post.card_close", () => card.done(shell.close({ kind: "done", icon: "❌", ...doneLines(diagnosis) })))
          .catch(() => {});
    }
  }
  if (!outcome) return { hostedLive }; // unreachable: the finally above rethrew
  console.log(
    `[${hostedLive ? "hosted" : "done"}] ${msg.threadKey} ship ${outcome.reply.length} chars (${outcome.status})`,
  );
  // The close tells the truth about HOW the request ended: ✅ when the runner
  // took it (the runner's `round` route redraws this card from there), ⚠️
  // when the hand-off refused it by name.
  const icon = outcome.status === "completed" ? "✅" : "⚠️";
  if (hostedLive) {
    // The hosted parent (record 0060): no `finishing`, no seal — the run and
    // its ledger row stay live until the runner's `finish` — but the ack card
    // still closes ✅ (the runner's `round` route redraws it from there) and
    // the thread still hears where the plan runs. The drain inside
    // `sealAfterReply` has nothing registered for this run, so it seals nothing.
    await ending.sealAfterReply(
      () =>
        root.span("post.card_close", () => card.done(shell.close({ kind: "done", icon, ...doneLines(shipDiagnosis) }))),
      () => root.span("post.reply", () => replyAck(io, ctx.verbosity, handOffAck(outcome, ctx.verbosity))),
    );
    return { hostedLive };
  }
  ledgerRun?.setState({ finalStatus: "completed" });
  if ((await root.span("post.ledger_finishing", () => ledgerRun?.finishing())) === "fenced") {
    console.log(`[ship] ${msg.threadKey} run ${run.id}: another generation owns this run — not replying`);
    ending.drop(run.id); // the record is the other generation's; the outer finally still seals the stream here
    return { hostedLive };
  }
  // The card close, the reply, then the drain: sealed with how the reply went,
  // the record written after the seal (fire-and-forget; the writer's
  // `pending()` counts it for the shutdown drain). A reply that never reached
  // the thread flips the record to `failed`, never `completed` — the main
  // path's invariant — and the throw reaches the outer catch; the registry row
  // keeps its terminal status for the TTL, exactly like the main path.
  await ending.sealAfterReply(
    () =>
      root.span("post.card_close", () => card.done(shell.close({ kind: "done", icon, ...doneLines(shipDiagnosis) }))),
    () =>
      root.span("post.reply", () =>
        outcome.refusal
          ? renderRefusal(outcome.refusal, io)
          : replyAck(io, ctx.verbosity, handOffAck(outcome, ctx.verbosity)),
      ),
  );
  return { hostedLive };
}

/** The accepted hand-off's ack: its reply, and at `debug` the runner
 *  instance's id under it — the handle an operator re-issues or reads the
 *  Workflow by, and noise for anyone else. */
export function handOffAck(outcome: HandOffOutcome, verbosity: Verbosity): string {
  return outcome.instanceId !== undefined && shows(verbosity, "debug")
    ? `${outcome.reply}\n• runner instance \`${outcome.instanceId}\``
    : outcome.reply;
}
