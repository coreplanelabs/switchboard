// The admission stage's fast paths (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// what answers a message before any model turn. Stage A — a message that names
// a registered chat command is answered inline through the registry, and a
// command that does work is recorded as an inline run; then the natural-
// language op translation, which turns the few conservative op forms into the
// registry command they name. Both run before the request is resolved; a
// message neither answers goes on to thread admission (admission.ts).
import type { ConfigStore } from "../../config.js";
import type { ResolveDeps } from "./resolve.js";
import type { RequestDirectives } from "../../directives.js";
import { systemClock } from "../trace/index.js";
import { COMMAND_RUN_AGENT } from "../runOwner.js";
import type { Clock, Span } from "../trace/types.js";
import type { RequestTrace } from "../requestTrace.js";
import { graftResidentSteps, sanitizeGraftedSteps } from "../../execution/residentTrace.js";
import { SPAN_SCHEMA } from "../normalizeSpans.js";
import { residentOnboardedProbe, residentSlugsLister } from "../../execution/factory.js";
import { resolveRepoContext, type RepoContext } from "../repoContext.js";
import { recognizeOperation } from "../operations.js";
import { redactSecrets } from "../runEvents.js";
import type { RunStatus } from "../runRecord.js";
import type { RunHistoryWriter } from "../runHistoryWriter.js";
import { analyzeRunFriction } from "../runFriction.js";
import {
  invokeChatCommand,
  parseChatCommand,
  type ChatCommandResult,
  type ChatCommands,
  type ParsedChatCommand,
} from "../commandChat.js";
import { cliWords } from "../commandSurface.js";
import { defaultRunRegistry, type RunRegistry } from "../runRegistry.js";
import type { RunEnding } from "../runEnding.js";
import type { ChannelIO, HistoryItem, IncomingMessage } from "../types.js";
import { assembleRunRecord, channelVisibilityOf, type RecordDeps } from "./record.js";
import { composeRunLabel, errorReply, replyCommandOutput } from "./reply.js";

/** What the fast paths read off the dispatcher's dependencies. An inline
 *  command run is recorded like any run, so the record stage's slice comes
 *  with it. `CoreDeps` extends this; a caller's shape is unchanged. */
export interface FastPathDeps extends RecordDeps, Pick<ResolveDeps, "resolveRepoContext"> {
  config: ConfigStore;
  /** The wall clock (docs/reference/specs/tracing.md): `systemClock` in production, a ticking clock in tests. */
  clock?: Clock;
  /**
   * Live run-view registry: every run is registered here and its
   * events published so the external /runs page can stream them. Optional;
   * defaults to the process-wide singleton so the dispatcher and the served
   * /runs endpoints (src/index.ts) share one instance. Injectable for tests.
   */
  runRegistry?: RunRegistry;
  /**
   * The write path onto `runStore` (docs/decisions/0006-runs-have-two-lives.md): after every run the dispatcher
   * builds the `RunRecord` at finish and hands it here AFTER the reply is sent —
   * fire-and-forget with bounded retries, drain-counted via `pending()`. With
   * history off it is the `NullRunHistoryWriter` — every write dropped —
   * so the dispatcher never asks whether there is one. Production wires
   * `createRunHistoryWriter` over the selected store (src/index.ts, src/cli.ts).
   */
  runHistoryWriter: RunHistoryWriter;
  /**
   * The command registry bound to its deps (`bindCommands`; docs/decisions/0008-one-command-definition-every-surface.md), for the
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

/** Registry commands the dispatcher records as inline runs: the ones
 *  that DO work beyond answering from local state — ledger reads and GitHub
 *  writes (`friction.*`), a durable memory mutation (`memory.forget`), a repo
 *  provisioned/torn down/reprovisioned (`repo.onboard|offboard|rebuild|
 *  reconfigure`), a deterministic op executed (`repo.test|build`). Config
 *  replies, `help`, listings, and usage/help replies are not runs. */
export function isInlineRunCommand(id: string): boolean {
  return (
    id.startsWith("friction.") ||
    id === "memory.forget" ||
    /^repo\.(onboard|offboard|rebuild|reconfigure|test|build)$/.test(id) ||
    /^mcp\.(add|connect|remove)$/.test(id)
  );
}

/** What the two fast paths need of the request: the message, its channel
 *  handle, the request's root trace and the run ending that seals a command
 *  run after its reply. */
export interface RequestContext {
  msg: IncomingMessage;
  io: ChannelIO;
  ending: RunEnding;
  trace: RequestTrace;
}

/**
 * Stage A — the one text-only fast path. A message that names a registered,
 * chat-exposed command is answered inline through the registry, never a model
 * turn, BEFORE the history fetch; true when the message was a command and has
 * been answered (the dispatch is over), false when it is prose to hand on.
 */
export async function answerChatCommand(deps: FastPathDeps, ctx: RequestContext): Promise<boolean> {
  const { msg, io, ending, trace } = ctx;
  const root = trace.root;
  // Stage A — the ONE text-only fast path: a
  // message that names a registered, chat-exposed command (`<group> <verb>
  // [args…] [--kebab-flag value…]`, or the bare word `help`) is answered
  // inline through the registry — never a model turn — BEFORE `io.history()`,
  // so a recognized command costs no history fetch and the natural-language
  // recognizer below never sees it (the two can never both claim one
  // message). ONE grammar for every command: config, memory, repo,
  // friction, runs, schedule, help. Prose falls through unchanged.
  //
  // Commands that DO real work — ledger reads and GitHub writes (`friction.*`),
  // a durable memory mutation, a repo provisioned or torn down, a
  // deterministic op executed — are runs: a registry record with the
  // request and the reply, on /runs like any other, and a receipt to the
  // channel. The weekly cron reaches this path through /ingress as
  // `http:cron`, so a scheduled firing is a run too. The outcome comes from
  // the command's `ok`, never from the reply text. Config replies, `help`,
  // listings, and usage/help replies are answered directly, no run.
  if (deps.commands) {
    const chatCmd = parseChatCommand(msg.text, deps.commands);
    if (chatCmd) {
      const res = await runChatCommand(deps, msg, io, chatCmd, ending, trace);
      // The command run (if the command made one) seals after its reply.
      await ending.sealAfterReply(
        async () => {},
        () => root.span("post.reply", () => replyCommandOutput(io, chatCmd, res.text)),
      );
      if (res.followUp) postSettledOutcome(res.followUp, io, root);
      return true;
    }
  }
  return false;
}

/**
 * The natural-language fast path: a conservative op form ("run the tests on
 * main in acme/api") is translated into the registry command it names and
 * answered like one; true when the reply went out (the dispatch is over), false
 * when the message was not an op — or the op could not serve (`not_found`,
 * `unavailable`) and the agent gets the ask, with the command run already
 * sealed as this dispatch's first run.
 */
export async function answerOperation(
  deps: FastPathDeps,
  ctx: RequestContext & { directives: RequestDirectives; history: HistoryItem[] },
): Promise<boolean> {
  const { msg, io, ending, trace, directives, history } = ctx;
  const root = trace.root;
  // Natural-language deterministic ops: the few conservative forms
  // `recognizeOperation` admits ("run the tests on main in acme/api") are
  // TRANSLATED into the registry's `repo.test` / `repo.build` — the very
  // command `repo test acme/api main` is — so one handler executes, one gate
  // sequence applies (the policy table on `agent { coding }` — the right to run
  // the implicit target agent; canUseRepo inside), and zero model turns are
  // spent. Natural language is an accelerator, not a promise: when the op
  // cannot serve (`not_found` — the repo has no resident; `unavailable` — no
  // backend or a backend failure) the agent still gets the ask, while a
  // refusal or a result is the reply. An explicit agent:/model: directive
  // disables recognition — the user picked a model path.
  const opAsk = deps.commands
    ? recognizeOperation(msg.text, history, { allowNatural: !directives.agent && !directives.model })
    : null;
  if (opAsk) {
    const translated: ParsedChatCommand = {
      kind: "invoke",
      id: `repo.${opAsk.op}`,
      input: { args: [opAsk.repo, opAsk.ref], options: {} },
    };
    const res = await runChatCommand(deps, msg, io, translated, ending, trace);
    if (!(res.error === "not_found" || res.error === "unavailable")) {
      await ending.sealAfterReply(
        async () => {},
        () => root.span("post.reply", () => io.reply(res.text)),
      );
      return true;
    }
    // A fall-through: the command run answered nothing the agent will not; it
    // is sealed now with no reply attempted, and the agent run below is a
    // second run in this dispatch.
    await ending.sealAfterReply(async () => {});
  }
  return false;
}

/** The agent name an inline (no-model) command run carries in its `RunMeta` and
 *  record — the one value `runs list agent=command` selects on. */
export { COMMAND_RUN_AGENT };

/**
 * Answer one parsed chat command through the registry as the message's user:
 * the caller carries the message's channel + thread as its `origin`, and a LAZY
 * repo resolver (history + the production repo resolver) for the commands that
 * ask for the thread's bound repo (`memory list` with the repo scope) — paid
 * only when asked. Commands that do work (`isInlineRunCommand`) are recorded as
 * inline runs; help/usage replies and read-only answers are not.
 */
async function runChatCommand(
  deps: FastPathDeps,
  msg: IncomingMessage,
  io: ChannelIO,
  parsed: ParsedChatCommand,
  ending: RunEnding,
  trace: RequestTrace,
): Promise<ChatCommandResult> {
  const commands = deps.commands;
  if (!commands) return { ok: false, text: "" };
  const resolveRepo = async (): Promise<string | undefined> =>
    (await resolveRepoForCommand(deps, msg, await io.history())).repo;
  const invoke = (span: Span) => invokeChatCommand({ commands, parsed, msg, config: deps.config, resolveRepo, span });
  if (parsed.kind === "invoke" && isInlineRunCommand(parsed.id))
    return runInlineCommandRun(deps, msg, cliWords(parsed.id)[0], io, invoke, ending, trace);
  // A config reply, a listing, `help`: no run — the command's own work is the
  // request's one step, log-only.
  return trace.root.span("run.command", invoke, { attrs: { command: parsed.kind === "invoke" ? parsed.id : "help" } });
}

/**
 * A command with a deferred outcome (`CommandDef.settle` — `repo onboard` /
 * `repo rebuild`, whose provisioning settles minutes after the 202) gets a
 * SECOND reply in the thread when it does: awaited off the request path, so the
 * acknowledgement is never held back. Best-effort by design — the poll lives in
 * this process, so a restart mid-provision loses the follow-up; the resident
 * state itself is never in doubt (`repo list` / the residents dash read it
 * live), and the acknowledgement says so.
 */
function postSettledOutcome(followUp: () => Promise<{ text: string } | undefined>, io: ChannelIO, root: Span): void {
  // Minutes after the request ended: a late child of its root, log-only.
  void root
    .span("post.settled_outcome", () => followUp().then((outcome) => (outcome ? io.reply(outcome.text) : undefined)))
    .catch((err) => console.error("[command] settle follow-up failed:", err));
}

/**
 * Run an inline (no-model) command AS a run: register it in the run
 * registry under a `<command> · #channel · user · "…"` label with the caller's
 * identity as its `RunMeta` (agent `command`), publish the request as the
 * `input` event and the reply as the `answer` event, finish it with its status,
 * hand the channel its receipt — `completed` when the command did its work,
 * `failed` when it was refused, misconfigured, or threw — and persist it through
 * the same `runHistoryWriter` path as an agent run, so a scheduled firing
 * outlives the registry TTL. The run record is the canonical trace
 * (docs/decisions/0008-one-command-definition-every-surface.md); the channel reply is a projection of it.
 * A thrown command still finishes its run (as `failed`, with the `⚠️ <error>`
 * reply as its `answer`) and the error propagates to the dispatcher's outer
 * handler.
 */
async function runInlineCommandRun<T extends { text: string; ok: boolean; trace?: unknown; residentMs?: number }>(
  deps: FastPathDeps,
  msg: IncomingMessage,
  command: string,
  io: ChannelIO,
  execute: (span: Span) => Promise<T>,
  ending: RunEnding,
  trace: RequestTrace,
): Promise<T> {
  const registry = deps.runRegistry ?? defaultRunRegistry;
  const root = trace.root;
  const clock = deps.clock ?? systemClock;
  const channelVisibility = await root.span("dispatch.channel_visibility", () =>
    channelVisibilityOf(deps, msg.channelId),
  );
  const run = registry.create(
    composeRunLabel({
      agent: command,
      channelId: msg.channelId,
      userId: msg.userId,
      channelName: msg.channelName,
      userName: msg.userName,
      text: msg.text,
    }),
    {
      agent: COMMAND_RUN_AGENT,
      channelId: msg.channelId,
      userId: msg.userId,
      threadKey: msg.threadKey,
      channelVisibility,
      receivedAt: trace.receivedAt,
    },
  );
  // The command run rides the request's trace like an agent run: the setup
  // spans so far backfill, then `run.command` and the reply follow live. A
  // natural-language fall-through rebinds the same root to the agent run next.
  trace.bindRun(run.id, (e) => registry.publish(run.id, e));
  io.runStarted?.({ id: run.id });
  registry.publish(run.id, { type: "input", text: redactSecrets(msg.text), at: clock() });
  // A command run's meta names no model (docs/reference/specs/tracing.md): the agent and the trace.
  registry.publish(run.id, { type: "run_meta", agent: COMMAND_RUN_AGENT, traceId: root.traceId, at: clock() });
  let result: T | undefined;
  try {
    // The command's deterministic body is the run's one counted step (`tools`
    // for a command run); a resident op's own steps graft under it.
    result = await root.span(
      "run.command",
      async (span) => {
        const r = await execute(span);
        const steps = sanitizeGraftedSteps(r.trace);
        if (steps.length > 0)
          graftResidentSteps(steps, {
            parent: span,
            prefix: "run.command",
            baseAt: span.record().startedAt,
            clipAt: clock(),
            ...(r.residentMs !== undefined ? { residentTotalMs: r.residentMs } : {}),
          });
        return r;
      },
      { attrs: { command } },
    );
    registry.publish(run.id, { type: "answer", text: redactSecrets(result.text), at: clock() });
    return result;
  } catch (err) {
    // A thrown command still gets an `answer`: the same `⚠️ <error>` line the
    // dispatcher's outer handler replies with, so the record explains its
    // `failed` status and the channel reply stays a projection of it.
    registry.publish(run.id, { type: "answer", text: redactSecrets(errorReply(err)), at: clock() });
    throw err;
  } finally {
    const status: RunStatus = result?.ok ? "completed" : "failed";
    registry.finish(run.id, status);
    io.runFinished?.({ id: run.id, status });
    // Sealed by the caller's drain after its reply (or at once, with no reply,
    // when the command fell through to the agent); the record is written then.
    // A command's status is its own `ok` — a reply that throws never flips it.
    ending.finished(run.id);
    const snap = registry.snapshot(run.id, run.token);
    const finishedAt = snap?.finishedAt ?? clock();
    // A command run owns its window's tools: `run.command` is the work.
    const diagnosis = analyzeRunFriction(snap?.events ?? [], {
      finished: true,
      truncated: snap?.truncated ?? false,
      schema: SPAN_SCHEMA,
      owner: "command",
      window: { start: trace.receivedAt, end: finishedAt },
    });
    ending.register({
      runId: run.id,
      flipOnPostFinishFailure: false,
      write: (seal) =>
        deps.runHistoryWriter.write(
          assembleRunRecord({
            run,
            snap,
            agent: COMMAND_RUN_AGENT,
            msg,
            channelVisibility,
            finishedAt,
            status,
            diagnosis,
            seal,
          }),
          { span: root },
        ),
    });
  }
}

/** Repo resolution for a chat command that asks for the thread's bound repo
 *  (`Caller.origin.repo`, e.g. `memory list` with the repo scope): the
 *  injected resolver in tests, the production resolver (registry-vetted slugs,
 *  PR → repo) otherwise; a failure means "no repo bound", never an error reply. */
async function resolveRepoForCommand(
  deps: FastPathDeps,
  msg: IncomingMessage,
  history: HistoryItem[],
): Promise<RepoContext> {
  try {
    return (
      (await (deps.resolveRepoContext
        ? deps.resolveRepoContext(msg, history)
        : resolveRepoContext(
            msg,
            history,
            residentOnboardedProbe(deps.config.config.execution?.resident),
            residentSlugsLister(deps.config.config.execution?.resident),
          ))) ?? {}
    );
  } catch {
    return {};
  }
}
