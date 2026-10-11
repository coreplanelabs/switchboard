import type { ChatCommandResult } from "../commandChat.js";
import type { CommandInput } from "../commandRegistry.js";
import type { RequestTrace } from "../requestTrace.js";
import type { RunEnding } from "../runEnding.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import type { ContextDependencies } from "../references/contextDependencies.js";
import type { AudienceCheck } from "../audienceDecision.js";
import type { FastPathDeps } from "./fastPath.js";
import { runChatCommand, postSettledOutcome } from "./commandRun.js";
import { replyCommandOutput } from "./reply.js";

/** Conversation tools invoke the same registry and approval gate as typed surfaces. */
export async function executeConversationCommand(
  deps: FastPathDeps,
  ctx: {
    msg: IncomingMessage;
    io: ChannelIO;
    trace: RequestTrace;
    ending: RunEnding;
    context: ContextDependencies;
    check: (currentSource?: boolean) => Promise<AudienceCheck>;
  },
  id: string,
  input: CommandInput,
): Promise<ChatCommandResult> {
  const invocation = { kind: "invoke" as const, id, input };
  const result = await runChatCommand(deps, ctx.msg, ctx.io, invocation, ctx.ending, ctx.trace, {
    contextDependencies: ctx.context,
    parentRunId: ctx.trace.runId,
    beforeExecute: async () => {
      if (!(await ctx.check()).ok) throw new Error("The requester's source access could not be verified.");
    },
    beforePublish: async () => {
      if (!(await ctx.check(false)).ok) throw new Error("The requester's source access could not be verified.");
    },
    source: "route",
  });
  if (result.confirmation) return { ok: true, text: JSON.stringify({ command: id, outcome: "approval_pending" }) };
  const verbosity = deps.config.verbosityFor(ctx.msg.channelId, ctx.msg.userId);
  if (!(await ctx.check(false)).ok) throw new Error("The requester's source access could not be verified.");
  await replyCommandOutput(ctx.io, invocation, result.text, {
    verbosity,
    ok: result.ok,
    quietText: result.quietText,
    cardShown: result.cardShown,
  });
  if (result.followUp) {
    postSettledOutcome(
      async () => {
        const settled = await result.followUp!();
        if (!(await ctx.check(false)).ok) throw new Error("The requester's source access could not be verified.");
        return settled;
      },
      ctx.io,
      ctx.trace.root,
    );
    return { ok: result.ok, text: JSON.stringify({ command: id, outcome: "submitted", resultDelivered: true }) };
  }
  // A command can return private source data without a durable read receipt.
  // Its native result reaches the requester, never the model's reusable log.
  return {
    ok: result.ok,
    text: JSON.stringify({ command: id, outcome: result.ok ? "ran" : "refused", resultDelivered: true }),
  };
}
