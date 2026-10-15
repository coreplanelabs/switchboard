import type { ChatCommandResult } from "../commandChat.js";
import { parseInput, type CommandInput } from "../commandRegistry.js";
import type { RequestTrace } from "../requestTrace.js";
import type { RunEnding } from "../runEnding.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import type { ContextDependencies } from "../references/contextDependencies.js";
import type { AudienceCheck } from "../audienceDecision.js";
import type { FastPathDeps } from "./fastPath.js";
import { runChatCommand, postSettledOutcome } from "./commandRun.js";
import { replyCommandOutput } from "./reply.js";
import { sourceHash } from "../references/receipts.js";
import {
  operatorEventOf,
  operatorTurnContext,
  bindRegistryCommand,
  prepareActionContext,
  renderOperatorQuestion,
  type ActionContextDeps,
  type OperatorEventFields,
} from "./operator.js";
import type { OrchestratorCommandDecision } from "./orchestratorDecisions.js";

/** Conversation tools invoke the same registry and approval gate as typed surfaces. */
export async function executeConversationCommand(
  deps: FastPathDeps & Pick<ActionContextDeps, "runLedger">,
  ctx: {
    msg: IncomingMessage;
    io: ChannelIO;
    trace: RequestTrace;
    ending: RunEnding;
    context: ContextDependencies;
    invocationId: string;
    check: (currentSource?: boolean) => Promise<AudienceCheck>;
    recordDecision: (decision: OrchestratorCommandDecision) => Promise<boolean>;
  },
  id: string,
  input: CommandInput,
): Promise<ChatCommandResult> {
  const unavailable = (): ChatCommandResult => ({
    ok: false,
    text: "Requester source access is unavailable; no command ran.",
  });
  if (!(await ctx.check()).ok || !ctx.trace.runId || !ctx.msg.messageId) return unavailable();
  const prepared = await prepareActionContext(
    { config: deps.config, commands: deps.commands, runLedger: deps.runLedger },
    { msg: ctx.msg },
  );
  const command = prepared.input.projection.commands.find((entry) => entry.id === id);
  if (!command) return { ok: false, text: "This command is unavailable." };
  // Validate both halves before joining names. An invalid option cannot hide
  // behind a positional argument with the same name.
  const validated = parseInput(command.def, input);
  if (!validated.ok) return { ok: false, text: validated.message };
  if (command.def.args?.some((arg) => Object.hasOwn(input.options ?? {}, arg.name)))
    return { ok: false, text: "This command has conflicting argument and option names." };
  const named: Record<string, unknown> = { ...input.options };
  command.def.args?.forEach((arg, index) => {
    const value = input.args?.[index];
    if (value !== undefined) named[arg.name] = value;
  });
  const parsed = bindRegistryCommand(command, named, operatorTurnContext(prepared.input), {
    intent: command.effect === "read" ? "read" : "write",
    reason: "Selected by the orchestrator",
  });
  if (parsed.kind !== "decision")
    return {
      ok: false,
      text: parsed.kind === "violation" ? parsed.violation : "The command proposal did not bind an action.",
    };
  if (parsed.decision.kind !== "binds")
    return {
      ok: false,
      text:
        parsed.decision.kind === "question"
          ? renderOperatorQuestion(parsed.decision)
          : "The command proposal did not bind an action.",
    };
  const invocation = parsed.decision.binds[0]?.invocation;
  if (!invocation || invocation.id !== id) return { ok: false, text: "The command proposal did not bind its target." };
  const event: OperatorEventFields = operatorEventOf("on", {
    decision: parsed.decision,
    latencyMs: 0,
    outputTokens: 0,
  });
  const decision: OrchestratorCommandDecision = {
    version: 1,
    id: ctx.invocationId,
    owner: {
      runId: ctx.trace.runId,
      requesterId: ctx.msg.userId,
      channelId: ctx.msg.channelId,
      threadKey: ctx.msg.threadKey,
    },
    source: { kind: "request", messageId: ctx.msg.messageId, textHash: await sourceHash(ctx.msg.text) },
    command: id,
    line: event.binds?.[0]?.line ?? "",
    inputHash: await sourceHash(invocation.input),
    contextHash: await sourceHash(ctx.context),
  };
  if (!(await ctx.check()).ok) return unavailable();
  if (!(await ctx.recordDecision(decision)))
    return { ok: false, text: "The command decision could not be saved; no command ran." };
  if (!(await ctx.check()).ok) return unavailable();
  event.orchestratorDecision = decision;
  const result = await runChatCommand(deps, ctx.msg, ctx.io, invocation, ctx.ending, ctx.trace, {
    operator: event,
    contextDependencies: ctx.context,
    invocationId: ctx.invocationId,
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
