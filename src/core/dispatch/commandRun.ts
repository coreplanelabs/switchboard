// A registry command run from the dispatcher, as a run (docs/decisions/0008-one-command-definition-every-surface.md;
// docs/reference/specs/command-registry.md item 18): the machinery the two fast
// paths and the request router's command branch share. A chat command — typed
// as `<group> <verb> …` (stage A), translated from a conservative op form, or
// bound from prose by the router (record 0036, unit 2) — is invoked through the
// registry as the message's user; the commands that do work are recorded as
// inline runs (`runInlineCommandRun`), the rest answer log-only. One path, one
// record shape, whichever door the command came through: the router's door
// adds the `route` event to the run and `source: route` to the audit line and
// changes nothing else here. A door decision about a state change (record
// 0044) is a record too: a hand-back is written by `recordRoutedDecision`,
// which invokes nothing and tells no surface of the run, and the paste that
// follows it is recorded by `runChatCommand` because its route carries an
// outcome — whatever the command, announced to no surface unless the command
// was a run anyway.
import { systemClock } from "../trace/index.js";
import { COMMAND_RUN_AGENT, DOOR_RUN_AGENT } from "../runOwner.js";
import type { Span } from "../trace/types.js";
import type { RequestTrace } from "../requestTrace.js";
import { graftResidentSteps, sanitizeGraftedSteps } from "../../execution/residentTrace.js";
import { residentOnboardedProbe, residentSlugsLister } from "../../execution/factory.js";
import { resolveRepoContext, type RepoContext } from "../repoContext.js";
import { redactAndCap, redactSecrets, type RunEvent } from "../runEvents.js";
import { refusalLine, type Refusal } from "../refusal.js";
import { ROUTE_RECEIPT_CAP } from "./route.js";
import type { RunStatus } from "../runRecord.js";
import { analyzeRunFriction } from "../runFriction.js";
import { invokeChatCommand, type ChatCommandResult, type ParsedChatCommand } from "../commandChat.js";
import type { CommandDef } from "../commandRegistry.js";
import { cliWords } from "../commandSurface.js";
import { defaultRunRegistry } from "../runRegistry.js";
import type { RunEnding } from "../runEnding.js";
import { messageIdOf, type ChannelIO, type HistoryItem, type IncomingMessage } from "../types.js";
import { assembleRunRecord, channelVisibilityOf } from "./record.js";
import { composeRunLabel, errorReply } from "./reply.js";
import type { FastPathDeps } from "./fastPath.js";

/** The `route` event a command the router bound rides its run with
 *  (docs/reference/specs/run-history.md item 2): published right after `run_meta`. */
export type RouteEventFields = Omit<Extract<RunEvent, { type: "route" }>, "type" | "seq" | "at">;

/** What a command run may carry beyond the command: the router's decision, when
 *  the command came through its door, and the door's mark for the audit line —
 *  `route` for a command the router bound and ran, `confirm` for a stored
 *  input run at a confirmation's click (record 0044). */
export interface CommandRunOptions {
  route?: RouteEventFields;
  source?: "route" | "confirm";
}

/** `runInlineCommandRun`'s options: the command's, plus whether the channel is
 *  told of the run. Default true — `runStarted` as the run is created,
 *  `runFinished` before the reply — the signals the HTTP ingress and the web
 *  chat key their reply shape on (a run id, or the reply text). `false` writes
 *  the record and says nothing: a hand-back, or the paste of a command that was
 *  never a run, is answered exactly as it was before it was recorded. */
export interface InlineRunOptions extends CommandRunOptions {
  announce?: boolean;
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
    /^mcp\.(add|connect|remove|promote)$/.test(id)
  );
}

/**
 * Answer one parsed chat command through the registry as the message's user:
 * the caller carries the message's channel + thread as its `origin`, and a LAZY
 * repo resolver (history + the production repo resolver) for the commands that
 * ask for the thread's bound repo (`memory list` with the repo scope) — paid
 * only when asked. Commands that do work (`isInlineRunCommand`) are recorded as
 * inline runs, and so is any command whose route carries an outcome — the
 * paste of a hand-back (record 0044), recorded whatever its id and announced
 * to the channel only when the command was a run anyway; help/usage replies
 * and every other read-only answer are not.
 */
export async function runChatCommand(
  deps: FastPathDeps,
  msg: IncomingMessage,
  io: ChannelIO,
  parsed: ParsedChatCommand,
  ending: RunEnding,
  trace: RequestTrace,
  opts: CommandRunOptions = {},
): Promise<ChatCommandResult> {
  const commands = deps.commands;
  if (!commands) return { ok: false, text: "" };
  const resolveRepo = async (): Promise<string | undefined> =>
    (await resolveRepoForCommand(deps, msg, await io.history())).repo;
  const invoke = (span: Span) =>
    invokeChatCommand({
      commands,
      parsed,
      msg,
      config: deps.config,
      resolveRepo,
      span,
      ...(opts.source ? { source: opts.source } : {}),
    });
  if (parsed.kind === "invoke") {
    const inline = isInlineRunCommand(parsed.id);
    if (inline || opts.route?.outcome !== undefined)
      return runInlineCommandRun(deps, msg, cliWords(parsed.id)[0], io, invoke, ending, trace, {
        ...opts,
        announce: inline,
      });
  }
  // A config reply, a listing, `help`: no run — the command's own work is the
  // request's one step, log-only.
  return trace.root.span("run.command", invoke, { attrs: { command: parsed.kind === "invoke" ? parsed.id : "help" } });
}

/**
 * A door decision about a state change as a run record (record 0044): the
 * router bound a command the door does not run from prose, and the reply is
 * the line to paste. The record is an inline command run with nothing invoked
 * — `execute` answers the line and never reaches the registry — so it carries
 * the same `input`, `run_meta`, `route` and `answer` a routed read's does and
 * seals `completed`; the `route` event's `outcome` says what the door did. No
 * surface is told of the run (`announce: false`): the hand-back is answered by
 * the web chat and the HTTP ingress exactly as before it was counted.
 */
export async function recordRoutedDecision(
  deps: FastPathDeps,
  msg: IncomingMessage,
  io: ChannelIO,
  def: Pick<CommandDef<unknown>, "id">,
  route: RouteEventFields,
  text: string,
  ending: RunEnding,
  trace: RequestTrace,
): Promise<void> {
  await runInlineCommandRun(deps, msg, cliWords(def.id)[0], io, async () => ({ ok: true, text }), ending, trace, {
    route,
    announce: false,
  });
}

/**
 * A refusal as a run record (record 0054, as amended: every refusal the door
 * makes is a run record, a gate refusal before any command is bound and before
 * admission included). Written beside the rendered sentence and telling no
 * surface of the run — like a hand-back's record — so the reply the person
 * reads is exactly what it was: agent `door`, the refusal's code as the
 * label's lead, status `completed`, no `runStarted`/`runFinished` signal, no
 * thread claim; the redacted request is its `input` event and one `refusal`
 * event carries the code, the cause and the redacted sentence capped like a
 * receipt (`ROUTE_RECEIPT_CAP`). A message without a thread of its own records
 * with the channel as its thread key. The door report counts these records
 * with the refused route outcomes, so refusals per day, cause and code read
 * off the run store alone.
 */
export async function recordRefusal(
  deps: FastPathDeps,
  msg: IncomingMessage,
  _io: ChannelIO,
  refusal: Refusal,
  ending: RunEnding,
  trace: RequestTrace,
): Promise<void> {
  const registry = deps.runRegistry ?? defaultRunRegistry;
  const root = trace.root;
  const clock = deps.clock ?? systemClock;
  const threadKey = msg.threadKey || msg.channelId;
  // No span of its own: the caller records inside its `dispatch.refuse` span.
  const channelVisibility = await channelVisibilityOf(deps, msg.channelId);
  const run = registry.create(
    composeRunLabel({
      agent: refusal.code,
      channelId: msg.channelId,
      userId: msg.userId,
      channelName: msg.channelName,
      userName: msg.userName,
      text: msg.text,
    }),
    {
      agent: DOOR_RUN_AGENT,
      channelId: msg.channelId,
      userId: msg.userId,
      threadKey,
      channelVisibility,
      receivedAt: trace.receivedAt,
      ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
      ...(msg.authenticatedAs !== undefined ? { authenticatedAs: msg.authenticatedAs } : {}),
    },
  );
  registry.publish(run.id, {
    type: "input",
    text: redactSecrets(msg.text),
    messageId: messageIdOf(msg, run.id),
    at: clock(),
  });
  registry.publish(run.id, {
    type: "refusal",
    code: refusal.code,
    cause: refusal.cause,
    text: redactAndCap(refusalLine(refusal), ROUTE_RECEIPT_CAP),
    at: clock(),
  });
  // The door said no and said it cleanly: the record's status is `completed` —
  // `failed` is for a command whose own work broke — and the refusal event
  // says what was refused.
  const status: RunStatus = "completed";
  registry.finish(run.id, status);
  ending.finished(run.id);
  const snap = registry.snapshot(run.id, run.token);
  const finishedAt = snap?.finishedAt ?? clock();
  const diagnosis = analyzeRunFriction(snap?.events ?? [], {
    finished: true,
    truncated: snap?.truncated ?? false,
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
          agent: DOOR_RUN_AGENT,
          msg: { ...msg, threadKey },
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

/**
 * A command with a deferred outcome (`CommandDef.settle` — `repo onboard` /
 * `repo rebuild`, whose provisioning settles minutes after the 202) gets a
 * SECOND reply in the thread when it does: awaited off the request path, so the
 * acknowledgement is never held back. Best-effort by design — the poll lives in
 * this process, so a restart mid-provision loses the follow-up; the resident
 * state itself is never in doubt (`repo list` / the residents dash read it
 * live), and the acknowledgement says so.
 */
export function postSettledOutcome(
  followUp: () => Promise<{ text: string } | undefined>,
  io: ChannelIO,
  root: Span,
): void {
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
 * handler. `announce: false` keeps `runStarted` and `runFinished` from the
 * channel: the record is written, the surface answers as if no run existed.
 */
export async function runInlineCommandRun<
  T extends { text: string; ok: boolean; trace?: unknown; residentMs?: number },
>(
  deps: FastPathDeps,
  msg: IncomingMessage,
  command: string,
  io: ChannelIO,
  execute: (span: Span) => Promise<T>,
  ending: RunEnding,
  trace: RequestTrace,
  opts: InlineRunOptions = {},
): Promise<T> {
  const registry = deps.runRegistry ?? defaultRunRegistry;
  const root = trace.root;
  const clock = deps.clock ?? systemClock;
  const announce = opts.announce ?? true;
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
      ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
      ...(msg.authenticatedAs !== undefined ? { authenticatedAs: msg.authenticatedAs } : {}),
    },
  );
  // The command run rides the request's trace like an agent run: the setup
  // spans so far backfill, then `run.command` and the reply follow live. A
  // natural-language fall-through rebinds the same root to the agent run next.
  trace.bindRun(run.id, (e) => registry.publish(run.id, e));
  if (announce) io.runStarted?.({ id: run.id });
  registry.publish(run.id, {
    type: "input",
    text: redactSecrets(msg.text),
    messageId: messageIdOf(msg, run.id),
    at: clock(),
  });
  // A command run's meta names no model (docs/reference/specs/tracing.md): the agent and the trace.
  registry.publish(run.id, { type: "run_meta", agent: COMMAND_RUN_AGENT, traceId: root.traceId, at: clock() });
  // A command the router bound rides its run with the decision (record 0036,
  // unit 2; run-history item 2): the command, the bound input, the receipt the
  // reply led with — redacted and capped by the caller — right after `run_meta`,
  // where a routed agent run carries the same event.
  if (opts.route) registry.publish(run.id, { type: "route", ...opts.route, at: clock() });
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
    if (announce) io.runFinished?.({ id: run.id, status });
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
export async function resolveRepoForCommand(
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
