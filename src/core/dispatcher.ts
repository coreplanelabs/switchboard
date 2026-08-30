import type { ConfigStore } from "../config.js";
import { configAwarenessBlock } from "./configAwareness.js";
import { customInstructionsBlock } from "./customInstructions.js";
import { getAgent } from "../agents/registry.js";
import { lastThreadDirectives, parseDirectives } from "../directives.js";
import { runAgent } from "../runner.js";
import { makeWebCapability } from "../tools/web.js";
import { makeExecutor, residentOnboardedProbe } from "../execution/factory.js";
import { ResidentNeedsRefError } from "../execution/resident.js";
import { parseModelRef, type ChatMessage, type ContentPart } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { currentPrHeadSha, prCommitsSince, resolveRepoContext, type RepoContext } from "./repoContext.js";
import {
  carriedFooter,
  classifyHeadMove,
  headCarriedNote,
  headMovedNote,
  headRereviewNote,
  rereviewFollowUp,
  type HeadMove,
  type PrCommitList,
} from "./headMoved.js";
import { decideReviewPost, reviewPostIntended, reviewPostOptedOut, type ReviewPostTarget } from "./reviewPost.js";
import { postReviewComment, type ReviewCommentTarget } from "../execution/githubComments.js";
import { buildReviewPostBody, type ReviewVerdict } from "./reviewVerdict.js";
import { checkReviewedHead, normalizeHead, parseRevParseOutput, sameCommit } from "./reviewedHead.js";
import { reviewTargetBlock } from "./reviewTarget.js";
import { recognizeOperation } from "./operations.js";
import { memoryContextBlock, scheduleReflection, type MemoryStore } from "./memory/index.js";
import { skillGuidanceBlock, type SkillStore } from "../skills/index.js";
import { formatTurnDuration, redactSecrets, type RunEvent } from "./runEvents.js";
import { fitRecordToBudget, utf8ByteLength, type RunRecord, type RunStatus } from "./runRecord.js";
import type { RunHistoryWriter } from "./runHistoryWriter.js";
import { analyzeRunFriction, type FrictionDiagnosis } from "./runFriction.js";
import type { FrictionLedger } from "./frictionLedger.js";
import type { IssueTracker } from "../execution/githubIssues.js";
import { invokeChatCommand, parseChatCommand, type ChatCommandResult, type ChatCommands, type ParsedChatCommand } from "./commandChat.js";
import { cliWords } from "./commandSurface.js";
import { activityOfEvents, defaultRunRegistry, type RunHandle, type RunRegistry, type RunSnapshot } from "./runRegistry.js";
import { PlainTextFormatter, type ChannelFormatter } from "./structuredMessage.js";
import { coalesceStatus } from "./statusCoalescer.js";
import { produceStructured, providerProducer } from "./structuredOutput.js";
import type { Provider } from "../providers/types.js";
import type {
  ChannelIO,
  DocumentAttachment,
  HistoryItem,
  ImageAttachment,
  IncomingMessage,
  StatusHandle,
} from "./types.js";

// The dispatcher is the channel-agnostic core: config commands, directive
// parsing, layered resolution, permission gates, history assembly, executor
// selection, and the agent run. Channels are pure transports (src/channels/).

export interface CoreDeps {
  config: ConfigStore;
  providers: ProviderRegistry;
  /** where runtime state (sandboxes.json) lives; default ./data */
  dataDir?: string;
  /**
   * Resolves the target repo/ref for a message (resident environments).
   * Defaults to the production resolver in repoContext.ts (explicit repo/PR/
   * branch signals in the message, then the thread-established repo from
   * history); injectable for tests. No repo signal → {} → the per-thread
   * executor path with no resident probe (total input contract).
   */
  resolveRepoContext?: (
    msg: IncomingMessage,
    history: HistoryItem[],
  ) => Promise<RepoContext> | RepoContext;
  /**
   * Live run-view registry (Area 2 / #43): every run is registered here and its
   * events published so the external /runs page can stream them. Optional;
   * defaults to the process-wide singleton so the dispatcher and the served
   * /runs endpoints (src/index.ts) share one instance. Injectable for tests.
   */
  runRegistry?: RunRegistry;
  /**
   * Posts a review comment back to a PR (issue #69). Called after a `review`
   * run against a resolved PR, unless the request opted out. Default: the real
   * GitHub REST post with the App installation token (App `pull_requests:write`;
   * no `gh` shell-out — AGENTS.md invariant 5). Injectable so tests assert the
   * decision without a network call.
   */
  postReviewComment?: (target: ReviewCommentTarget, body: string) => Promise<void>;
  /**
   * The PR's head SHA as GitHub reports it right after a review was posted
   * (agent-review.md item 10): when it differs from the reviewed head — a push
   * landed mid-run — the thread gets a head-moved note. Default: one REST GET
   * via repoContext's `currentPrHeadSha`; undefined (or a throw) → no note.
   * Injectable so tests assert the note without a network call.
   */
  fetchPrHead?: (pr: { repo: string; number: number }) => Promise<string | undefined>;
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
   * Cross-session memory store (Area 7c, #85). When `config.memory.enabled`
   * is true the dispatcher retrieves scope-relevant records from this store
   * and injects them as an advisory context block before the model turn, and
   * after the reply a background reflection pass writes distilled records back
   * to it. When memory is disabled (the default) a NullMemoryStore is used
   * regardless, so model input is byte-identical to memory-off and nothing is
   * written. Injectable for tests; the durable WorkerMemoryStore is PR3.
   */
  memory?: MemoryStore;
  /**
   * Skill store backing the load-a-skill capability (#100). When present, the
   * dispatcher appends the calling agent's scoped skill name+description list to
   * its system prompt (progressive disclosure) and passes the store to the tool
   * context so list_skills/use_skill work. Absent (as in most unit tests) →
   * no skill block and the skill tools report themselves unavailable, leaving
   * the request unchanged. Production wires a BundledSkillStore (src/index.ts,
   * src/cli.ts); the DO-backed upload store is PR2, behind this same interface.
   */
  skills?: SkillStore;
  /**
   * Friction ledger (Area 7b, #84): after every run the dispatcher analyzes the
   * run's event stream (`analyzeRunFriction`) and records the diagnosis here,
   * so `friction propose` can cluster friction ACROSS recent runs (the live
   * registry forgets a finished run after its TTL). Absent (most unit tests) →
   * nothing is recorded and the friction commands report the ledger as
   * unavailable. Production wires a FileFrictionLedger (src/index.ts).
   */
  frictionLedger?: FrictionLedger;
  /**
   * The write path onto `runStore` (#157 KTD4): after every run the dispatcher
   * builds the `RunRecord` at finish and hands it here AFTER the reply is sent —
   * fire-and-forget with bounded retries, drain-counted via `pending()`. Absent
   * (most unit tests, or history off) → nothing is written. Production wires
   * `createRunHistoryWriter` over the selected store (src/index.ts, src/cli.ts).
   */
  runHistoryWriter?: RunHistoryWriter;
  /**
   * Where `friction propose` files its proposals. Default: the GitHub REST
   * tracker with the App installation token (App `issues:write`; never a `gh`
   * shell-out — AGENTS.md invariant 5). Injectable so tests assert filing
   * without a network call.
   */
  issueTracker?: IssueTracker;
  /** Floor between two status-card edits (default `STATUS_UPDATE_MIN_MS`).
   *  Tests that assert on an individual intermediate frame set 0. */
  statusUpdateMinMs?: number;
  /**
   * The command registry bound to its deps (#157 U13, `bindCommands`), for the
   * chat fast path: `<group> <verb> [args…] [--option value…]` messages that
   * name a registered, chat-exposed command (and the bare word `help`) are
   * answered inline through `invoke`, never a model turn — since phase 4b this
   * is EVERY command (`help`, `config`, `memory`, `repo`, `friction`, `runs`,
   * `schedule`), there is no legacy chat parser left. Absent (most unit tests,
   * or before the surface is wired) → no message is a command and every text
   * goes to the model. Every real process binds the one core catalogue through
   * `buildCoreCommands` (src/core/commandCatalogue.ts): the bot (src/index.ts)
   * and the CLI harness (src/cli.ts).
   */
  commands?: ChatCommands;
}

/** Registry commands the dispatcher records as inline runs (#244): the ones
 *  that DO work beyond answering from local state — ledger reads and GitHub
 *  writes (`friction.*`), a durable memory mutation (`memory.forget`), a repo
 *  provisioned/torn down/reprovisioned (`repo.onboard|offboard|rebuild|
 *  reconfigure`), a deterministic op executed (`repo.test|build`). Config
 *  replies, `help`, listings, and usage/help replies are not runs. */
export function isInlineRunCommand(id: string): boolean {
  return id.startsWith("friction.") || id === "memory.forget" || /^repo\.(onboard|offboard|rebuild|reconfigure|test|build)$/.test(id);
}

/** Floor between two edits of a run's status card (see `coalesceStatus`). Below
 *  the 5 s heartbeat so a heartbeat frame is never held back by it. */
const STATUS_UPDATE_MIN_MS = 3000;

/** Bounds on the thread context recorded into a run's stream as `context`
 *  events (#157 KTD8): the newest turns win, at most this many, within this
 *  many bytes of redacted text in total. */
const CONTEXT_MAX_ITEMS = 20;
const CONTEXT_MAX_BYTES = 256 * 1024;

/** The web capability (undici Agent with the SSRF-checking connector + the
 *  search adapter) is built ONCE per process, not per run: the Agent owns the
 *  connection pool, so sharing it lets every run reuse warm TLS sockets to the
 *  same hosts instead of paying a fresh DNS+TCP+TLS handshake per fetch — and a
 *  per-run Agent was never closed, so its keep-alive sockets accumulated. */
let sharedWeb: ReturnType<typeof makeWebCapability> | undefined;
const webCapability = () => (sharedWeb ??= makeWebCapability(process.env));

// In-flight run tracking so the process can drain before exiting (restarts
// must not kill runs mid-flight — see index.ts signal handling).
let activeRuns = 0;
export function activeRunCount(): number {
  return activeRuns;
}

export async function dispatch(deps: CoreDeps, msg: IncomingMessage, io: ChannelIO): Promise<void> {
  // Counted in flight from the first line — before history, repo resolution,
  // the setup card and the executor attach — until the post-run steps (reply,
  // review post, memory reflection scheduling) have run; decremented in the
  // outer finally. The shutdown drain (index.ts) polls this count: a SIGTERM
  // that lands between the channel's 👀 ack and the first status card used to
  // see "0 run(s) in flight" and exit at once, abandoning an acked run
  // (#317). Config commands and refusals hold the slot for their few hundred
  // milliseconds too — cheaper than a second gap.
  activeRuns++;
  // The run record (#157 KTD4): its inputs — the registry snapshot and the
  // diagnosis — are captured synchronously when the run finishes, inside the
  // run's try/catch, so a failed run has them too. The record itself is
  // assembled and byte-budgeted (`fitRecordToBudget`) here, only AFTER the
  // reply went out (success path: after `sendAnswer`; failure path: after the
  // error reply in the outer catch), so neither persistence nor the budgeting
  // pass can delay the user. Undefined until a run finished, or when no writer
  // is configured.
  // `failedAfterFinish` is set by the outer catch: a run whose loop completed
  // but whose post-run steps (card close, reply) threw is a FAILED run, not a
  // completed one — a stop that already ended it keeps its `stopped_*` status.
  let buildHistoryRecord: ((failedAfterFinish: boolean) => RunRecord) | undefined;
  const writeHistory = (failedAfterFinish = false) => {
    if (!buildHistoryRecord || !deps.runHistoryWriter) return;
    const build = buildHistoryRecord;
    buildHistoryRecord = undefined; // exactly one write per run
    deps.runHistoryWriter.write(build(failedAfterFinish));
  };
  // The ack card while setup is still in progress. Cleared the moment it
  // becomes the run card, so the outer catch closes ONLY a card that setup
  // left open — a run failure is closed (with its checklist) by the run loop.
  let setupCard: StatusHandle | undefined;
  try {
    // Stage A — the ONE text-only fast path (#157 U13/KTD19, phase 4b): a
    // message that names a registered, chat-exposed command (`<group> <verb>
    // [args…] [--kebab-flag value…]`, or the bare word `help`) is answered
    // inline through the registry — never a model turn — BEFORE `io.history()`,
    // so a recognized command costs no history fetch and the natural-language
    // recognizer below never sees it (the two can never both claim one
    // message). ONE grammar (KTD21) for every command: config, memory, repo,
    // friction, runs, schedule, help. Prose falls through unchanged.
    //
    // Commands that DO real work — ledger reads and GitHub writes (`friction.*`),
    // a durable memory mutation, a repo provisioned or torn down, a
    // deterministic op executed — are runs (#244): a registry record with the
    // request and the reply, on /runs like any other, and a receipt to the
    // channel. The weekly cron reaches this path through /ingress as
    // `http:cron`, so a scheduled firing is a run too. The outcome comes from
    // the command's `ok`, never from the reply text. Config replies, `help`,
    // listings, and usage/help replies are answered directly, no run.
    if (deps.commands) {
      const chatCmd = parseChatCommand(msg.text, deps.commands);
      if (chatCmd) {
        await io.reply((await runChatCommand(deps, msg, io, chatCmd)).text);
        return;
      }
    }

    const directives = parseDirectives(msg.text);
    const history = await io.history();

    // Natural-language deterministic ops (U6, KTD8): the few conservative forms
    // `recognizeOperation` admits ("run the tests on main in acme/api") are
    // TRANSLATED into the registry's `repo.test` / `repo.build` — the very
    // command `repo test acme/api main` is — so one handler executes, one gate
    // sequence applies (the `agentRun` chat gate = canRunAgent(coding), the
    // implicit target agent; canUseRepo inside), and zero model turns are
    // spent. Natural language is an accelerator, not a promise: when the op
    // cannot serve (`not_found` — the repo has no resident; `unavailable` — no
    // backend or a backend failure) the agent still gets the ask, while a
    // refusal or a result is the reply. An explicit agent:/model: directive
    // disables recognition — the user picked a model path.
    const opAsk = deps.commands ? recognizeOperation(msg.text, history, { allowNatural: !directives.agent && !directives.model }) : null;
    if (opAsk) {
      const translated: ParsedChatCommand = { kind: "invoke", id: `repo.${opAsk.op}`, input: { args: [opAsk.repo, opAsk.ref], options: {} } };
      const res = await runChatCommand(deps, msg, io, translated);
      if (!(res.error === "not_found" || res.error === "unavailable")) {
        await io.reply(res.text);
        return;
      }
    }

    // Thread stickiness: a follow-up without explicit directives runs on the
    // agent/model this thread already established (last directive in the
    // thread's history), not the channel/global default — otherwise "continue"
    // in an agent:coding thread silently lands on the toolless default agent.
    // Derived from history on every message, never stored: restart-safe, and
    // consistent with how the Slack adapter re-derives thread participation.
    const sticky = lastThreadDirectives(history);
    const resolved = deps.config.resolve({
      channelId: msg.channelId,
      userId: msg.userId,
      request: {
        agent: directives.agent ?? sticky.agent,
        model: directives.model ?? sticky.model,
        effort: directives.effort ?? sticky.effort,
      },
    });

    // Authorization gate: checked against the *resolved* agent and invoking
    // user, so no config layer (directives, user or channel scope) bypasses it.
    if (!deps.config.canRunAgent(msg.userId, resolved.agentName)) {
      await io.reply(
        `🚫 You're not on the allowlist for the \`${resolved.agentName}\` agent. Ask ${deps.config.adminsHint()} for access.`,
      );
      return;
    }

    const agent = getAgent(resolved.agentName);
    const { provider: providerName, model } = parseModelRef(resolved.modelRef);
    const provider = deps.providers.get(providerName);

    // Target repo/ref for resident environments, resolved BEFORE the model
    // turn (U7): explicit signals in the message, else the repo this thread
    // already established (from history — restart-safe, never stored). The
    // gate belongs with the resource declaration: an agent that declares no
    // repo (e.g. the toolless general default) never resolves or gates one, so
    // a toolless follow-up in a repo-mentioning thread is not wrongly refused
    // and a PR-URL never triggers a wasted GitHub REST call for it.
    // The production resolver vets bare `owner/name` tokens against the
    // resident registry (an onboarded-resource probe from the resident
    // config) so prose shaped like a slug can never bind a repo; an injected
    // resolver (tests) is called as before. STARTED here (a promise) so the
    // GitHub round trip overlaps the memory read below; awaited after the ack.
    const needsRepo = agent.resources?.repo === "required";
    const repoCtxP: Promise<RepoContext> = needsRepo
      ? Promise.resolve(
          deps.resolveRepoContext
            ? deps.resolveRepoContext(msg, history)
            : resolveRepoContext(msg, history, residentOnboardedProbe(deps.config.config.execution?.resident)),
        ).then((ctx) => ctx ?? {})
      : Promise.resolve({});
    repoCtxP.catch(() => {});

    // Cross-session memory (Area 7c, #85) — READ path, STARTED here and awaited
    // below, so the memory Worker round trip (up to 5 s) overlaps the repo/PR
    // resolution and the executor attach instead of adding to them. Its scopes
    // are the org, this channel, this user, and — once resolution settles —
    // the bound repo (#253); the read never depends on the repo GATE, only on
    // the repo NAME, and a failed resolution simply means no repo scope.
    // Started after the agent gate, never before: a refused request must not
    // touch memory (retrieval bumps usage counters). Flag-gated: with memory
    // disabled (default) this resolves to undefined via a NullMemoryStore,
    // leaving `messages` and `system` byte-identical to memory-off. The no-op
    // catch keeps an early return (repo refusal, ask-once) from leaving the
    // rejection unhandled; the real await below still surfaces a failure where
    // it did.
    const memoryBlockP = memoryContextBlock(deps.config.config.memory, deps.memory, directives.text, msg.userId, {
      channelId: msg.channelId,
      repo: repoCtxP.then((ctx) => ctx.repo),
    });
    memoryBlockP.catch(() => {});

    // Acknowledge NOW, before anything slow. Everything between here and the
    // model turn can take minutes — repo/PR resolution (GitHub REST), memory
    // retrieval, and above all executor selection (resident attach or a cold
    // sandbox clone+install) — and until this card existed the thread saw
    // nothing for that whole stretch. The same handle becomes the run's status
    // card below; a refusal or setup failure closes it with a reason instead of
    // leaving a spinner behind.
    let label = `*${agent.name}* on \`${resolved.modelRef}\``;
    const startedAt = Date.now();
    let frame = 0;
    const title = (icon?: string) =>
      `${icon ?? SPINNER_GLYPHS[frame++ % SPINNER_GLYPHS.length]} ${label} · ${Math.round((Date.now() - startedAt) / 1000)}s`;
    // Coalesced: the run below refreshes it on every event, the channel sees at
    // most one edit per STATUS_UPDATE_MIN_MS, always the newest frame.
    const card = coalesceStatus(
      await io.status({ title: `👀 ${label} · preparing workspace…` }),
      deps.statusUpdateMinMs ?? STATUS_UPDATE_MIN_MS,
    );
    setupCard = card;

    // The repo/ref resolution started above (before the ack) lands here; the
    // gate below runs against it exactly as before.
    // `let`: the attach-head check below may adopt the PR's current head when
    // the branch moved between resolution and attach (item 12).
    let repoCtx: RepoContext = await repoCtxP;

    // Not-onboarded gate (#316): the thread has no repo, and the only reason
    // is that its bare `owner/name` slug was refused by the resident registry
    // (item 29's probe). A repo-needing agent would otherwise start with an
    // EMPTY workspace and report `fatal: not a git repository` (live
    // 2026-08-30, `coreplanelabs/try-catch`) — say why instead, before any
    // attach or model turn. A thread that already has a repo never reaches
    // here with `rejectedRepo` (prose slugs there are never probed — #289), so
    // the silence that fix bought is untouched.
    if (needsRepo && !repoCtx.repo && repoCtx.rejectedRepo) {
      const slug = repoCtx.rejectedRepo;
      console.log(`[dispatch] ${msg.threadKey} not started: repo not onboarded (${slug})`);
      await card.done({ title: `📦 ${label} · not started (repo not onboarded)` });
      // `repo onboard` is admin-gated (canManageRepos, fail-closed): only tell
      // someone to run it if they can; everyone else is pointed at who can.
      const onboardHint = deps.config.canManageRepos(msg.userId)
        ? `Onboard it (\`repo onboard ${slug}\`)`
        : `Ask ${deps.config.adminsHint()} to onboard it (\`repo onboard ${slug}\`)`;
      await io.reply(
        `📦 \`${slug}\` is not onboarded as a resident, so I did not start a *${agent.name}* run for it. ` +
          `${onboardHint} for a warm, deps-ready environment, or name the repository by URL ` +
          `(https://github.com/${slug}) to run in a cold per-thread sandbox.`,
      );
      return;
    }

    // Per-repo access gate (KD7): open when permissions.repos is absent or
    // the repo is unlisted; a configured allowlist refuses BY NAME — a
    // refused user must see why, never get a silent per-thread fallback.
    if (needsRepo && repoCtx.repo && !deps.config.canUseRepo(msg.userId, repoCtx.repo)) {
      await card.done({ title: `🚫 ${label} · not started (repo access)` });
      await io.reply(
        `🚫 You're not on the allowlist for the \`${repoCtx.repo}\` repo environment. Ask ${deps.config.adminsHint()} for access.`,
      );
      return;
    }

    const messages = buildMessages(history, directives.text, msg.images, msg.documents);

    // Executor selection is context-aware: the agent's resource declarations
    // decide whether anything is provisioned at all (general gets nothing),
    // and repo/ref carry resident-repo inference. A resident fallback comes
    // back with a named note (KTD10) that rides on every status frame below.
    // Unknown-head check (features/agent-review.md item 11): a review whose PR
    // head could not be resolved — the message named a PR but the GitHub fetch
    // failed, or the thread's inherited PR was unreachable — is a guaranteed
    // refusal downstream: the resident cannot be told which commit to attach,
    // the model finds a stale worktree, and the reviewed-head guard (item 8)
    // refuses the post. Live 2026-08-30 (PR #300): 75 s and a model turn spent
    // to produce a `request_changes` "cannot review" verdict that was then
    // Slack-only. Not started instead — before any attach, one named reply.
    // An explicit "slack only" opt-out wants no post anyway, so an unpinned
    // review is exactly what was asked for — no refusal (`reviewPostIntended`
    // is the same predicate the post-step decides by).
    if (repoCtx.repo && reviewPostIntended({ agentName: resolved.agentName, requestText: directives.text })) {
      const unknownHead =
        repoCtx.pr !== undefined && !repoCtx.headSha
          ? repoCtx.pr
          : repoCtx.prUnpostable?.reason === "unreachable"
            ? repoCtx.prUnpostable.number
            : undefined;
      if (unknownHead !== undefined) {
        const where = `${repoCtx.repo}#${unknownHead}`;
        console.log(`[review] ${msg.threadKey} not started: PR head unknown (${where})`);
        await card.done({ title: `🔀 ${label} · not started (PR head unknown)` });
        await io.reply(
          `🔀 Review of ${where} not started: GitHub did not give me a usable head commit for the PR (the lookup failed, or answered without a well-formed SHA), ` +
            `so I cannot pin a review to it. Re-send the request in a moment; if it keeps failing, look at the PR on GitHub and at the bot's GitHub App credentials.`,
        );
        return;
      }
    }

    let selection: Awaited<ReturnType<typeof makeExecutor>>;
    try {
      selection = await makeExecutor(
        {
          execution: deps.config.config.execution,
          workspaceDir: deps.config.config.workspaceDir ?? "./workspaces",
          dataDir: deps.dataDir ?? "./data",
        },
        { threadKey: msg.threadKey, agent, repo: repoCtx.repo, ref: repoCtx.ref, headSha: repoCtx.headSha },
      );
    } catch (err) {
      // Ask-once (KTD6): the resident has no ref binding for this thread, the
      // message named no branch, AND the resident did not name a default to
      // bind to (the factory binds to `defaultRef` itself when the 409 carries
      // one — only a Worker predating that field reaches here). Binding is
      // explicit-or-ask-once, never a silent guess. ONE clarifying question,
      // no model turn burned (mirrors the named-refusal reply shape). The
      // user's answer in the thread (e.g. "on main") carries the ref on the
      // next message and re-attach binds it.
      if (err instanceof ResidentNeedsRefError) {
        await card.done({ title: `🌿 ${label} · not started (which branch?)` });
        await io.reply(
          `🌿 Which branch of \`${repoCtx.repo}\` should this thread work on? ` +
            `No branch is bound yet — reply naming one (e.g. "on main" or "on branch fix/login") and I'll pick it up from there.`,
        );
        return;
      }
      throw err;
    }
    const { executor, note, resident, binding } = selection;

    // Attach-head check (features/agent-review.md item 10, #282): for a PR
    // review on the resident path, the sha the resident ATTACHED the worktree
    // at is compared with the PR head resolved above — before any model turn.
    // A well-formed, different sha means the branch moved between resolution
    // and attach (a push or force-push racing the request): the reviewed-head
    // guard (item 8) would refuse the post anyway — UNLESS the attached sha is
    // the PR's head NOW (item 12: the resident's attach fetched the mirror to
    // the ref's tip, which is exactly where a push that raced the request
    // landed). One GET decides: attached = current → the run reviews the
    // current head (RepoContext adopts it, the block says it was verified);
    // otherwise not started — one named reply, the pool user released, no
    // provider call. Equal shas are told to the model as a verified fact, so it
    // has no reason to go and look. A malformed/absent attach sha proves
    // nothing either way: the run proceeds unverified, exactly as before.
    let verifiedAtAttach = false;
    if (resolved.agentName === "review" && resident && repoCtx.pr !== undefined && repoCtx.repo) {
      const expected = normalizeHead(repoCtx.headSha);
      const attached = normalizeHead(binding?.sha);
      if (expected && attached && sameCommit(expected, attached)) {
        verifiedAtAttach = true;
      } else if (expected && attached) {
        const where = `${repoCtx.repo}#${repoCtx.pr}`;
        const fetchHead = deps.fetchPrHead ?? currentPrHeadSha;
        const current = normalizeHead(await fetchHead({ repo: repoCtx.repo, number: repoCtx.pr }).catch(() => undefined));
        if (current && sameCommit(attached, current)) {
          console.log(
            `[review] ${msg.threadKey} PR head moved since resolution: ${expected.slice(0, 7)} → ${current.slice(0, 7)}; the worktree is attached at the current head — reviewing it (${where})`,
          );
          repoCtx = { ...repoCtx, headSha: current };
          verifiedAtAttach = true;
        } else {
          console.log(`[review] ${msg.threadKey} not started: worktree attached at ${attached.slice(0, 7)}, PR head ${expected.slice(0, 7)} (${where})`);
          if (executor.release) await executor.release("always").catch(() => {});
          await card.done({ title: `🔀 ${label} · not started (branch moved)` });
          await io.reply(
            `🔀 Review of ${where} not started: the resident attached \`${binding?.ref ?? repoCtx.ref ?? "the branch"}\` at \`${attached.slice(0, 7)}\`, ` +
              `but the PR head is \`${expected.slice(0, 7)}\` — the branch moved while the worktree was being attached (a push or force-push). Re-send the request to review the new head.`,
          );
          return;
        }
      }
    }

    // Effective system prompt, composed AFTER executor resolution (via
    // RunOptions.system, U1): a resident-path run swaps in the agent's
    // resident variant — the workspace is a ready worktree, no cloning, no
    // installs — with the resolved repo named, and the worktree path when the
    // attach answered it (#282: a model that knows where it is has no reason
    // to `cd` off looking for the repository). Every other path keeps the
    // agent's own prompt. Selection reports the resident backend via a
    // discriminant (not an executor `instanceof`), keeping the executor
    // implementation out of the channel-agnostic core. The shared AgentDef is
    // never mutated (concurrent dispatches share it).
    const residentSystem =
      resident && agent.residentSystem
        ? `${agent.residentSystem}\n\nTarget repository: ${repoCtx.repo}. ` +
          (binding?.workspace
            ? `Your shell starts in the worktree \`${binding.workspace}\` on every bash call; it is already on this thread's bound branch (confirm with \`git branch --show-current\` from there — no \`cd\`).`
            : "The worktree is already on this thread's bound branch (confirm with `git branch --show-current`).")
        : undefined;
    // REVIEW TARGET (features/agent-review.md item 9): a review run whose repo
    // resolution found a PR is TOLD what it is reviewing — repo, PR, head
    // branch/commit, base — from the same RepoContext the post-step guard
    // (item 8) later checks against. Both paths; the block is path-aware
    // (ready worktree vs. clone + `gh pr checkout`). Nothing to tell for a
    // coding run or a PR-less review, so those prompts stay byte-identical.
    // The head is a parameter: a re-review at a moved head (item 12) recomposes
    // the prompt with the new commit instead of contradicting the old one.
    const isPrReview = resolved.agentName === "review" && repoCtx.repo !== undefined && repoCtx.pr !== undefined;
    const targetBlock = (head: { sha: string | undefined; verified: boolean }): string | undefined =>
      isPrReview && repoCtx.repo && repoCtx.pr !== undefined
        ? reviewTargetBlock({
            repo: repoCtx.repo,
            pr: repoCtx.pr,
            ref: repoCtx.ref,
            headSha: head.sha,
            baseRef: repoCtx.baseRef,
            resident: resident === true,
            ...(binding?.workspace ? { workspace: binding.workspace } : {}),
            ...(head.verified ? { verifiedAtAttach: true } : {}),
          })
        : undefined;

    // Progressive disclosure (#100): append the calling agent's scoped skill
    // name+description list AFTER the agent's own instructions (it is guidance
    // about the agent's tools, not advisory context like the memory block).
    // Bodies load on demand via use_skill — never dumped here. No store, or an
    // agent with no scoped skills (general/research), leaves the prompt
    // untouched: `skillsBlock` is undefined and `withSkills` stays `baseSystem`,
    // preserving the byte-identical path (and the runner's `agent.system`
    // fallback when `system` is undefined).
    const skillsBlock = deps.skills ? skillGuidanceBlock(deps.skills, agent.name) : undefined;
    const agentSystem = (head: { sha: string | undefined; verified: boolean }): string | undefined => {
      const target = targetBlock(head);
      const baseSystem = target ? `${residentSystem ?? agent.system}\n\n${target}` : residentSystem;
      return skillsBlock ? `${baseSystem ?? agent.system}\n\n${skillsBlock}` : baseSystem;
    };

    // Config awareness (routing-and-config behavior 8): tell the model the
    // RESOLVED agent/model/scope of this very run and how users tune it, so no
    // agent can confabulate "I'm stateless / nothing is tunable". Built from
    // the same `resolved`/`directives`/`sticky` values that selected the run,
    // so it can never describe a different state than the one executing.
    // Universal (every agent, every turn), a few lines, names only.
    const scopes = deps.config.scopes(msg.channelId, msg.userId);
    const configBlock = configAwarenessBlock({
      agentName: agent.name,
      modelRef: resolved.modelRef,
      effort: resolved.effort,
      channel: scopes.channel,
      user: scopes.user,
      messageDirective: { agent: directives.agent, model: directives.model, effort: directives.effort },
      threadDirective: { agent: sticky.agent, model: sticky.model, effort: sticky.effort },
      canEditChannelConfig: deps.config.canEditChannelConfig(msg.userId),
    });

    // Custom instructions (#107 phase 2): the requester's user text + this
    // channel's text, as ONE advisory block. Read from the same resolved
    // scopes as the config block, AFTER resolution and every gate above — so
    // by construction they cannot influence agent, model, or permissions.
    // Absent (the default) → no block, prompt unchanged.
    const instructionsBlock = customInstructionsBlock(scopes);

    // Effective system prompt order: memory (advisory context, leads when
    // present) → config block → custom instructions → the agent's own
    // instructions (+ skills). The memory block is absent with memory off
    // (default), keeping the memory-off request byte-identical to a
    // NullMemoryStore run. Retrieval was started before the repo resolution and
    // executor selection above; by now it has usually landed.
    const memoryBlock = await memoryBlockP;
    const composeSystem = (head: { sha: string | undefined; verified: boolean }): string =>
      [memoryBlock, configBlock, instructionsBlock, agentSystem(head) ?? agent.system]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");
    // The PR head this run reviews — the resolved head, or the one adopted at
    // attach; a re-review at a moved head (item 12) advances it. The post-step
    // pins to it and the reviewed-head guard checks against it.
    let reviewHead = repoCtx.headSha;
    let system = composeSystem({ sha: reviewHead, verified: verifiedAtAttach });

    if (note) label = `${label} · ${note}`;
    console.log(`[run] ${msg.threadKey} user=${msg.userId} agent=${agent.name} model=${resolved.modelRef}`);
    setupCard = undefined; // from here the run loop owns the card's close
    card.update({ title: title() }); // the ack card becomes the run card
    let lastActivityAt = Date.now();
    // Live run view (Area 2 / #43): register the run and mint its capability
    // link AFTER the card exists (so nothing awaits between create() and the
    // run loop's finally that finish()es it). With no PUBLIC_BASE_URL the link
    // is simply omitted — the feature degrades gracefully, the run is otherwise
    // unchanged. Events are fed to the registry in onEvent below.
    const registry = deps.runRegistry ?? defaultRunRegistry;
    // A human-first label for the Access-gated runs index (`GET /runs`): agent +
    // repo (repo runs) or channel/user (chat runs) + a snippet of the request,
    // so a row reads like `review · #switchboard-prompting · justin · "…"` rather
    // than raw ids. Built from the directive-stripped text so directives (agent:/
    // model:) never clutter the snippet.
    const runLabel = composeRunLabel({
      agent: agent.name,
      repo: repoCtx.repo,
      channelId: msg.channelId,
      userId: msg.userId,
      channelName: msg.channelName,
      userName: msg.userName,
      text: directives.text,
    });
    // The registry redacts and caps the label; `run.label` is the one the record
    // and the friction row carry (never `runLabel`, which may hold a pasted secret).
    const run = registry.create(runLabel, {
      agent: agent.name,
      model: resolved.modelRef,
      channelId: msg.channelId,
      userId: msg.userId,
      threadKey: msg.threadKey,
      ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
      ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
    });
    // The narrative events the dispatcher itself publishes — the request, the
    // thread context, the final answer — go straight to the registry: redacted
    // like every event, uncapped (the run record is the source of truth; the
    // registry's byte-bounded backlog and the record's per-event budget bound
    // persistence), never through onEvent (no card refresh, no friction input),
    // and logged as ONE line of type + byte-length — never the text, which may
    // span lines or carry what redaction missed.
    const publishText = (type: "input" | "context" | "answer", text: string, source?: { url?: string; channel?: string; user?: string }) => {
      const redacted = redactSecrets(text);
      registry.publish(run.id, { type, text: redacted, ...(source ? { source } : {}), at: Date.now() });
      console.log(`[event] ${msg.threadKey} type=${type} bytes=${utf8ByteLength(redacted)}`);
    };
    // The request is the first event of the run record (live-view item 12): the
    // directive-stripped text, humanized (Slack `<url|label>`/mention markup
    // unwrapped, entities unescaped — it is channel-authored mrkdwn, not prose)
    // + an attachment count.
    // Slack-authored text is humanized (`<url>`/mention markup unwrapped,
    // entities unescaped — it is mrkdwn, not prose); every other channel's text
    // is recorded exactly as it was dispatched to the model, so the record never
    // diverges from the input.
    const humanize = isMrkdwnChannel(msg.channelId);
    const attachments = attachmentSuffix(msg.images, msg.documents);
    const source = {
      ...(msg.sourceUrl ? { url: msg.sourceUrl } : {}),
      ...(msg.channelName ? { channel: msg.channelName } : {}),
      ...(msg.userName ? { user: msg.userName } : {}),
    };
    const request = humanize ? humanizeMessageText(directives.text) : directives.text;
    publishText("input", attachments ? `${request} ${attachments}` : request, Object.keys(source).length > 0 ? source : undefined);
    // What the run is about (live-view item 19): agent, model, and the repo
    // context resolved above — so the page can head the record with linked
    // owner/repo · ref · #PR · sha. Once per run, straight after the request.
    registry.publish(run.id, {
      type: "run_meta",
      agent: agent.name,
      model: resolved.modelRef,
      ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
      ...(repoCtx.ref !== undefined ? { ref: repoCtx.ref } : {}),
      ...(repoCtx.pr !== undefined ? { pr: repoCtx.pr } : {}),
      ...(repoCtx.headSha !== undefined ? { headSha: repoCtx.headSha } : {}),
      at: Date.now(),
    });
    const liveUrl = liveViewLink(run.id, run.token);
    const liveLink = liveUrl ? { url: liveUrl, label: "Live run" } : undefined;
    // The thread context fed to the model follows the request as `context`
    // events (#157, KD1) — text only, attachments as metadata lines, bounded to
    // the newest CONTEXT_MAX_ITEMS turns within CONTEXT_MAX_BYTES.
    if (deps.config.config.runHistory?.includeContext !== false) {
      for (const text of contextMessageTexts(history, humanize)) publishText("context", text);
    }
    // The card body is the agent's own checklist (via the update_status tool)
    // plus a live one-line activity trace (current tool call + redacted result
    // summary) so the card reflects progress per tool event, not only on the
    // 5s heartbeat. Full command output still goes to stdout for operators.
    let checklist: string | undefined;
    let lastActivity: string | undefined;
    const currentFrame = () => {
      const quiet = Date.now() - lastActivityAt;
      const thinking = quiet > 20_000 ? ` — thinking (${Math.round(quiet / 1000)}s since last tool)` : "";
      const detail = [checklist, lastActivity].filter(Boolean).join("\n");
      // The shutdown notice rides on the LIVE frame only: the closed card is
      // built from title()/finalDetail() and never mentions the restart.
      return { title: title() + thinking + (shutdownNotice ? ` · ${shutdownNotice}` : ""), detail: detail || undefined, link: liveLink };
    };
    // The closed card keeps the run link (the run page outlives the run and
    // shows the final answer) and the agent's checklist; only the transient
    // activity trace is dropped.
    const finalDetail = () => checklist;
    const onProgress = (note: string) => {
      console.log(`[note] ${msg.threadKey} ${note}`);
      lastActivityAt = Date.now();
    };
    // Live run-visibility (Area 2): each tool call/result refreshes the card
    // immediately, so activity is visible without waiting for the heartbeat.
    let toolCalls = 0; // "did real work" signal for the memory reflection gate
    // The registry backlog is the run's ONE event store (#157 KTD9): the live
    // page, the post-run friction diagnosis and the run record all read it back
    // via `registry.snapshot` — there is no second copy to drift from it.
    const onEvent = (e: RunEvent) => {
      registry.publish(run.id, e); // feed the external live-view stream
      if (e.type === "tool_call") toolCalls++;
      lastActivityAt = Date.now();
      lastActivity = activityLine(e);
      console.log(`[tool] ${msg.threadKey} ${lastActivity}`);
      card.update(currentFrame());
    };
    const reportProgress = (list: string) => {
      checklist = list.trim() || undefined;
      card.update(currentFrame());
    };
    // Heartbeat: the card ticks every 5s no matter what. A ticking timer means
    // the run is alive; a stopped timer means the process died — the reader
    // can always tell the difference.
    const heartbeat = setInterval(() => card.update(currentFrame()), 5000);

    let answer: string;
    // Review verdict, set only through the structured submit_verdict tool; the
    // post-step below turns it into the deterministic first line of the GitHub
    // body (fail-closed: no call → not approving). See reviewVerdict.ts.
    let verdict: ReviewVerdict | undefined;
    const onVerdict = (v: ReviewVerdict) => {
      verdict = v;
    };
    // The commit actually checked out in the run's workspace when the model
    // finished — read by us, not reported by the model — for the reviewed-head
    // guard below. Undefined when the cwd is not a git repo (cold sandbox root).
    let observedHead: string | undefined;
    // Set when the head moved during the run by a rebase of the same commits
    // (item 12): the post is pinned to `current` with a footer, and the thread
    // is told the review was carried forward.
    let carried: { reviewed: string; current: string; commits: number } | undefined;
    let runFailed = false; // the runner threw → terminal status `failed`
    // Give the workspace back now rather than at the inactivity sweep: a
    // resident's pool user is a scarce slot (features/resident-repos.md item
    // 16a). Read-only agents hold nothing worth keeping; a coding run keeps
    // its worktree only while it has uncommitted/unpushed work — unless an
    // operator HARD-stopped it (#101), which means "tear it down now": the
    // abandoned command may still be running in there, and the whole point
    // of a hard stop is to free the resources. Best-effort — a failed
    // release is a log line, never a failed run. Called AFTER the answer has
    // been sent (or the failure card closed): the `/detach` round trip is
    // bounded at 10 s on a sick resident, and nothing about the reply depends
    // on it, so it must never sit between "answer ready" and the thread.
    const releaseWorkspace = async () => {
      if (!executor.release) return;
      const mode = agent.toolset === "readonly" || run.control.requested === "hard" ? "always" : "if-clean";
      try {
        const r = await executor.release(mode);
        console.log(`[release] ${msg.threadKey} ${r.released ? "released" : "kept"}${r.reason ? ` (${r.reason})` : ""}`);
      } catch (err) {
        console.warn(`[release] ${msg.threadKey} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    try {
      answer = await runAgent({
        provider,
        model,
        agent,
        messages,
        system,
        effort: resolved.effort,
        toolContext: { executor, reportProgress, web: webCapability(), skills: deps.skills, agentName: agent.name, onVerdict },
        onProgress,
        onEvent,
        control: run.control, // operator stop from /runs (#101)
      });
      // Reviewed-head probe (features/agent-review.md item 8): for a PR review,
      // read the workspace HEAD NOW — after the model is done, BEFORE the
      // finally below releases the workspace. Post-release a resident would
      // re-attach a fresh tree at the ref's CURRENT tip, which is not evidence
      // of what was reviewed. Best-effort: a failed probe leaves it undefined
      // and the guard falls back to the verdict's reported head.
      const probeHead = async () => parseRevParseOutput(await executor.exec("git rev-parse HEAD").catch(() => ""));
      if (isPrReview && repoCtx.repo && repoCtx.pr !== undefined && run.control.requested !== "hard") {
        observedHead = await probeHead();
        // Head moved during the run (item 12): the PR head is fetched NOW, before
        // anything is posted, and compared with the head the agent reviewed
        // (observed, else reported — the guard's own authority order).
        //   reviewed = current ≠ resolved → the agent reviewed the PR's current
        //     head (a mid-run re-attach landed on a newer tip): adopt it.
        //   reviewed = resolved ≠ current → the PR moved under the review:
        //     classify the move from GitHub's compare lists. A rebase of the same
        //     commits carries the review to the new head (post pinned there, footer
        //     + note); a substantive move makes THIS run re-review at the new
        //     head — worktree moved, prompt recomposed, one more model turn —
        //     before posting. Unclassifiable → item 10 (pinned to the reviewed
        //     head + re-request note). Once: a head that moves again after the
        //     re-review gets item 10's note, never a third turn.
        //   reviewed ≠ both → the agent strayed (item 8); the guard refuses below.
        const pr = { repo: repoCtx.repo, number: repoCtx.pr };
        const where = `${pr.repo}#${pr.number}`;
        const fetchHead = deps.fetchPrHead ?? currentPrHeadSha;
        const currentHead = async () => normalizeHead(await fetchHead(pr).catch(() => undefined));
        const expected = normalizeHead(reviewHead);
        const reviewed = normalizeHead(observedHead) ?? normalizeHead(verdict?.head);
        if (expected && reviewed) {
          const current = await currentHead();
          if (current && !sameCommit(current, expected) && sameCommit(reviewed, current)) {
            console.log(`[review] ${msg.threadKey} reviewed the PR's current head ${current.slice(0, 7)} (resolved ${expected.slice(0, 7)} was superseded mid-run) (${where})`);
            reviewHead = current;
          } else if (current && !sameCommit(current, expected) && sameCommit(reviewed, expected)) {
            const classified = await classifyMove(deps, { repo: pr.repo, base: repoCtx.baseRef, from: expected, to: current });
            const move = classified?.move;
            if (move?.kind === "rebase") {
              console.log(`[review] ${msg.threadKey} head moved during run: ${expected.slice(0, 7)} → ${current.slice(0, 7)} — rebase of the same ${move.commits} commit(s); review carried to ${current.slice(0, 7)} (${where})`);
              carried = { reviewed: expected, current, commits: move.commits };
            } else if (classified && move?.kind === "substantive") {
              const summary = `head moved ${expected.slice(0, 7)} → ${current.slice(0, 7)} — re-reviewing at ${current.slice(0, 7)}`;
              console.log(`[review] ${msg.threadKey} ${summary} (${where})`);
              onEvent({ type: "run_note", kind: "head_moved", summary, at: Date.now() });
              label = `${label} · head moved → ${current.slice(0, 7)}`;
              card.update(currentFrame());
              await io.reply(headRereviewNote({ where, reviewed: expected, current, move })).catch(() => {});
              // Resident: move the worktree ourselves (one re-attach at the new
              // head). Anything else — no moveTo, a refusal, a tip that moved
              // again under the re-attach — leaves the model to check it out.
              let worktreeMoved = false;
              if (executor.moveTo) {
                try {
                  const at = normalizeHead((await executor.moveTo(current)).sha);
                  worktreeMoved = at !== undefined && sameCommit(at, current);
                  console.log(`[review] ${msg.threadKey} worktree moved to ${at?.slice(0, 7) ?? "?"}${worktreeMoved ? "" : " (not the expected head)"}`);
                } catch (err) {
                  console.warn(`[review] ${msg.threadKey} worktree move failed: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
              verdict = undefined; // the earlier verdict is void; the re-review must submit its own
              reviewHead = current;
              system = composeSystem({ sha: current, verified: worktreeMoved });
              messages.push(
                { role: "assistant", content: [{ type: "text", text: answer }] },
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: rereviewFollowUp({ where, reviewed: expected, current, move, before: classified.before, after: classified.after, worktreeMoved }),
                    },
                  ],
                },
              );
              answer = await runAgent({
                provider,
                model,
                agent,
                messages,
                system,
                effort: resolved.effort,
                toolContext: { executor, reportProgress, web: webCapability(), skills: deps.skills, agentName: agent.name, onVerdict },
                onProgress,
                onEvent,
                control: run.control,
              });
              // Re-read, not narrowed: the stop may have been requested during the turn.
              if (!run.control.hardSignal.aborted) observedHead = await probeHead();
            }
          }
        }
      }
      // The run record is the source of truth and Slack/GitHub are projections
      // of it: publish the final answer into the stream FIRST (redacted like
      // every event, uncapped — a soft stop's "findings so far" included; a
      // re-review's answer supersedes the first one, which is not the run's
      // answer). It MUST precede the finally below: `finish()` runs there, and a
      // publish on a finished run is a silent no-op. Only after that is the
      // reply sent.
      publishText("answer", answer);
    } catch (err) {
      runFailed = true;
      await card.done({ title: title("❌"), detail: finalDetail(), link: liveLink });
      await releaseWorkspace();
      throw err;
    } finally {
      clearInterval(heartbeat);
      const stopped = run.control.requested;
      const status: RunStatus = runFailed ? "failed" : stopped === "hard" ? "stopped_hard" : stopped === "soft" ? "stopped_soft" : "completed";
      // Close the live-view stream and start the TTL, handing the registry the
      // terminal status so every summary projects it (the index, `runs list`)
      // instead of re-deriving it. The one status the registry cannot know is
      // `failedAfterFinish` (a reply that throws AFTER the loop): the record
      // says `failed`, the registry row keeps `completed` for its TTL.
      registry.finish(run.id, status);
      // The registry backlog is read back ONCE here, synchronously at finish
      // (#157 KTD4/KTD9): it feeds both the friction diagnosis and the run
      // record. Reading it now, not after the reply, is what makes a slow reply
      // safe — the registry evicts a finished run after its TTL, and the record
      // must not depend on winning that race. Skipped entirely when neither
      // consumer is wired (nothing to diagnose for, nothing to persist). The
      // backlog is byte-bounded (oldest evicted), so the diagnosis is told when
      // it is looking at a head-truncated stream.
      const snap = deps.frictionLedger || deps.runHistoryWriter ? registry.snapshot(run.id, run.token) : null;
      const events = snap?.events ?? [];
      const diagnosis = analyzeRunFriction(events, { finished: true, truncated: snap?.truncated ?? false });
      const finishedAt = snap?.finishedAt ?? Date.now(); // the registry's finish clock: row and record agree
      // The channel's receipt (id + terminal status, never the token): a
      // single-shot channel hands it to its caller — the Worker shim records a
      // scheduled firing's run from it (#244).
      io.runFinished?.({ id: run.id, status });
      if (deps.runHistoryWriter) {
        // Everything the record needs is captured now; assembly + budgeting
        // run in `writeHistory()`, after the reply.
        buildHistoryRecord = (failedAfterFinish) =>
          assembleRunRecord({
            run,
            snap,
            agent: agent.name,
            model: resolved.modelRef,
            msg,
            repo: repoCtx.repo,
            finishedAt,
            status: failedAfterFinish && status === "completed" ? "failed" : status,
            diagnosis,
          });
      }
      // Friction ledger (#84): keep this run's diagnosis for the cross-run
      // proposer. Best-effort and fire-and-forget — a ledger failure is a
      // warning line, never a failed run or a delayed reply. With run history
      // on, the ledger is READ from the run store and `record()` only forwards
      // to the legacy FrictionDO until its decommission (KD3 call-out) — so this
      // write stays regardless of what the history writer does.
      if (deps.frictionLedger) {
        const ledger = deps.frictionLedger;
        void ledger
          .record({ runId: run.id, ...(run.label !== undefined ? { label: run.label } : {}), agent: agent.name, finishedAt, diagnosis })
          .catch((err: unknown) =>
            console.warn(`[friction] ${msg.threadKey} ledger write failed: ${err instanceof Error ? err.message : String(err)}`),
          );
      }
    }

    // The card's final icon tells the stop apart from a normal finish: ⏹ soft
    // (a summary was written), ⛔ hard (aborted, no summary).
    const stopped = run.control.requested;
    console.log(`[done] ${msg.threadKey} ${answer.length} chars${stopped ? ` (stopped: ${stopped})` : ""}`);
    // `finally`, not sequential: a Slack failure in either call (outage, an
    // unchunkable line) must still give the pool user back, or it is held
    // until the hourly sweep — the toil 16a exists to avoid.
    try {
      await card.done({ title: title(stopped === "hard" ? "⛔" : stopped === "soft" ? "⏹" : "✅"), detail: finalDetail(), link: liveLink });
      await sendAnswer(deps, io, msg.threadKey, { provider, model, maxTokens: agent.maxTokens }, answer);
    } finally {
      await releaseWorkspace();
    }
    // Run history (#157 KTD4): the record built at finish goes to the store now
    // that the reply has landed (a reply that threw lands in the outer catch and
    // is written as `failed` there). Fire-and-forget; the writer's `pending()`
    // is incremented here, BEFORE the outer finally's `activeRuns--`, so the
    // shutdown drain never observes "0 runs, 0 writes" between the two.
    writeHistory();

    // Cross-session memory (Area 7c, #85) — WRITE path. AFTER the reply has
    // landed, distill this run into memory records: fire-and-forget (tracked
    // only for the shutdown drain), so its latency/failures never reach the
    // user; gated on memory.enabled (default off → nothing happens) and on the
    // run having done real work (tools used, or a long thread) and not being a
    // `review` run (#292: findings live on the PR; distilling them floods org
    // memory with per-PR ephemera). Fast paths above returned before this
    // point and never reflect. A HARD-stopped run has no summary to distill
    // (its answer is the abort line), so it is skipped too; a soft stop wrote
    // a real finale and reflects normally.
    if (stopped !== "hard") scheduleReflection({
      cfg: deps.config.config.memory,
      store: deps.memory,
      providers: deps.providers,
      runModelRef: resolved.modelRef,
      gate: { toolCalls, historyTurns: history.length, agentName: resolved.agentName },
      threadKey: msg.threadKey,
      runId: run.id,
      userId: msg.userId,
      channelId: msg.channelId,
      repo: repoCtx.repo,
      history,
      request: directives.text,
      answer,
    });

    // Deterministic review post-step (issue #69): a `review` run against a
    // resolved PR posts its findings back to that PR by default — no need to
    // ask. Only for PR reviews (a resolved PR number); a review of pasted code
    // or a repo with no PR posts nowhere. Best-effort: a post failure is logged
    // but never fails the dispatch (the review already landed in Slack). A
    // HARD-stopped review has no findings — only the abort line — so nothing is
    // posted to the PR; a soft stop's "findings so far" finale posts as usual.
    let postTarget: ReviewPostTarget | null = null;
    if (stopped !== "hard") {
      postTarget = decideReviewPost({
        agentName: resolved.agentName,
        repo: repoCtx.repo,
        pr: repoCtx.pr,
        requestText: directives.text,
      });
      if (!postTarget && resolved.agentName === "review") {
        // Never a silent skip: a review that lands only in Slack says why, so a
        // re-review that failed to resolve its PR is visible in the logs — and,
        // when the thread HAD a bound PR that turned out closed, in the thread
        // itself: a Slack-only verdict must never be mistaken for a posted one.
        // (An UNREACHABLE bound PR never gets this far — the unknown-head check
        // above refuses the run before any model turn.) An explicit opt-out is
        // the one case where the user already knows: log it, no note.
        const optedOut = reviewPostOptedOut(directives.text);
        const unpostable = optedOut ? undefined : repoCtx.prUnpostable;
        const why = optedOut
          ? "opted out"
          : unpostable
            ? `bound PR ${unpostable.reason}`
            : "no PR resolved";
        console.log(`[review-post] ${msg.threadKey} skipped: ${why} (repo ${repoCtx.repo ?? "none"})`);
        if (unpostable && repoCtx.repo) {
          const detail =
            unpostable.reason === "closed" ? "the PR is closed" : "the PR's head could not be verified on GitHub";
          await io
            .reply(`ℹ️ Review not posted to ${repoCtx.repo}#${unpostable.number}: ${detail} — this verdict is Slack-only.`)
            .catch(() => {});
        }
      }
    }
    if (postTarget) {
      const where = `${postTarget.repo}#${postTarget.number}`;
      // Reviewed-head guard (item 8): the review is posted to this PR only if
      // the commit the agent reviewed IS the PR head resolved for this run.
      // Observed HEAD is authoritative; the verdict's reported head is the
      // fallback; unknown either way → no post (fail-closed). Found live on
      // PR #182 (2026-08-29): the agent reviewed another PR's branch and its
      // LGTM was posted — and auto-approved — on the wrong PR.
      const head = checkReviewedHead({ expected: reviewHead, observed: observedHead, reported: verdict?.head });
      if (!head.ok) {
        console.log(`[review-post] ${msg.threadKey} skipped: ${head.reason} (${where})`);
        await io.reply(`ℹ️ Review not posted to ${where}: ${head.reason} — this verdict is Slack-only.`).catch(() => {});
        postTarget = null;
      }
    }
    if (postTarget && reviewHead) { // narrowing only — the guard above already required it
      const post = deps.postReviewComment ?? postReviewComment;
      // Pinned to the PR head the guard just verified was reviewed — or, for a
      // review carried across a rebase (item 12), to the new head it applies
      // to — so the org's auto-approve stale-review check bites on a later push
      // and not on this one.
      const pinned = carried?.current ?? reviewHead;
      const target: ReviewCommentTarget = { ...postTarget, commitId: pinned };
      // The verdict line is built here, by code — the model's prose never
      // decides whether the body starts with "LGTM:" (auto-approve contract).
      const body = carried ? `${buildReviewPostBody(answer, verdict)}\n\n${carriedFooter(carried)}` : buildReviewPostBody(answer, verdict);
      const where = `${postTarget.repo}#${postTarget.number}`;
      try {
        await post(target, body);
        console.log(`[review-post] ${msg.threadKey} → ${where} (${verdict?.verdict ?? "no verdict"})${carried ? ` carried ${carried.reviewed.slice(0, 7)} → ${pinned.slice(0, 7)}` : ""}`);
        if (carried) await io.reply(headCarriedNote({ where, ...carried })).catch(() => {});
        // Head-moved note (item 10): a push that landed after the head was last
        // checked makes this a review of an outdated commit — pinned, so it
        // will not auto-approve (correct) but silent in the thread (not). One
        // best-effort GET after the post; unknown current head → no note, never
        // a false alarm. The default `currentPrHeadSha` never throws; the
        // `.catch` guards an injected `deps.fetchPrHead` (the seam's contract
        // is "undefined or a throw both mean unknown").
        const fetchHead = deps.fetchPrHead ?? currentPrHeadSha;
        const current = await fetchHead({ repo: postTarget.repo, number: postTarget.number }).catch(() => undefined);
        const moved = headMovedNote({ where, reviewed: pinned, current });
        if (moved) {
          console.log(`[review-post] ${msg.threadKey} head moved after review: ${pinned.slice(0, 7)} → ${current?.slice(0, 7)} (${where})`);
          await io.reply(moved).catch(() => {});
        }
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[review-post] ${msg.threadKey} failed for ${where}: ${reason}`);
        await io.reply(`ℹ️ Review not posted to ${where}: ${reason} — this verdict is Slack-only.`).catch(() => {});
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // A card left spinning after a setup failure looks like a hang; close it.
    // Only a card still in setup — a run failure was already closed by the run
    // loop with its checklist, and must not be relabeled here.
    await setupCard?.done({ title: `❌ setup failed · ${errMsg.slice(0, 120)}` }).catch(() => {});
    await io.reply(errorReply(err)).catch(() => {});
    // A run that threw still has its record (status `failed`, built at finish);
    // a setup failure before the run started has none — nothing to write. A run
    // whose loop completed but whose card close or reply threw lands here too:
    // its record is written as `failed`, never `completed`.
    writeHistory(true);
  } finally {
    activeRuns--;
  }
}

/** Item 12: the PR's commits over its base at the reviewed head and at the
 *  current one (two compare GETs, in parallel), classified. Undefined — no
 *  verdict — when the base branch is unknown or either list could not be
 *  fetched; the caller then falls back to item 10. */
async function classifyMove(
  deps: CoreDeps,
  q: { repo: string; base: string | undefined; from: string; to: string },
): Promise<{ move: HeadMove; before: PrCommitList; after: PrCommitList } | undefined> {
  if (!q.base) return undefined;
  const fetchCommits = deps.fetchPrCommits ?? prCommitsSince;
  const [before, after] = await Promise.all([
    fetchCommits({ repo: q.repo, base: q.base, sha: q.from }).catch(() => undefined),
    fetchCommits({ repo: q.repo, base: q.base, sha: q.to }).catch(() => undefined),
  ]);
  if (!before || !after) return undefined;
  return { move: classifyHeadMove(before, after), before, after };
}

/** The agent name an inline (no-model) command run carries in its `RunMeta` and
 *  record — the one value `runs list agent=command` selects on. */
export const COMMAND_RUN_AGENT = "command";

/**
 * Answer one parsed chat command through the registry as the message's user:
 * the caller carries the message's channel + thread as its `origin`, and a LAZY
 * repo resolver (history + the production repo resolver) for the commands that
 * ask for the thread's bound repo (`memory list` with the repo scope) — paid
 * only when asked. Commands that do work (`isInlineRunCommand`) are recorded as
 * inline runs; help/usage replies and read-only answers are not.
 */
async function runChatCommand(deps: CoreDeps, msg: IncomingMessage, io: ChannelIO, parsed: ParsedChatCommand): Promise<ChatCommandResult> {
  const commands = deps.commands;
  if (!commands) return { ok: false, text: "" };
  const resolveRepo = async (): Promise<string | undefined> => (await resolveRepoForCommand(deps, msg, await io.history())).repo;
  const invoke = () => invokeChatCommand({ commands, parsed, msg, config: deps.config, resolveRepo });
  if (parsed.kind === "invoke" && isInlineRunCommand(parsed.id)) return runInlineCommandRun(deps, msg, cliWords(parsed.id)[0], io, invoke);
  return invoke();
}

/**
 * Run an inline (no-model) command AS a run (#244): register it in the run
 * registry under a `<command> · #channel · user · "…"` label with the caller's
 * identity as its `RunMeta` (agent `command`), publish the request as the
 * `input` event and the reply as the `answer` event, finish it with its status,
 * hand the channel its receipt — `completed` when the command did its work,
 * `failed` when it was refused, misconfigured, or threw — and persist it through
 * the same `runHistoryWriter` path as an agent run, so a scheduled firing
 * outlives the registry TTL. The run record is the canonical trace
 * (command-registry principle, #157); the channel reply is a projection of it.
 * A thrown command still finishes its run (as `failed`, with the `⚠️ <error>`
 * reply as its `answer`) and the error propagates to the dispatcher's outer
 * handler.
 */
async function runInlineCommandRun<T extends { text: string; ok: boolean }>(deps: CoreDeps, msg: IncomingMessage, command: string, io: ChannelIO, execute: () => Promise<T>): Promise<T> {
  const registry = deps.runRegistry ?? defaultRunRegistry;
  const run = registry.create(
    composeRunLabel({ agent: command, channelId: msg.channelId, userId: msg.userId, channelName: msg.channelName, userName: msg.userName, text: msg.text }),
    { agent: COMMAND_RUN_AGENT, channelId: msg.channelId, userId: msg.userId, threadKey: msg.threadKey },
  );
  registry.publish(run.id, { type: "input", text: redactSecrets(msg.text), at: Date.now() });
  let result: T | undefined;
  try {
    result = await execute();
    registry.publish(run.id, { type: "answer", text: redactSecrets(result.text), at: Date.now() });
    return result;
  } catch (err) {
    // A thrown command still gets an `answer`: the same `⚠️ <error>` line the
    // dispatcher's outer handler replies with, so the record explains its
    // `failed` status and the channel reply stays a projection of it.
    registry.publish(run.id, { type: "answer", text: redactSecrets(errorReply(err)), at: Date.now() });
    throw err;
  } finally {
    const status: RunStatus = result?.ok ? "completed" : "failed";
    registry.finish(run.id, status);
    io.runFinished?.({ id: run.id, status });
    if (deps.runHistoryWriter) {
      // Two events and no tool output: assembling the record here is cheap, and
      // `write` is fire-and-forget, so the reply is not delayed.
      const snap = registry.snapshot(run.id, run.token);
      const finishedAt = snap?.finishedAt ?? Date.now();
      const diagnosis = analyzeRunFriction(snap?.events ?? [], { finished: true, truncated: snap?.truncated ?? false });
      deps.runHistoryWriter.write(assembleRunRecord({ run, snap, agent: COMMAND_RUN_AGENT, msg, finishedAt, status, diagnosis }));
    }
  }
}

/** The one shape a dispatch failure is reported in — the outer handler's reply
 *  and a failed inline run's `answer` are built from it, so they cannot drift. */
function errorReply(err: unknown): string {
  return `⚠️ ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * The persisted `RunRecord` for a finished run — the ONE assembly both an agent
 * run and an inline command run go through: the registry's redacted label and
 * finish-time snapshot, the caller's identity from the message, the terminal
 * status, and the diagnosis; then `fitRecordToBudget`. `repo`/`model` are omitted
 * (not set undefined) when absent, so the record's JSON is exactly what the
 * store measures and `isRunRecord` re-validates. The backlog is bounded (count +
 * bytes) while `eventCount` is the published total: a run that outgrew it is
 * `truncated` before the byte budget is even considered.
 */
function assembleRunRecord(input: {
  run: RunHandle;
  snap: RunSnapshot | null;
  agent: string;
  model?: string;
  msg: Pick<IncomingMessage, "channelId" | "userId" | "threadKey" | "sourceUrl">;
  repo?: string;
  finishedAt: number;
  status: RunStatus;
  diagnosis: FrictionDiagnosis;
}): RunRecord {
  const { run, snap, msg } = input;
  const events = snap?.events ?? [];
  const fitted = fitRecordToBudget({
    id: run.id,
    ...(run.label !== undefined ? { label: run.label } : {}),
    agent: input.agent,
    ...(input.model !== undefined ? { model: input.model } : {}),
    channelId: msg.channelId,
    userId: msg.userId,
    threadKey: msg.threadKey,
    ...(input.repo !== undefined ? { repo: input.repo } : {}),
    startedAt: snap?.startedAt ?? input.finishedAt,
    finishedAt: input.finishedAt,
    status: input.status,
    eventCount: snap?.eventCount ?? events.length,
    storedEventCount: events.length,
    truncated: false,
    events,
    diagnosis: input.diagnosis,
    // What the run was last doing / how it ended, and where it came from — so the
    // index can say what failed and link the thread without the events (item 20).
    ...(activityOfEvents(events) !== undefined ? { activity: activityOfEvents(events) } : {}),
    ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
  });
  return fitted.eventCount !== fitted.storedEventCount ? { ...fitted, truncated: true } : fitted;
}

// ---- channel-agnostic output (channel-formatter feature, #76) ---------------

/**
 * Send the agent's answer to the channel. Two paths, chosen by config:
 *
 * - Flag OFF (default, `output.structured` unset/false): the answer is sent
 *   verbatim via `io.reply` — identical to today (each channel converts the
 *   Markdown as it always has). Zero behavior change.
 * - Flag ON: the answer is converted to a channel-agnostic structured message
 *   (a constrained model pass), zod-validated with fixed-retry self-heal, then
 *   rendered by the channel's own ChannelFormatter and sent as a native payload.
 *   On validation failure after the retries it falls back to a plain render of
 *   the raw answer — the run never fails over formatting.
 *
 * The core stays platform-blind: it uses the channel-provided formatter (or a
 * PlainTextFormatter default) and `sendFormatted` (or `reply`), never Slack code.
 */
async function sendAnswer(
  deps: CoreDeps,
  io: ChannelIO,
  threadKey: string,
  model: { provider: Provider; model: string; maxTokens: number },
  answer: string,
): Promise<void> {
  if (!deps.config.config.output?.structured) {
    await io.reply(answer);
    return;
  }

  const produce = providerProducer({
    provider: model.provider,
    model: model.model,
    answer,
    maxTokens: model.maxTokens,
  });
  const result = await produceStructured(produce, {
    fallbackText: answer,
    onWarn: (m) => console.warn(`[structured] ${threadKey} ${m}`),
  });
  if (result.fellBack) {
    console.warn(`[structured] ${threadKey} used plain fallback after ${result.attempts} attempt(s)`);
  }

  const formatter: ChannelFormatter = io.formatter ?? new PlainTextFormatter();
  const payload = formatter.format(result.message);
  if (io.sendFormatted) {
    await io.sendFormatted(payload);
  } else {
    await io.reply(payload);
  }
}

/** The external live-view capability URL for a run, or undefined when
 *  PUBLIC_BASE_URL is unset/blank — the feature degrades gracefully (no link,
 *  everything else works). The token is a per-run capability, unguessable and
 *  scoped to one run; it is not a logged credential. */
function liveViewLink(id: string, token: string): string | undefined {
  const base = process.env.PUBLIC_BASE_URL?.trim();
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}/runs/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`;
}

// ---- run label (Area 2 / live-view index) -----------------------------------

/** Everything `composeRunLabel` needs to build one human-readable run label.
 *  Channel-agnostic: `channelName`/`userName` are optional display hints (Slack
 *  provides them; HTTP/MCP don't), and `channelId`/`userId` are the always-present
 *  namespaced ids the label falls back to. */
export interface RunLabelInput {
  /** Resolved agent name — the label always leads with this. */
  agent: string;
  /** Target repo (`owner/name`) for repo runs; absent for chat runs. */
  repo?: string;
  /** Namespaced channel id (`slack:C…`), used when no `channelName` resolved. */
  channelId: string;
  /** Namespaced user id (`slack:U…`), used when no `userName` resolved. */
  userId: string;
  /** Human channel/conversation name, if the adapter resolved one. */
  channelName?: string;
  /** Human user display name, if the adapter resolved one. */
  userName?: string;
  /** The request text; a short quoted snippet of it is appended to the label. */
  text: string;
}

/** Max chars in a snippet before it is cut (at a word boundary) and ellipsized —
 *  a laptop-width index row holds ~100 after the started column, chips and facts
 *  (live-view item 21; was 60, which left half the row empty). */
const SNIPPET_MAX = 100;
/** Hard cap on the whole label so one hostile/huge field can't dominate the index
 *  (the registry's own cap is 200). */
const RUN_LABEL_MAX = 160;

/** Drop the platform prefix from a namespaced id (`slack:U0123` → `U0123`) so an
 *  id fallback reads a little better when no display name is available. */
function stripPlatformPrefix(id: string): string {
  const i = id.indexOf(":");
  return i === -1 ? id : id.slice(i + 1);
}

/** Rewrite one URL into its shortest useful display form: a GitHub PR/issue
 *  becomes `owner/repo#N` (any trailing `/files`, `#discussion_…` dropped);
 *  anything else loses its scheme and `www.` so the host/path is what shows. */
function compactUrl(url: string): string {
  const gh = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+)\/(?:pull|issues)\/(\d+)/.exec(url);
  if (gh) return `${gh[1]}#${gh[2]}`;
  return url.replace(/^https?:\/\/(?:www\.)?/, "");
}

/** Make request text readable: Slack's `<url|label>` renders as its label,
 *  `<url>` as the url, mentions/channels as `@name`/`#name`. With `compact`
 *  (the run-label snippet) every URL also loses its scheme/`www.` and GitHub
 *  PR/issue URLs become `owner/repo#N` — the raw mrkdwn a Slack review request
 *  carries (`<https://github.com/…/pull/41|…>`) would otherwise be sliced
 *  mid-URL by the snippet budget. Without it (message events) URLs stay whole
 *  so the run page can render them as links. */
function humanizeLinks(text: string, compact = true): string {
  const show = (url: string) => (compact ? compactUrl(url) : url);
  // `<url|label>`: the label alone for the compact snippet. For message text the
  // url must survive so the run page can link it — Slack's auto-link form (label
  // = the url, or the url minus scheme/`www.`/trailing slash) becomes the bare
  // url; a genuine custom label becomes `label (url)`.
  const labelled = (url: string, label: string) => {
    if (!label.trim()) return show(url);
    if (compact) return label;
    return isAutoLinkLabel(url, label) ? url : `${label} (${url})`;
  };
  return (
    text
      // Slack mentions: `<@U…|name>` / `<#C…|name>` / `<!subteam^S…|@eng>` keep
      // their label; label-less ones become a readable stub rather than a raw id.
      .replace(/<@[^<>|\s]+\|([^<>]*)>/g, (_m, label: string) => `@${label.replace(/^@/, "")}`)
      .replace(/<@[^<>\s]+>/g, "@user")
      .replace(/<#[^<>|\s]+\|([^<>]*)>/g, (_m, label: string) => `#${label.replace(/^#/, "")}`)
      .replace(/<#[^<>\s]+>/g, "#channel")
      .replace(/<!(?:here|channel|everyone)(?:\|[^<>]*)?>/g, (m) => `@${/here|channel|everyone/.exec(m)![0]}`)
      .replace(/<!subteam\^[^<>|\s]+\|([^<>]*)>/g, (_m, label: string) => `@${label.replace(/^@/, "")}`)
      .replace(/<!subteam\^[^<>\s]+>/g, "@group")
      // Slack links: `<url|label>` → label (or the compacted url when empty), `<url>` → url.
      .replace(/<([^<>|\s]+)\|([^<>]*)>/g, (_m, url: string, label: string) => labelled(url, label))
      .replace(/<([a-z][a-z0-9+.-]*:\/\/[^<>\s]+)>/gi, (_m, url: string) => show(url))
      // Bare URLs: trailing sentence punctuation (`…/pull/12,` / `…/a).`) belongs
      // to the prose, not the url, so it is left in place.
      .replace(/\bhttps?:\/\/[^\s<>"']+/gi, (url) => {
        const trail = /[)\].,;:!?'"]+$/.exec(url)?.[0] ?? "";
        return show(url.slice(0, url.length - trail.length)) + trail;
      })
  );
}

/** Slack auto-links a pasted URL as `<url|label>` where the label is the url
 *  itself, often without its scheme, `www.` or trailing slash. */
function isAutoLinkLabel(url: string, label: string): boolean {
  const strip = (s: string) => s.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  return strip(url) === strip(label);
}

/** Slack delivers message text with `&`, `<`, `>` as `&amp;`/`&lt;`/`&gt;` (the
 *  mrkdwn structural characters — the inverse of `escapeMrkdwn`). Undo that
 *  ONCE, after the `<…>` markup has been unwrapped so a literal `&lt;` never
 *  becomes structural. Pure string work: the core stays free of Slack imports. */
function unescapeSlackEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** The human-readable form of a Slack-authored turn for the run record: link,
 *  mention and channel markup unwrapped — `<url>` and auto-link `<url|url>` →
 *  the whole url, custom `<url|label>` → `label (url)`, never compacted — and
 *  entities unescaped. Only for text that came in through a channel — model
 *  output is not mrkdwn and must not pass through here. */
export function humanizeMessageText(text: string): string {
  return markdownEmphasis(unescapeSlackEntities(humanizeLinks(text, false)));
}

/** mrkdwn's bold in Markdown terms, so the run page's markdown renderer reads a
 *  Slack-authored turn as the human saw it (live-view item 18): `*bold*` →
 *  `**bold**` when the asterisks delimit a run that starts and ends on non-space
 *  (mrkdwn's rule) and sit on word edges — a glob (`src/*.ts`) or arithmetic
 *  (`2 * 3 * 4`) is left alone. Code spans and fences are left byte-for-byte.
 *  `_italic_` already means the same in both dialects; block-level mrkdwn (`•`
 *  bullets, quotes) cannot survive here — `parseDirectives` has already collapsed
 *  the request to one line. */
function markdownEmphasis(text: string): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/(^|[\s(\[{"'>])\*(\S(?:[^*\n]*?\S)?)\*(?=$|[\s)\]}.,!?:;"'<])/gm, "$1**$2**");
  }
  return parts.join("");
}

/** Whether a channel's text is Slack mrkdwn (AGENTS.md invariant 4: the id
 *  prefix names the platform) — the ONE gate on `humanizeMessageText` for the
 *  run record. HTTP, MCP, CLI and cron text is not mrkdwn and is recorded raw,
 *  exactly as the model received it. */
export function isMrkdwnChannel(channelId: string): boolean {
  return channelId.startsWith("slack:");
}

/** A short, quoted snippet of the request text for a run label: links
 *  humanized, whitespace collapsed, cut at the first sentence end or ~SNIPPET_MAX
 *  chars (whichever comes first, on a word boundary), ellipsized when anything
 *  was dropped. Empty/whitespace-only text → undefined (no snippet segment). */
function textSnippet(text: string): string | undefined {
  const collapsed = humanizeLinks(text).replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  // First sentence, when it ends within the budget AND there is more after it.
  // `#41` / `example.com/x` must not count as a sentence end, so a period only
  // ends a sentence when followed by whitespace. (No `$` alternative: it would
  // match the end of the SLICE, turning a dot at the budget edge inside a token
  // into a false sentence end. A dot ending the whole text needs no sentence
  // cut — the "whole thing fits" branch below covers it.)
  const end = collapsed.slice(0, SNIPPET_MAX + 1).search(/[.!?](?=\s)/);
  if (end !== -1 && end + 1 < collapsed.length) return `"${collapsed.slice(0, end)}…"`;
  // Otherwise the whole thing if it fits …
  if (collapsed.length <= SNIPPET_MAX) return `"${collapsed}"`;
  // … or a word-boundary cut with an ellipsis (fall back to a hard cut if the
  // first "word" alone already overflows the budget).
  const hard = collapsed.slice(0, SNIPPET_MAX);
  const wordCut = hard.replace(/\s+\S*$/, "").trimEnd();
  const body = wordCut.length >= SNIPPET_MAX / 2 ? wordCut : hard.trimEnd();
  return `"${body}…"`;
}

/** Longest `assistant` excerpt shown as the card's one-line activity trace. */
const ASSISTANT_TRACE_CAP = 80;

/**
 * The one-line activity trace the status card shows for a run event (the card
 * is a digest; the run page is the record). An `assistant` turn becomes a short
 * `💬` excerpt — one line, replaced by the next event, so the model's prose is
 * visible in-channel without ever growing the card. `input`, `context` and
 * `answer` are published straight to the registry and never arrive here; the
 * fallbacks only keep the switch total.
 */
function activityLine(e: RunEvent): string {
  switch (e.type) {
    case "tool_call":
      return `→ ${e.summary}`;
    case "tool_result":
      return `${e.ok ? "✓" : "✗"} ${e.tool}: ${e.summary}`;
    case "run_note":
      return `⏱ ${e.summary}`;
    case "assistant": {
      const oneLine = e.text.replace(/\s+/g, " ").trim();
      return `💬 ${oneLine.length > ASSISTANT_TRACE_CAP ? `${oneLine.slice(0, ASSISTANT_TRACE_CAP)}…` : oneLine}`;
    }
    case "input":
      return "request received";
    case "context":
      return "context recorded";
    case "answer":
      return "answer ready";
    case "turn":
      return `💭 thought for ${formatTurnDuration(e.durationMs)}`;
    case "run_meta":
      return "run context recorded"; // published straight to the registry too — never arrives here
  }
}

/**
 * One-line note of what rode along with the request, for the `input` event
 * (features/live-view.md item 12): `[+2 images, 1 document]`. Counts only — the
 * payloads never enter the run stream. Empty when nothing was attached.
 */
export function attachmentSuffix(images: ImageAttachment[] | undefined, documents: DocumentAttachment[] | undefined): string {
  const parts: string[] = [];
  if (images && images.length > 0) parts.push(`${images.length} image${images.length === 1 ? "" : "s"}`);
  if (documents && documents.length > 0) parts.push(`${documents.length} document${documents.length === 1 ? "" : "s"}`);
  return parts.length > 0 ? `[+${parts.join(", ")}]` : "";
}

/**
 * Build the human-first run label shown on the Access-gated `/runs` index. Rules:
 * - always lead with the agent name;
 * - a repo run is repo-identified (`coding · owner/repo · "…"`);
 * - a chat run shows channel + user (`review · #<channel> · <user> · "…"`),
 *   preferring display names and falling back to the prefix-stripped ids;
 * - a short quoted snippet of the request is appended when the text is non-empty;
 * - the whole thing is capped to RUN_LABEL_MAX chars.
 * Pure and channel-agnostic (HTTP/MCP have no names → the id fallback applies).
 */
export function composeRunLabel(input: RunLabelInput): string {
  const segments: string[] = [input.agent];
  if (input.repo) {
    segments.push(input.repo);
  } else {
    segments.push(`#${input.channelName ?? stripPlatformPrefix(input.channelId)}`);
    segments.push(input.userName ?? stripPlatformPrefix(input.userId));
  }
  const snippet = textSnippet(input.text);
  if (snippet) segments.push(snippet);
  const label = segments.join(" · ");
  return label.length > RUN_LABEL_MAX ? `${label.slice(0, RUN_LABEL_MAX - 1).trimEnd()}…` : label;
}

/** Prefixes the core stamps on status text — adapters use this to filter their
 *  own status noise out of history. */
export const STATUS_PREFIXES = ["⏳", "✅", "◐", "◓", "◑", "◒"];

/** The live card's rotating glyph (one step per heartbeat/event frame). */
const SPINNER_GLYPHS = ["◐", "◓", "◑", "◒"];

/** Prefixes that mean "this card's run is still in flight": the spinner, and
 *  the 👀 setup card posted before the run loop owns it. A card that still
 *  starts with one of these after its process is gone is an orphan — the
 *  Slack adapter's reconnect sweep closes it as interrupted (features/
 *  slack-channel.md item 8). Kept next to the glyphs it derives from so the
 *  two cannot drift apart. */
export const LIVE_CARD_PREFIXES = [...SPINNER_GLYPHS, "👀"];

/** Set by the process-wide drain (SIGTERM from a deploy rollout) and appended to
 *  every live card's heartbeat frame, so a reader can tell "finishing this run
 *  before the bot restarts" from a run that is merely slow. `undefined` clears
 *  it (tests). A plain module-level value: the drain is process-wide by nature
 *  and every in-flight run must show it, not only runs started after it. */
let shutdownNotice: string | undefined;
export function setShutdownNotice(notice: string | undefined): void {
  shutdownNotice = notice;
}

function buildMessages(
  history: HistoryItem[],
  currentText: string,
  currentImages?: ImageAttachment[],
  currentDocuments?: DocumentAttachment[],
): ChatMessage[] {
  const messages: ChatMessage[] = history.map((h) => ({
    role: h.role,
    content: turnContent(h.text, h.images, h.documents),
  }));
  messages.push({ role: "user", content: turnContent(currentText, currentImages, currentDocuments) });
  return normalizeAlternation(messages);
}

/**
 * Attachments first (images, then documents), then the user's text — a turn
 * always has at least one part. PDFs become a native `document` part; text/code
 * files are inlined as a fenced text part naming the file (provider-agnostic).
 * Exported for tests.
 */
export function turnContent(
  text: string,
  images?: ImageAttachment[],
  documents?: DocumentAttachment[],
): ContentPart[] {
  const parts: ContentPart[] = (images ?? []).map((img) => ({
    type: "image" as const,
    mediaType: img.mediaType,
    data: img.data,
  }));
  for (const doc of documents ?? []) {
    if (doc.mediaType === "application/pdf") {
      parts.push({ type: "document", mediaType: doc.mediaType, data: doc.data, name: doc.name });
    } else {
      parts.push({ type: "text", text: fenceFile(doc.name, doc.data) });
    }
  }
  if (text) parts.push({ type: "text", text });
  if (parts.length === 0) parts.push({ type: "text", text: "(empty message)" });
  return parts;
}

/**
 * The text recorded for one turn in the run stream (#157 R1): the turn's text
 * plus one metadata line per attachment — name, media type, decoded size — and
 * NEVER the attachment itself (no base64, no file body). Images and PDFs carry
 * base64 (size = decoded bytes); text/code documents carry their decoded text.
 * The text is humanized (`humanizeMessageText`: Slack link/mention markup
 * unwrapped, entities unescaped) — every caller feeds channel-authored turns.
 * Redaction happens at publish, not here.
 */
function messageText(text: string, humanize: boolean, images?: ImageAttachment[], documents?: DocumentAttachment[]): string {
  const lines = [(humanize ? humanizeMessageText(text) : text).trim()];
  for (const img of images ?? []) lines.push(attachmentLine(img.name, img.mediaType, Buffer.byteLength(img.data, "base64")));
  for (const doc of documents ?? []) {
    const bytes = Buffer.byteLength(doc.data, doc.mediaType === "application/pdf" ? "base64" : "utf8");
    lines.push(attachmentLine(doc.name, doc.mediaType, bytes));
  }
  return lines.filter((l) => l.length > 0).join("\n");
}

function attachmentLine(name: string | undefined, mime: string, bytes: number): string {
  return `[attachment: ${name ?? "attachment"} · ${mime} · ${bytes} bytes]`;
}

/**
 * The thread-context turns to record as `context` events (#157 KTD8): the
 * NEWEST turns first, at most `CONTEXT_MAX_ITEMS`, until the redacted texts
 * together exceed `CONTEXT_MAX_BYTES` — then returned in thread order. Each turn is prefixed with its role so a context row reads as
 * the conversation did; attachments are metadata lines (see `messageText`).
 */
function contextMessageTexts(history: readonly HistoryItem[], humanize: boolean): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (let i = history.length - 1; i >= 0 && kept.length < CONTEXT_MAX_ITEMS; i--) {
    const h = history[i];
    const text = `${h.role}: ${messageText(h.text, humanize, h.images, h.documents)}`;
    // Budget what will actually be published (publishText redacts).
    const size = utf8ByteLength(redactSecrets(text));
    if (bytes + size > CONTEXT_MAX_BYTES) break;
    bytes += size;
    kept.push(text);
  }
  return kept.reverse();
}

/** Inline a text/code file's content, fenced and labeled with its name. */
function fenceFile(name: string | undefined, content: string): string {
  return `\n\n[file: ${name ?? "attachment"}]\n\`\`\`\n${content}\n\`\`\`\n`;
}

/** Providers require user-first and behave best with merged consecutive roles. */
function normalizeAlternation(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content.push(...m.content);
    } else {
      out.push({ role: m.role, content: [...m.content] });
    }
  }
  while (out.length > 0 && out[0].role !== "user") out.shift();
  return out;
}

/** Repo resolution for a chat command that asks for the thread's bound repo
 *  (`Caller.origin.repo`, e.g. `memory list` with the repo scope, #253): the
 *  injected resolver in tests, the production resolver (registry-vetted slugs,
 *  PR → repo) otherwise; a failure means "no repo bound", never an error reply. */
async function resolveRepoForCommand(deps: CoreDeps, msg: IncomingMessage, history: HistoryItem[]): Promise<RepoContext> {
  try {
    return (
      (await (deps.resolveRepoContext
        ? deps.resolveRepoContext(msg, history)
        : resolveRepoContext(msg, history, residentOnboardedProbe(deps.config.config.execution?.resident)))) ?? {}
    );
  } catch {
    return {};
  }
}

