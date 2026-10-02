import type { AudienceCheck } from "../audienceDecision.js";
import {
  contextDependenciesOf,
  isContextDependencies,
  mergeContextDependencies,
  type ContextDependencies,
} from "../references/contextDependencies.js";
import type { RunLedger } from "../runLedger/ledger.js";
import { contextThreadSessionKey } from "../runLedger/sessionLog.js";
import type { RunView } from "../runsService.js";
import type { IncomingMessage } from "../types.js";
import { freshContext } from "./contextSeed.js";
import { OPERATOR_TAIL_BYTES, operatorTail, type OperatorTailTurn } from "./seed.js";

export interface OperatorTailContext {
  turns: readonly OperatorTailTurn[];
  context?: ContextDependencies;
  unavailable: readonly string[];
}

/** Capture history before its cumulative source metadata. Only the current
 * request's admitted canonical sessions may supply a migration fallback. */
export async function readOperatorTailContext(input: {
  ledger: Pick<RunLedger, "readSessionTail">;
  runs: readonly Pick<RunView, "id" | "userId" | "channelId" | "threadKey" | "session">[];
  msg: IncomingMessage;
  validateDependencies(context: ContextDependencies): Promise<AudienceCheck>;
  normalizeDependencies?(
    contexts: readonly ContextDependencies[],
    candidates: readonly ContextDependencies[],
  ): Promise<ContextDependencies[]>;
}): Promise<OperatorTailContext> {
  const unavailable: string[] = [];
  const contexts: ContextDependencies[] = [freshContext()];
  const candidates: ContextDependencies[] = [];
  const read = async (key: string) => {
    try {
      const snapshot = structuredClone(await input.ledger.readSessionTail(key, OPERATOR_TAIL_BYTES));
      if (!snapshot.transcript.messages.length) return { empty: true, turns: [] };
      const metadata = await input.ledger.readSessionTail(key, 1);
      const sources = metadata.sources;
      if (isContextDependencies(sources?.context)) candidates.push(sources.context);
      const shared = key === contextThreadSessionKey(input.msg.threadKey);
      const legacy = shared
        ? undefined
        : mergeContextDependencies(structuredClone(contextDependenciesOf(sources)), {
            ...freshContext(),
            origins: input.runs
              .filter(
                (run) =>
                  run.session?.key === key &&
                  run.channelId === input.msg.channelId &&
                  run.threadKey === input.msg.threadKey,
              )
              .flatMap((run) =>
                run.userId && run.channelId && run.threadKey
                  ? [{ runId: run.id, requester: run.userId, channelId: run.channelId, threadKey: run.threadKey }]
                  : [],
              ),
          });
      const rowContexts = snapshot.transcript.messages.map((_, i) =>
        shared ? snapshot.transcript.contexts?.[i] : legacy,
      );
      if (input.normalizeDependencies) {
        const known = rowContexts.flatMap((context, i) =>
          isContextDependencies(context) && context.status === "known" ? [{ context, i }] : [],
        );
        if (known.length) {
          const normalized = await input.normalizeDependencies(
            known.map(({ context }) => context),
            candidates,
          );
          if (normalized.length !== known.length) throw new Error("saved-context-unproved");
          for (const [index, { i }] of known.entries()) rowContexts[i] = normalized[index];
        }
      }
      const checks = new Map<string, Promise<AudienceCheck>>();
      const turns: OperatorTailTurn[] = [];
      let omitted = false;
      for (const [i, message] of snapshot.transcript.messages.entries()) {
        const text = message.content
          .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
          .join(" ")
          .trim();
        if (!text) continue;
        // Shared rows are atomically written with their own explicit closure.
        // An unproved command result cannot taint a separately proved request.
        const context = rowContexts[i];
        let code = "saved-context-unproved";
        let admitted = false;
        if (isContextDependencies(context) && context.status === "known") {
          const identity = JSON.stringify(context);
          let check = checks.get(identity);
          if (!check) {
            check = input.validateDependencies(context).catch(() => ({ ok: false, code: "saved-context-unproved" }));
            checks.set(identity, check);
          }
          const decision = await check;
          admitted = decision.ok;
          if (!decision.ok) code = decision.code;
        }
        if (!admitted || !context) {
          omitted = true;
          unavailable.push(`Saved conversation row in ${key} is unavailable: ${code}.`);
          continue;
        }
        contexts.push(context);
        const actor = snapshot.transcript.actors?.[i];
        turns.push({
          text: `${message.role}: ${text}`,
          ...(actor !== undefined ? { actor } : {}),
          ...(snapshot.transcript.marks?.[i]?.folded ? { folded: true } : {}),
        });
      }
      const currentOnly =
        !omitted &&
        turns.length === 1 &&
        turns[0].actor === input.msg.userId &&
        turns[0].text === `user: ${input.msg.text.trim()}`;
      return { empty: false, turns, currentOnly };
    } catch (error) {
      unavailable.push(
        `Saved conversation for ${key} is unavailable: ${error instanceof Error ? error.message : "saved-context-unproved"}.`,
      );
      return { empty: false, turns: [] };
    }
  };
  const shared = await read(contextThreadSessionKey(input.msg.threadKey));
  const turns: OperatorTailTurn[] = [];
  if (shared.empty || shared.currentOnly) {
    const keys = new Set(
      [...input.runs]
        .reverse()
        .filter(
          (run) =>
            typeof run.userId === "string" &&
            run.userId.length > 0 &&
            run.channelId === input.msg.channelId &&
            run.threadKey === input.msg.threadKey,
        )
        .flatMap((run) => (run.session?.key ? [run.session.key] : [])),
    );
    for (const key of keys) turns.push(...(await read(key)).turns);
  }
  turns.push(...shared.turns);
  return { turns: operatorTail(turns), context: mergeContextDependencies(...contexts), unavailable };
}
