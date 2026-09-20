// The admission stage's fast path (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// what answers a message before any model turn. Stage A, the ONE fast path —
// a message that names a registered chat command is answered inline through
// the registry, and a command that does work is recorded as an inline run. It
// runs before the request is resolved; a message it does not answer goes on to
// thread admission (admission.ts). Nothing here reads prose: a natural
// sentence that means a command reaches it through the router's door
// (route.ts, the command menu), one model call away.
import type { ConfigStore } from "../../config.js";
import type { ResolveDeps } from "./resolve.js";
import { COMMAND_RUN_AGENT } from "../runOwner.js";
import type { Clock } from "../trace/types.js";
import type { RequestTrace } from "../requestTrace.js";
import { parseChatCommand, type ChatCommands } from "../commandChat.js";
import type { RunRegistry } from "../runRegistry.js";
import type { RunEnding } from "../runEnding.js";
import type { ConfirmationStore } from "../confirmations.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import type { RecordDeps } from "./record.js";
import { renderRefusal, replyCommandOutput } from "./reply.js";
import { commandRefusalCode, refusalOf, type Guess } from "../refusal.js";
// The command-run machinery the fast path and the router's command branch
// share (commandRun.ts): invoked through the registry as the message's user,
// recorded as an inline run when the command does work.
import { postSettledOutcome, runChatCommand, type OperatorEventFields } from "./commandRun.js";

export { isInlineRunCommand } from "./commandRun.js";

/** What the fast path reads off the dispatcher's dependencies. An inline
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
  /**
   * Where the confirmation a routed write is offered as lives (record 0044;
   * routing-and-config item 25): the config object's `confirmations` table in
   * production, a file or memory otherwise. The door mints a row here when the
   * channel can show an offer, and `dispatchClick` consumes it. Absent (most
   * unit tests, a process before the store is wired) → the door's refusal
   * names the store on a chat surface — the typed form on a typed one — and a
   * click answers that the confirmation could not be read.
   */
  confirmations?: ConfirmationStore;
}

/** What the fast path needs of the request: the message, its channel handle,
 *  the request's root trace and the run ending that seals a command run after
 *  its reply. */
export interface RequestContext {
  msg: IncomingMessage;
  io: ChannelIO;
  ending: RunEnding;
  trace: RequestTrace;
  /** The operator's shadow decision for this event (record 0057): written
   *  beside stage A's result on the inline run's record, never acted on. */
  operator?: OperatorEventFields;
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
  // so a recognized command costs no history fetch and the router is never
  // asked about it. ONE grammar for every command: config, memory, repo,
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
      const res = await runChatCommand(deps, msg, io, chatCmd, ending, trace, {
        ...(ctx.operator ? { operator: ctx.operator } : {}),
      });
      // A failed command that carries a guess is one question (record 0054):
      // `renderRefusal` offers Yes and No on channels with `offer`, or replies
      // the line to type on channels without one. The typed path has no receipt —
      // `renderRefusal` handles the full reply. The proposal is the original
      // message with its text replaced by the corrected line (the form `dispatch()`
      // would run on Yes — a typed command whose correction is the corrected line).
      const replyFn =
        !res.ok && res.guess && res.error
          ? () => {
              const hint = res.guess!;
              const guess: Guess = {
                proposal: { ...msg, text: hint.line },
                line: hint.line,
                evidence: hint.evidence,
              };
              return root.span("post.reply", () =>
                renderRefusal(refusalOf(commandRefusalCode(res.error!), res.text, { guess }), io, {
                  confirmations: deps.confirmations,
                }),
              );
            }
          : () => root.span("post.reply", () => replyCommandOutput(io, chatCmd, res.text));
      // The command run (if the command made one) seals after its reply.
      await ending.sealAfterReply(async () => {}, replyFn);
      if (res.followUp) postSettledOutcome(res.followUp, io, root);
      return true;
    }
  }
  return false;
}

/** The agent name an inline (no-model) command run carries in its `RunMeta` and
 *  record — the one value `runs list agent=command` selects on. */
export { COMMAND_RUN_AGENT };
