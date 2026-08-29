import { MAX_INSTRUCTIONS_LENGTH, type ConfigStore, type Scope } from "../config.js";
import { configAwarenessBlock } from "./configAwareness.js";
import { customInstructionsBlock } from "./customInstructions.js";
import { AGENTS, getAgent } from "../agents/registry.js";
import { lastThreadDirectives, parseDirectives } from "../directives.js";
import { runAgent } from "../runner.js";
import { makeWebCapability } from "../tools/web.js";
import { localWorkspaceDir, makeExecutor } from "../execution/factory.js";
import { ResidentNeedsRefError, ResidentOperations } from "../execution/resident.js";
import { LocalOperations } from "../execution/executor.js";
import { parseModelRef, type ChatMessage, type ContentPart } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { resolveRepoContext, type RepoContext } from "./repoContext.js";
import { decideReviewPost } from "./reviewPost.js";
import { postReviewComment, type ReviewCommentTarget } from "../execution/githubComments.js";
import { buildReviewPostBody, type ReviewVerdict } from "./reviewVerdict.js";
import { handleRepoCommand, parseRepoCommand, type ResidentAdminClient } from "./repoCommands.js";
import { recognizeOperation, type Operations, type RecognizedOp } from "./operations.js";
import { memoryContextBlock, scheduleReflection, type MemoryStore } from "./memory/index.js";
import { skillGuidanceBlock, type SkillStore } from "../skills/index.js";
import { redactSecrets, type RunEvent } from "./runEvents.js";
import { analyzeRunFriction } from "./runFriction.js";
import type { FrictionLedger } from "./frictionLedger.js";
import type { IssueTracker } from "../execution/githubIssues.js";
import { handleFrictionCommand } from "./frictionCommands.js";
import { defaultRunRegistry, type RunRegistry } from "./runRegistry.js";
import { PlainTextFormatter, type ChannelFormatter } from "./structuredMessage.js";
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
   * Admin client for the resident Worker's repo-management routes (U8);
   * injectable for tests. Default: a fetch client built per command from
   * execution.resident.baseUrl + the RESIDENT_ADMIN_TOKEN env bearer.
   */
  residentAdmin?: ResidentAdminClient;
  /**
   * Deterministic-operations backend behind the modelless fast-path (U6,
   * KTD8); injectable for tests. Default per dispatch: resident-backed when
   * execution.resident is configured (operator bearer), local when execution
   * is local, else none — the recognizer then falls through to the agent.
   */
  operations?: Operations;
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
   * Where `friction propose` files its proposals. Default: the GitHub REST
   * tracker with the App installation token (App `issues:write`; never a `gh`
   * shell-out — AGENTS.md invariant 5). Injectable so tests assert filing
   * without a network call.
   */
  issueTracker?: IssueTracker;
}

const STATUS_UPDATE_MIN_MS = 3000;
/** Max run events kept per run for the post-run friction diagnosis (#84); the newest are kept. */
const RUN_EVENTS_CAP = 5000;

// In-flight run tracking so the process can drain before exiting (restarts
// must not kill runs mid-flight — see index.ts signal handling).
let activeRuns = 0;
export function activeRunCount(): number {
  return activeRuns;
}

export async function dispatch(deps: CoreDeps, msg: IncomingMessage, io: ChannelIO): Promise<void> {
  let counted = false; // whether this dispatch holds an activeRuns slot
  // The ack card while setup is still in progress. Cleared the moment it
  // becomes the run card, so the outer catch closes ONLY a card that setup
  // left open — a run failure is closed (with its checklist) by the run loop.
  let setupCard: StatusHandle | undefined;
  try {
    // Config commands are answered inline, never sent to a model.
    const configReply = handleConfigCommand(deps.config, msg);
    if (configReply) {
      await io.reply(configReply);
      return;
    }

    // Repo-management commands (U8) are config-family too: answered inline,
    // never a model turn. Gated inside — canManageRepos is KTD9 fail-closed
    // for everything but `repo list`. The message is parsed as a repo command
    // ONCE per dispatch; the op recognizer below reuses the same result.
    const repoCmd = parseRepoCommand(msg.text);
    const repoReply = await handleRepoCommand(deps.config, msg, deps.residentAdmin, repoCmd);
    if (repoReply) {
      await io.reply(repoReply);
      return;
    }

    // Self-improvement commands (Area 7b, #84) are config-family too: `friction
    // report` reads the ledger; `friction propose` files deduped issue
    // proposals (gated inside: canManageRepos, fail-closed). Never a model turn.
    const frictionReply = await handleFrictionCommand(deps.config, msg, {
      ledger: deps.frictionLedger,
      tracker: deps.issueTracker,
    });
    if (frictionReply) {
      await io.reply(frictionReply);
      return;
    }

    const directives = parseDirectives(msg.text);
    const history = await io.history();

    // Deterministic ops fast-path (U6, KTD8): explicit `repo test/build`
    // commands and conservative natural-language forms answer with a REAL op
    // execution and zero model turns, mirroring the config-command
    // inline-reply shape. Only the model call is skipped — the implicit
    // target agent (coding) passes canRunAgent and the repo passes canUseRepo
    // (KD7) before anything executes. Anything ambiguous or non-matching
    // falls through to the agent below (KD3: never guess); on the
    // natural-language path so do not-onboarded repos and backend failures
    // (the agent can still serve the ask), while explicit commands are
    // config-family and always get a reply. An explicit agent:/model:
    // directive disables natural recognition — the user picked a model path.
    const opAsk = recognizeOperation(
      msg.text,
      history,
      { allowNatural: !directives.agent && !directives.model },
      repoCmd,
    );
    if (opAsk) {
      const opReply = await runOperationFastPath(deps, msg, opAsk);
      if (opReply !== null) {
        await io.reply(opReply);
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

    // Acknowledge NOW, before anything slow. Everything between here and the
    // model turn can take minutes — repo/PR resolution (GitHub REST), memory
    // retrieval, and above all executor selection (resident attach or a cold
    // sandbox clone+install) — and until this card existed the thread saw
    // nothing for that whole stretch. The same handle becomes the run's status
    // card below; a refusal or setup failure closes it with a reason instead of
    // leaving a spinner behind.
    let label = `*${agent.name}* on \`${resolved.modelRef}\``;
    const startedAt = Date.now();
    const spinner = ["◐", "◓", "◑", "◒"];
    let frame = 0;
    const title = (icon?: string) =>
      `${icon ?? spinner[frame++ % spinner.length]} ${label} · ${Math.round((Date.now() - startedAt) / 1000)}s`;
    const card = await io.status({ title: `👀 ${label} · preparing workspace…` });
    setupCard = card;

    // Target repo/ref for resident environments, resolved BEFORE the model
    // turn (U7): explicit signals in the message, else the repo this thread
    // already established (from history — restart-safe, never stored). The
    // gate belongs with the resource declaration: an agent that declares no
    // repo (e.g. the toolless general default) never resolves or gates one, so
    // a toolless follow-up in a repo-mentioning thread is not wrongly refused
    // and a PR-URL never triggers a wasted GitHub REST call for it.
    const needsRepo = agent.resources?.repo === "required";
    const repoCtx: RepoContext = needsRepo
      ? ((await (deps.resolveRepoContext ?? resolveRepoContext)(msg, history)) ?? {})
      : {};

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

    // Cross-session memory (Area 7c, #85) — READ path. BEFORE assembling model
    // input, retrieve scope-relevant records (the org's + this user's own,
    // #107 PR B) and render a dedicated advisory context block (kept OUT of
    // history: it rides on the system prompt below, never mixed into the
    // turns). Flag-gated: with memory disabled (default)
    // this resolves to undefined via a NullMemoryStore, leaving `messages` and
    // `system` byte-identical to memory-off.
    const memoryBlock = await memoryContextBlock(
      deps.config.config.memory,
      deps.memory,
      directives.text,
      msg.userId,
    );

    const messages = buildMessages(history, directives.text, msg.images, msg.documents);

    // Executor selection is context-aware: the agent's resource declarations
    // decide whether anything is provisioned at all (general gets nothing),
    // and repo/ref carry resident-repo inference. A resident fallback comes
    // back with a named note (KTD10) that rides on every status frame below.
    let selection: Awaited<ReturnType<typeof makeExecutor>>;
    try {
      selection = await makeExecutor(
        {
          execution: deps.config.config.execution,
          workspaceDir: deps.config.config.workspaceDir ?? "./workspaces",
          dataDir: deps.dataDir ?? "./data",
        },
        { threadKey: msg.threadKey, agent, repo: repoCtx.repo, ref: repoCtx.ref },
      );
    } catch (err) {
      // Ask-once (KTD6): the resident has no ref binding for this thread and
      // the message named no branch — binding is explicit-or-ask-once, never
      // a silent guess. ONE clarifying question, no model turn burned (mirrors
      // the named-refusal reply shape). The user's answer in the thread (e.g.
      // "on main") carries the ref on the next message and re-attach binds it.
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
    const { executor, note, resident } = selection;

    // Effective system prompt, composed AFTER executor resolution (via
    // RunOptions.system, U1): a resident-path run swaps in the agent's
    // resident variant — the workspace is a ready worktree, no cloning, no
    // installs — with the resolved repo named. Every other path keeps the
    // agent's own prompt. Selection reports the resident backend via a
    // discriminant (not an executor `instanceof`), keeping the executor
    // implementation out of the channel-agnostic core. The shared AgentDef is
    // never mutated (concurrent dispatches share it).
    const baseSystem =
      resident && agent.residentSystem
        ? `${agent.residentSystem}\n\nTarget repository: ${repoCtx.repo}. The worktree is already on this thread's bound branch (confirm with \`git branch --show-current\`).`
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
    const withSkills = skillsBlock ? `${baseSystem ?? agent.system}\n\n${skillsBlock}` : baseSystem;

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
      channel: scopes.channel,
      user: scopes.user,
      messageDirective: { agent: directives.agent, model: directives.model },
      threadDirective: { agent: sticky.agent, model: sticky.model },
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
    // NullMemoryStore run.
    const system = [memoryBlock, configBlock, instructionsBlock, withSkills ?? agent.system]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");

    if (note) label = `${label} · ${note}`;
    console.log(`[run] ${msg.threadKey} user=${msg.userId} agent=${agent.name} model=${resolved.modelRef}`);
    setupCard = undefined; // from here the run loop owns the card's close
    card.update({ title: title() }); // the ack card becomes the run card
    let lastToolAt = Date.now();
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
    const run = registry.create(runLabel);
    const liveLink = liveViewLink(run.id, run.token);
    // The card body is the agent's own checklist (via the update_status tool)
    // plus a live one-line activity trace (current tool call + redacted result
    // summary) so the card reflects progress per tool event, not only on the
    // 5s heartbeat. Full command output still goes to stdout for operators.
    let checklist: string | undefined;
    let lastActivity: string | undefined;
    const currentFrame = () => {
      const quiet = Date.now() - lastToolAt;
      const thinking = quiet > 20_000 ? ` — thinking (${Math.round(quiet / 1000)}s since last tool)` : "";
      const detail = [liveLink, checklist, lastActivity].filter(Boolean).join("\n");
      return { title: title() + thinking, detail: detail || undefined };
    };
    const onProgress = (note: string) => {
      console.log(`[note] ${msg.threadKey} ${note}`);
      lastToolAt = Date.now();
    };
    // Live run-visibility (Area 2): each tool call/result refreshes the card
    // immediately, so activity is visible without waiting for the heartbeat.
    let toolCalls = 0; // "did real work" signal for the memory reflection gate
    // The run's own copy of its event stream, for the post-run friction
    // diagnosis (#84): needs no capability token to read back. Bounded as a
    // ring that keeps the NEWEST events, so a pathological run cannot grow it
    // without limit and its terminal signals (budget/infra notes at the very
    // end — the ones most worth diagnosing) are never the part that is lost.
    // Dropping the oldest can only orphan a tool_result, which the analyzer
    // ignores; it can never fabricate a "run ended mid-tool" finding.
    const runEvents: RunEvent[] = [];
    const onEvent = (e: RunEvent) => {
      registry.publish(run.id, e); // feed the external live-view stream
      runEvents.push(e);
      if (runEvents.length > RUN_EVENTS_CAP) runEvents.shift();
      if (e.type === "tool_call") toolCalls++;
      lastToolAt = Date.now();
      lastActivity =
        e.type === "tool_call"
          ? `→ ${e.summary}`
          : e.type === "tool_result"
            ? `${e.ok ? "✓" : "✗"} ${e.tool}: ${e.summary}`
            : e.type === "run_note"
              ? `⏱ ${e.summary}`
              : "answer ready"; // `answer` is published directly to the registry, not through onEvent
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

    // Counted in flight from here until the post-run steps (reply, review
    // post, memory reflection scheduling) have run — decremented in the
    // outer finally — so the shutdown drain can never observe "0 runs, 0
    // reflections" in the window between the run loop ending and the
    // reflection being scheduled.
    activeRuns++;
    counted = true;
    let answer: string;
    // Review verdict, set only through the structured submit_verdict tool; the
    // post-step below turns it into the deterministic first line of the GitHub
    // body (fail-closed: no call → not approving). See reviewVerdict.ts.
    let verdict: ReviewVerdict | undefined;
    const onVerdict = (v: ReviewVerdict) => {
      verdict = v;
    };
    try {
      answer = await runAgent({
        provider,
        model,
        agent,
        messages,
        system,
        toolContext: { executor, reportProgress, web: makeWebCapability(process.env), skills: deps.skills, agentName: agent.name, onVerdict },
        onProgress,
        onEvent,
        control: run.control, // operator stop from /runs (#101)
      });
      // The run record is the source of truth and Slack/GitHub are projections
      // of it: publish the final answer into the stream FIRST (redacted like
      // every event, uncapped — a soft stop's "findings so far" included), then
      // the finally below finishes the run, and only after that is it sent.
      registry.publish(run.id, { type: "answer", text: redactSecrets(answer), at: Date.now() });
    } catch (err) {
      await card.done({ title: title("❌"), detail: checklist });
      throw err;
    } finally {
      clearInterval(heartbeat);
      registry.finish(run.id); // close the live-view stream; start its TTL
      // Friction ledger (#84): diagnose this run's stream and keep the result
      // for the cross-run proposer. Best-effort and fire-and-forget — a ledger
      // failure is a warning line, never a failed run or a delayed reply.
      if (deps.frictionLedger) {
        const ledger = deps.frictionLedger;
        const diagnosis = analyzeRunFriction(runEvents);
        void ledger
          .record({ runId: run.id, label: runLabel, agent: agent.name, finishedAt: Date.now(), diagnosis })
          .catch((err: unknown) =>
            console.warn(`[friction] ${msg.threadKey} ledger write failed: ${err instanceof Error ? err.message : String(err)}`),
          );
      }
      // Give the workspace back now rather than at the inactivity sweep: a
      // resident's pool user is a scarce slot (features/resident-repos.md item
      // 16). Read-only agents hold nothing worth keeping; a coding run keeps
      // its worktree only while it has uncommitted/unpushed work — unless an
      // operator HARD-stopped it (#101), which means "tear it down now": the
      // abandoned command may still be running in there, and the whole point
      // of a hard stop is to free the resources. Best-effort — a failed
      // release is a log line, never a failed run.
      if (executor.release) {
        const mode = agent.toolset === "readonly" || run.control.requested === "hard" ? "always" : "if-clean";
        try {
          const r = await executor.release(mode);
          console.log(`[release] ${msg.threadKey} ${r.released ? "released" : "kept"}${r.reason ? ` (${r.reason})` : ""}`);
        } catch (err) {
          console.warn(`[release] ${msg.threadKey} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // The card's final icon tells the stop apart from a normal finish: ⏹ soft
    // (a summary was written), ⛔ hard (aborted, no summary).
    const stopped = run.control.requested;
    console.log(`[done] ${msg.threadKey} ${answer.length} chars${stopped ? ` (stopped: ${stopped})` : ""}`);
    await card.done({ title: title(stopped === "hard" ? "⛔" : stopped === "soft" ? "⏹" : "✅"), detail: checklist });
    await sendAnswer(deps, io, msg.threadKey, { provider, model, maxTokens: agent.maxTokens }, answer);

    // Cross-session memory (Area 7c, #85) — WRITE path. AFTER the reply has
    // landed, distill this run into memory records: fire-and-forget (tracked
    // only for the shutdown drain), so its latency/failures never reach the
    // user; gated on memory.enabled (default off → nothing happens) and on the
    // run having done real work (tools used, or a long thread). Fast paths
    // above returned before this point and never reflect. A HARD-stopped run
    // has no summary to distill (its answer is the abort line), so it is
    // skipped too; a soft stop wrote a real finale and reflects normally.
    if (stopped !== "hard") scheduleReflection({
      cfg: deps.config.config.memory,
      store: deps.memory,
      providers: deps.providers,
      runModelRef: resolved.modelRef,
      gate: { toolCalls, historyTurns: history.length },
      threadKey: msg.threadKey,
      runId: run.id,
      userId: msg.userId,
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
    const postTarget = stopped === "hard" ? null : decideReviewPost({
      agentName: resolved.agentName,
      repo: repoCtx.repo,
      pr: repoCtx.pr,
      requestText: directives.text,
    });
    if (postTarget) {
      const post = deps.postReviewComment ?? postReviewComment;
      const target: ReviewCommentTarget = repoCtx.headSha ? { ...postTarget, commitId: repoCtx.headSha } : postTarget;
      // The verdict line is built here, by code — the model's prose never
      // decides whether the body starts with "LGTM:" (auto-approve contract).
      const body = buildReviewPostBody(answer, verdict);
      await post(target, body)
        .then(() => console.log(`[review-post] ${msg.threadKey} → ${postTarget.repo}#${postTarget.number} (${verdict?.verdict ?? "no verdict"})`))
        .catch((err: unknown) =>
          console.error(
            `[review-post] ${msg.threadKey} failed for ${postTarget.repo}#${postTarget.number}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // A card left spinning after a setup failure looks like a hang; close it.
    // Only a card still in setup — a run failure was already closed by the run
    // loop with its checklist, and must not be relabeled here.
    await setupCard?.done({ title: `❌ setup failed · ${errMsg.slice(0, 120)}` }).catch(() => {});
    await io.reply(`⚠️ ${errMsg}`).catch(() => {});
  } finally {
    if (counted) activeRuns--;
  }
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

// ---- deterministic ops fast-path (U6, KTD8) ---------------------------------

/** Gate + execute one recognized op. Returns the reply text, or null to fall
 *  through to the agent path. Refusals are replies (a refused user must see
 *  why), and only the model call is ever skipped — never the permission
 *  machinery. */
async function runOperationFastPath(
  deps: CoreDeps,
  msg: IncomingMessage,
  ask: RecognizedOp,
): Promise<string | null> {
  // The implicit target agent for a deterministic op is coding (KTD8): the
  // exact refusal a normal coding-agent request would get, op never executed.
  if (!deps.config.canRunAgent(msg.userId, "coding")) {
    return `🚫 You're not on the allowlist for the \`coding\` agent. Ask ${deps.config.adminsHint()} for access.`;
  }
  if (!deps.config.canUseRepo(msg.userId, ask.repo)) {
    return `🚫 You're not on the allowlist for the \`${ask.repo}\` repo environment. Ask ${deps.config.adminsHint()} for access.`;
  }
  const ops = deps.operations ?? defaultOperations(deps, msg.threadKey);
  if (!ops) {
    return ask.explicit
      ? "⚠️ Deterministic ops need a backend: configure `execution.resident` (with its operator token) or local execution."
      : null;
  }
  console.log(
    `[op] ${msg.threadKey} user=${msg.userId} op=${ask.op} repo=${ask.repo} ref=${ask.ref ?? "(default)"} explicit=${ask.explicit}`,
  );
  const result = await ops
    .run(ask.op, { repo: ask.repo, ...(ask.ref ? { ref: ask.ref } : {}) })
    .catch((err: unknown) => ({ kind: "error" as const, message: err instanceof Error ? err.message : String(err) }));
  switch (result.kind) {
    case "result": {
      const icon = result.ok ? "✅" : "❌";
      const output = result.output?.trim();
      return output ? `${icon} ${result.summary}\n\`\`\`\n${clipOpOutput(output)}\n\`\`\`` : `${icon} ${result.summary}`;
    }
    case "refused":
      return `🚫 ${result.reason}`;
    case "not-onboarded":
      return ask.explicit
        ? `⚠️ \`${ask.repo}\` is not onboarded as a resident, so \`repo ${ask.op}\` has nothing to run against — \`repo onboard ${ask.repo}\` first, or ask the coding agent directly.`
        : null; // natural language: the agent path can still serve the ask
    case "error":
      return ask.explicit ? `⚠️ ${result.message}` : null;
  }
}

/** Default Operations backend, mirroring executor selection's config reads:
 *  resident-backed wherever a resident service is configured, local for local
 *  execution (the thread's local workspace dir — dev/CLI), else none. */
function defaultOperations(deps: CoreDeps, threadKey: string): Operations | null {
  const execution = deps.config.config.execution;
  const resident = execution?.resident;
  if (resident?.baseUrl) {
    const tokenEnv = resident.tokenEnv ?? "RESIDENT_OPERATOR_TOKEN";
    const token = process.env[tokenEnv];
    return token ? new ResidentOperations({ baseUrl: resident.baseUrl, token }) : null;
  }
  if (!execution?.type || execution.type === "local") {
    return new LocalOperations(localWorkspaceDir(deps.config.config.workspaceDir ?? "./workspaces", threadKey));
  }
  return null; // per-thread remote backends have no deterministic-op surface
}

/** Failures usually speak from the END of the output — keep the tail. */
function clipOpOutput(output: string): string {
  const MAX = 3000;
  return output.length > MAX ? `…${output.slice(-MAX)}` : output;
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

/** Max chars in a snippet before it is cut (at a word boundary) and ellipsized. */
const SNIPPET_MAX = 60;
/** Hard cap on the whole label so one hostile/huge field can't dominate the index. */
const RUN_LABEL_MAX = 120;

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

/** Make request text readable as a label: Slack's `<url|label>` renders as its
 *  label and `<url>` as the url; every remaining bare URL is compacted. The raw
 *  mrkdwn a Slack review request carries (`<https://github.com/…/pull/41|…>`)
 *  would otherwise be sliced mid-URL by the snippet budget. */
function humanizeLinks(text: string): string {
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
      .replace(/<([^<>|\s]+)\|([^<>]*)>/g, (_m, url: string, label: string) => (label.trim() ? label : compactUrl(url)))
      .replace(/<([a-z][a-z0-9+.-]*:\/\/[^<>\s]+)>/gi, (_m, url: string) => compactUrl(url))
      // Bare URLs: trailing sentence punctuation (`…/pull/12,` / `…/a).`) belongs
      // to the prose, not the url, so it is left in place.
      .replace(/\bhttps?:\/\/[^\s<>"']+/gi, (url) => {
        const trail = /[)\].,;:!?'"]+$/.exec(url)?.[0] ?? "";
        return compactUrl(url.slice(0, url.length - trail.length)) + trail;
      })
  );
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

// ---- config commands --------------------------------------------------------
// "config show" | "config set channel k=v ..." | "config set me k=v ..."
// "config clear channel|me" | "help"

function handleConfigCommand(config: ConfigStore, msg: IncomingMessage): string | null {
  const text = msg.text.trim();
  if (/^help$/i.test(text)) return helpText();
  const m = text.match(/^config\s+(show|set|clear)\s*(.*)$/is);
  if (!m) return null;
  const [, verb, rest] = m;

  if (verb === "show") return config.describe(msg.channelId, msg.userId);

  const scopeMatch = rest.trim().match(/^(channel|me)\s*(.*)$/is);
  if (!scopeMatch) return `Usage: \`config ${verb} channel|me ...\``;
  const [, scopeName, args] = scopeMatch;

  // Channel-scope changes affect everyone in the channel — gate them.
  // "me" scope stays open: pointing yourself at a restricted agent is harmless
  // because the run-time agent gate still applies to you.
  if (scopeName === "channel" && !config.canEditChannelConfig(msg.userId)) {
    return `🚫 Channel config changes are restricted. Ask ${config.adminsHint()}.`;
  }

  if (verb === "clear") {
    if (scopeName === "channel") config.clearChannelOverride(msg.channelId);
    else config.clearUserOverride(msg.userId);
    return `Cleared ${scopeName === "channel" ? "channel" : "your"} overrides.`;
  }

  // verb === "set"
  const who = scopeName === "channel" ? "channel" : "your";

  // `instructions` is free text (spaces, punctuation), so it takes the whole
  // rest of the line — with or without `=`, optionally quoted (straight or the
  // smart quotes Slack substitutes) — and can't be mixed with k=v tokens.
  // No value at all only SHOWS the current text (a peek must never clear);
  // an explicit empty value (`""`) clears just the instructions, leaving
  // agent/model intact.
  const instr = args.trim().match(/^instructions(?:\s*=\s*|\s+|$)([\s\S]*)$/i);
  if (instr) {
    const raw = instr[1].trim();
    if (raw.length === 0) {
      const scopes = config.scopes(msg.channelId, msg.userId);
      const current = (scopeName === "channel" ? scopes.channel : scopes.user).instructions?.trim();
      const clearHint = `To clear: \`config set ${scopeName} instructions ""\``;
      if (!current) return `No ${who} instructions are set. Example: \`config set ${scopeName} instructions "Always reply in bullet points"\``;
      return `Current ${who} instructions:\n> ${current.replace(/\n/g, "\n> ")}\n${clearHint}`;
    }
    const text = unquote(raw);
    if (text.length > MAX_INSTRUCTIONS_LENGTH) {
      return `That's too long (${text.length} characters). Instructions ride on every turn, so they're capped at ${MAX_INSTRUCTIONS_LENGTH} characters.`;
    }
    const patch: Scope = { instructions: text.length > 0 ? text : undefined };
    const effective =
      scopeName === "channel" ? config.setChannelOverride(msg.channelId, patch) : config.setUserOverride(msg.userId, patch);
    if (text.length === 0) {
      // Deleting the runtime key lets any static config.yaml text show
      // through again — say so, rather than claiming nothing applies.
      const fromStatic = effective.instructions?.trim();
      return fromStatic
        ? `Cleared ${who} instructions. The static config text now applies:\n> ${fromStatic.replace(/\n/g, "\n> ")}`
        : `Cleared ${who} instructions.`;
    }
    return `Updated ${who} instructions (advisory prompt content — they never change agent, model, or permissions):\n> ${text.replace(/\n/g, "\n> ")}`;
  }

  const patch: Scope = {};
  for (const token of args.split(/\s+/).filter(Boolean)) {
    const kv = token.match(/^([\w.]+)=(\S+)$/);
    if (!kv) return `Couldn't parse \`${token}\`. Use \`key=value\`, e.g. \`agent=review\`.`;
    const [, key, value] = kv;
    if (key === "instructions") {
      return `\`instructions\` is free text and goes on its own: \`config set ${scopeName} instructions "<text>"\`. Set agent/model in a separate command.`;
    }
    if (key === "agent") {
      if (!AGENTS[value]) return `Unknown agent \`${value}\`. Available: ${Object.keys(AGENTS).join(", ")}`;
      patch.agent = value;
    } else if (key === "model") {
      patch.model = value;
    } else if (key.startsWith("models.")) {
      const agentName = key.slice("models.".length);
      if (!AGENTS[agentName]) return `Unknown agent \`${agentName}\` in \`${key}\`.`;
      patch.models = { ...patch.models, [agentName]: value };
    } else {
      return `Unknown key \`${key}\`. Valid: agent, model, models.<agent>, instructions`;
    }
  }
  if (Object.keys(patch).length === 0) return `Nothing to set. Example: \`config set channel agent=review\``;

  const effective =
    scopeName === "channel"
      ? config.setChannelOverride(msg.channelId, patch)
      : config.setUserOverride(msg.userId, patch);
  return `Updated ${who} scope. Now: ${JSON.stringify(summarizeScope(effective))}`;
}

/**
 * Scope as shown in k=v replies: instructions are elided to their length so a
 * 2000-char paragraph isn't echoed every time someone changes their model.
 */
function summarizeScope(s: Scope): Record<string, unknown> {
  const { instructions, ...rest } = s;
  return instructions === undefined ? rest : { ...rest, instructions: `<${instructions.length} chars>` };
}

/**
 * Strip one pair of wrapping quotes (straight or Slack smart quotes) — only
 * when they wrap the WHOLE text, i.e. the same quote character does not recur
 * inside. `"a" or "b"` is kept verbatim; `"Reply tersely."` becomes `Reply tersely.`.
 */
function unquote(raw: string): string {
  const s = raw.trim();
  const pairs: Array<[string, string]> = [['"', '"'], ["“", "”"], ["'", "'"], ["‘", "’"]];
  for (const [open, close] of pairs) {
    if (s.length < 2 || !s.startsWith(open) || !s.endsWith(close)) continue;
    const inner = s.slice(1, -1);
    if (inner.includes(open) || inner.includes(close)) return s;
    return inner.trim();
  }
  return s;
}

function helpText(): string {
  const agents = Object.values(AGENTS)
    .map((a) => `• \`${a.name}\` — ${a.description}`)
    .join("\n");
  return [
    "*Switchboard* — send me a request. Agents:",
    agents,
    "",
    "*Per-request directives* (anywhere in the message):",
    "`agent:review model:anthropic/claude-opus-5 look at PR #42`",
    "",
    "*Config commands:*",
    "`config show` — effective settings here",
    "`config set channel agent=review` — channel default agent",
    "`config set me model=openai/gpt-5` — your personal model",
    "`config set channel models.coding=anthropic/claude-opus-5` — per-agent model for this channel",
    '`config set me instructions "Always reply in bullet points"` — your custom instructions (advisory; apply only to runs you request; no value shows the current text, `""` clears)',
    '`config set channel instructions "This channel is about billing"` — channel-wide instructions (same gate as other channel config)',
    "`config clear channel` / `config clear me`",
    "",
    "*Repo commands* (resident environments; management verbs admin-gated):",
    "`repo list` — onboarded repos + lifecycle state",
    '`repo onboard <owner/name> [ref=<branch>] [test="<cmd>"] [build="<cmd>"] [install="<cmd>"]`',
    '`repo reconfigure <owner/name> [ref=…] [test="…"] [build="…"] [install="…"]`',
    "`repo offboard <owner/name> [--dry-run]` / `repo rebuild <owner/name> [--dry-run]`",
    "`repo test <owner/name> [<ref>]` / `repo build <owner/name> [<ref>]` — run the repo's onboarded command with no model turn (also: \"run the tests on <ref> in <owner/name>\")",
    "",
    "*Self-improvement* (friction across my own recent runs; `propose` is admin-gated):",
    "`friction report` — recurring friction patterns across recent runs",
    "`friction propose [--dry-run] [--top <n>] [--min-runs <n>]` — file the top patterns as labeled, deduped GitHub issues for a human to triage",
  ].join("\n");
}
