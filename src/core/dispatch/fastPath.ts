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
import { COMMAND_RUN_AGENT } from "../runOwner.js";
import type { Clock } from "../trace/types.js";
import type { RequestTrace } from "../requestTrace.js";
import { recognizeOperation } from "../operations.js";
import { parseChatCommand, type ChatCommands, type ParsedChatCommand } from "../commandChat.js";
import type { RunRegistry } from "../runRegistry.js";
import type { RunEnding } from "../runEnding.js";
import type { ChannelIO, HistoryItem, IncomingMessage } from "../types.js";
import type { RecordDeps } from "./record.js";
import { replyCommandOutput } from "./reply.js";
// The command-run machinery both fast paths and the router's command branch
// share (commandRun.ts): invoked through the registry as the message's user,
// recorded as an inline run when the command does work.
import { postSettledOutcome, runChatCommand } from "./commandRun.js";

export { isInlineRunCommand } from "./commandRun.js";

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
   * The command registry bound to its deps (`bindCommands`; docs/decisions/0008-one-command-definition-every-surface.md), for the
   * chat fast path: `<group> <verb> [args…] [--option value…]` messages that
   * name a registered, chat-exposed command (and the bare word `help`) are
   * answered inline through `invoke`, never a model turn — this is EVERY
   * command (`help`, `config`, `memory`, `repo`, `friction`, `runs`,
   * `schedule`); the registry's adapter is the only chat parser. Absent (most unit tests,
   * or before the surface is wired) → no message is a command and every text
   * goes to the model. Every real process binds the one core catalogue through
   * `buildCoreCommands` (src/core/commandCatalogue.ts): the bot (src/index.ts)
   * and the CLI harness (src/cli.ts).
   */
  commands?: ChatCommands;
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

/** Stage A: true when the message was a chat command and has been answered (the
 *  dispatch is over), false when it is prose to hand on. The block inside says why. */
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

/** The natural-language fast path: true when an op form was recognized and its
 *  reply went out (the dispatch is over), false when the message was not an op
 *  or the op could not serve and the agent gets the ask. The block inside says why. */
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
