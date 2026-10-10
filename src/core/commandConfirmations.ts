import { hasAction, principalOf } from "./authz/authorize.js";
import { CONFIRM_ORDER, type ConfirmClass } from "../config/profile.js";
import type { ContextDependencies } from "./references/contextDependencies.js";
import { parseInput } from "./commandRegistry.js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  blastRadius,
  type Caller,
  type CommandDef,
  type CommandInput,
  type InvokeResult,
  type ParsedCommandInput,
} from "./commandRegistry.js";
import { STORE_UNREACHABLE_LINE, type ConfirmationStore, type RunConfirmation } from "./confirmations.js";
import type { ChannelIO, ConfirmationOffer, IncomingMessage } from "./types.js";
import { mintConfirmationOffer } from "./dispatch/route.js";
import { chatInvocation } from "./commandSurface.js";

/** Adapters supply verified identity and a display capability; commands own the policy. */
export interface CommandConfirmationContext {
  message: IncomingMessage;
  io: Pick<ChannelIO, "offer">;
  store?: ConfirmationStore;
  beforePublish?: () => Promise<void>;
  onExecute?: () => void;
  contextDependencies?: ContextDependencies;
}
export type ConfirmationRequiredResult = Extract<InvokeResult, { ok: false }> & { confirmation: ConfirmationOffer };
type InvocationContext = CommandConfirmationContext & { consumed?: { row: RunConfirmation; used: boolean } };
const invocation = new AsyncLocalStorage<InvocationContext>();

export function withCommandConfirmation<T>(context: CommandConfirmationContext, run: () => T): T {
  return invocation.run({ ...context, consumed: invocation.getStore()?.consumed }, run);
}

export function commandExecutionCaller(caller: Caller): Caller {
  const row = invocation.getStore()?.consumed?.row;
  if (!row) return caller;
  if (row.caller)
    return {
      ...caller,
      ...row.caller,
      origin: row.caller.origin ? { ...row.caller.origin, repo: async () => row.originRepo ?? undefined } : undefined,
    };
  return {
    ...caller,
    ...(row.message.approvalConnection
      ? { kind: "mcp" as const, id: row.message.authenticatedAs ?? caller.actor.id }
      : {}),
    ...(row.originRepo === undefined
      ? {}
      : {
          origin: {
            ...caller.origin,
            channelId: row.message.channelId,
            threadKey: row.message.threadKey,
            repo: async () => row.originRepo ?? undefined,
          },
        }),
  };
}

export function commandExecutionStarted(): void {
  invocation.getStore()?.onExecute?.();
}

export function commandConfirmationMessage(): IncomingMessage | undefined {
  return invocation.getStore()?.message;
}

/** Only the common click executor calls this, after atomic consumption of the saved row. */
export function withConsumedCommand<T>(row: RunConfirmation, run: () => T): T {
  const context = invocation.getStore();
  return invocation.run(
    { message: row.message, io: context?.io ?? {}, store: context?.store, consumed: { row, used: false } },
    run,
  );
}

export function normalizedCommandInput(
  def: Pick<CommandDef<unknown>, "args">,
  parsed: ParsedCommandInput,
): CommandInput {
  const args = (def.args ?? []).map((arg) => parsed.args[arg.name]);
  while (args.length && args.at(-1) === undefined) args.pop();
  return JSON.parse(JSON.stringify({ args, options: parsed.options })) as CommandInput;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a);
  const right = Object.keys(b);
  return (
    left.length === right.length &&
    left.every(
      (key) =>
        right.includes(key) && sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

/** The registry calls this after authorization and parsing, before every command handler. */
export async function commandConfirmationGate(
  def: CommandDef<unknown>,
  raw: CommandInput,
  parsed: ParsedCommandInput,
  caller: Caller,
  resolveClass: () => ConfirmClass | Promise<ConfirmClass>,
): Promise<InvokeResult | ConfirmationRequiredResult | undefined> {
  const context = invocation.getStore();
  const input = normalizedCommandInput(def, parsed);
  const permit = context?.consumed;
  const consumed = permit?.row;
  if (consumed) {
    const saved = parseInput(def, consumed.input);
    if (
      permit!.used ||
      consumed.command !== def.id ||
      caller.actor.id !== (consumed.message.postedBy ?? consumed.message.authenticatedAs ?? consumed.message.userId) ||
      !saved.ok ||
      !sameValue(consumed.parsedInput ?? normalizedCommandInput(def, saved), input) ||
      consumed.message.userId !== context!.message.userId ||
      consumed.message.authenticatedAs !== context!.message.authenticatedAs
    )
      return {
        ok: false,
        error: "unauthorized",
        status: 403,
        decidedBy: "registry",
        message: "The saved approval is used or does not match this action; nothing ran.",
      };
    permit!.used = true;
    return undefined;
  }
  const radius = blastRadius(def, parsed);
  if (def.annotations?.confirmation === "scoped" && radius !== "destructive") return undefined;
  if (def.annotations?.confirmation !== "always" && (radius === "read" || radius === "exec")) return undefined;
  const consent = principalOf(caller.actor).standingConsent;
  if (def.annotations?.confirmation !== "always" && consent && hasAction(consent, def.action)) return undefined;
  const confirm = await resolveClass();
  if (def.annotations?.confirmation !== "always" && CONFIRM_ORDER[radius] < CONFIRM_ORDER[confirm]) return undefined;
  const unavailable = {
    ok: false,
    error: "unavailable",
    status: 503,
    decidedBy: "registry",
    message: "This action requires verified human approval. This connection cannot show an approval; nothing ran.",
  } as const;
  if (!context?.io.offer || !context.store) return unavailable;
  await context.beforePublish?.();
  const originRepo = (await caller.origin?.repo?.()) ?? null;
  const rawArgs = [...(raw.args ?? [])];
  while (rawArgs.length && rawArgs.at(-1) === undefined) rawArgs.pop();
  const validatedInput = { args: rawArgs, options: raw.options ?? {} };
  const { repo: _repo, ...origin } = caller.origin ?? {};
  const args = {
    originRepo,
    parsedInput: input,
    caller: {
      kind: caller.kind,
      id: caller.id,
      ...(caller.email ? { email: caller.email } : {}),
      ...(caller.origin ? { origin: origin as Omit<NonNullable<Caller["origin"]>, "repo"> } : {}),
    },
    store: context.store,
    io: context.io as ChannelIO,
    msg: context.message,
    origin: caller.origin,
    def,
    input: validatedInput,
    receipt: chatInvocation(def, validatedInput),
    model: "",
  };
  const mint = context.contextDependencies
    ? await mintConfirmationOffer({ ...args, source: "operator", context: context.contextDependencies })
    : await mintConfirmationOffer(args);
  if (mint.kind !== "offered")
    return {
      ...unavailable,
      message:
        mint.kind === "store_unreachable"
          ? STORE_UNREACHABLE_LINE
          : mint.kind === "context_unavailable"
            ? "The saved source cannot be verified; nothing ran."
            : mint.kind === "unshowable"
              ? "The complete action cannot be shown safely for approval; nothing ran."
              : unavailable.message,
    };
  const shown = {
    ...mint.shown,
    risk: [mint.shown.risk, ...(originRepo ? [`Repository: ${originRepo}`] : [])].filter(Boolean).join("\n"),
  };
  let displayed: void | string;
  try {
    await context.beforePublish?.();
    displayed = await context.io.offer(shown);
  } catch (error) {
    await context.store
      .cancel(mint.shown.id, [context.message.userId], context.message.approvalConnection?.id)
      .catch(() => undefined);
    throw error;
  }
  return {
    ok: false,
    error: "conflict",
    status: 409,
    decidedBy: "registry",
    message:
      typeof displayed === "string"
        ? displayed
        : `Approval is pending; nothing ran.\n${mint.shown.line}${mint.shown.risk ? `\n${mint.shown.risk}` : ""}`,
    confirmation: shown,
  };
}
