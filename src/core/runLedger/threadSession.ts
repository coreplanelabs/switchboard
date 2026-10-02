import { UNKNOWN_CONTEXT_DEPENDENCIES, type ContextDependencies } from "../references/contextDependencies.js";
import type { RunSession } from "../runRecord.js";
import type { RunLedger } from "./ledger.js";
import type { AssembledTranscript } from "./transcript.js";
import { migrationOrder, migrationRowId, sessionKey, storedTurnRow, contextThreadSessionKey } from "./sessionLog.js";

type ThreadLedger = Pick<RunLedger, "appendSession" | "readSessionTail">;

/** A child's published answer enters its original parent's conversation only
 * through the canonical parent record; model-authored thread names never route reports. */
export async function appendRunReport(
  ledger: Pick<RunLedger, "appendSession">,
  input: {
    runId: string;
    threadKey: string;
    requester: string;
    channelId: string;
    text: string;
    context: ContextDependencies;
    folded?: boolean;
    parentRunId?: string;
    /** Recheck immediately before handing each report's bytes to storage. */
    canPublish?: () => Promise<boolean>;
  },
  loadParent: (id: string) => Promise<{ id: string; threadKey?: string; userId?: string; channelId?: string } | null>,
): Promise<{ parent: "none" | "same-thread" | "appended" | "unavailable" | "withheld" }> {
  const turn = {
    threadKey: input.threadKey,
    rowId: `run:${input.runId}:answer`,
    role: "assistant" as const,
    text: input.text,
    context: input.context,
    ...(input.folded ? { folded: true } : {}),
  };
  if (input.canPublish && !(await input.canPublish())) return { parent: "withheld" };
  await appendThreadTurn(ledger, turn);
  if (!input.parentRunId) return { parent: "none" };
  const parent = await loadParent(input.parentRunId);
  if (
    !parent?.threadKey ||
    parent.id !== input.parentRunId ||
    parent.userId !== input.requester ||
    parent.channelId !== input.channelId
  )
    return { parent: "unavailable" };
  if (parent.threadKey === input.threadKey) return { parent: "same-thread" };
  if (input.canPublish && !(await input.canPublish())) return { parent: "withheld" };
  await appendThreadTurn(ledger, { ...turn, threadKey: parent.threadKey, folded: true });
  return { parent: "appended" };
}

/** Control-plane turns use event identity; an execution transcript keeps its
 * own owner and indices. Concurrent connector events cannot overwrite a
 * model step by appending to the model's working log. */
export async function appendThreadTurn(
  ledger: Pick<RunLedger, "appendSession">,
  input: {
    threadKey: string;
    rowId: string;
    role: "user" | "assistant";
    text: string;
    actor?: string;
    silent?: boolean;
    folded?: boolean;
    context?: ContextDependencies;
  },
): Promise<{ appended: boolean }> {
  const result = await ledger.appendSession(
    contextThreadSessionKey(input.threadKey),
    input.rowId,
    [{ part: 0, json: storedTurnRow({ ...input, context: input.context ?? UNKNOWN_CONTEXT_DEPENDENCIES }) }],
    input.context ?? UNKNOWN_CONTEXT_DEPENDENCIES,
  );
  if (!result.ok) throw new Error("thread session append was refused");
  return { appended: result.appended };
}

export interface ThreadMigrationResult {
  appended: number;
  /** Original logs stay available for authorized recall; migration never rewrites them. */
  legacyKeys: string[];
  omittedTurns: number;
  omittedParts: number;
}

/** Replayable cutover over retained legacy tails. Stable source-row identities
 * also cover a live old-generation run whose final rows arrive after the
 * first migration. No completion latch can strand half a copied log after a
 * process failure. The result names every source and omission for the caller. */
export async function migrateThreadSession(
  ledger: ThreadLedger,
  input: {
    threadKey: string;
    runs: readonly { agent?: string; startedAt: number; session?: RunSession }[];
    maxBytes: number;
    /** Trusted ingress archive comparison supplied by the caller. A row's
     * actor or missing source metadata alone establishes no provenance. */
    verifiedIngress?: readonly { sessionKey: string; index: number; actor: string; text: string }[];
  },
): Promise<ThreadMigrationResult> {
  const runs = input.runs.filter(
    (run) =>
      run.agent &&
      run.session?.threadSession === undefined &&
      run.session?.key === sessionKey(input.threadKey, run.agent),
  );
  const keys = [...new Set(runs.map((run) => run.session!.key))];
  const result: ThreadMigrationResult = { appended: 0, legacyKeys: keys, omittedTurns: 0, omittedParts: 0 };
  const rows = new Map<string, Map<number, Parameters<typeof appendThreadTurn>[1]>>();
  for (const key of keys) {
    const tail = await ledger.readSessionTail(key, input.maxBytes);
    // Ordinary runs keep their agent working log after cutover. Their new
    // rows already enter the thread session under connector/report IDs, so
    // never migrate them a second time under legacy row IDs.
    const unifiedFrom = Math.min(
      ...input.runs.flatMap((run) =>
        run.session?.key === key && run.session.threadSession !== undefined
          ? [run.session.range === "broken" ? run.session.seedFrom : run.session.range.from]
          : [],
      ),
    );
    const byIndex = new Map<number, Parameters<typeof appendThreadTurn>[1]>();
    for (const [i, message] of tail.transcript.messages.entries()) {
      const idx = messageLogIndex(tail.from, tail.transcript, i);
      if (idx >= unifiedFrom) continue;
      const actor = tail.transcript.actors?.[i];
      const first = message.content[0];
      const verified =
        message.role === "user" &&
        actor &&
        first?.type === "text" &&
        input.verifiedIngress?.some(
          (proof) =>
            proof.sessionKey === key && proof.index === idx && proof.actor === actor && proof.text === first.text,
        );
      const texts = verified && first?.type === "text" ? [first] : [];
      result.omittedParts += message.content.length - texts.length;
      if (texts.length === 0) {
        result.omittedTurns++;
        continue;
      }
      byIndex.set(idx, {
        threadKey: input.threadKey,
        rowId: migrationRowId(key, idx),
        role: message.role,
        text: texts.map((part) => part.text).join("\n"),
        context: { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] },
        ...(actor ? { actor } : {}),
        ...tail.transcript.marks?.[i],
      });
    }
    rows.set(key, byIndex);
  }
  const order = migrationOrder(
    runs.flatMap((run) =>
      run.session!.range === "broken"
        ? []
        : [{ key: run.session!.key, startedAt: run.startedAt, range: run.session!.range }],
    ),
    [...rows].map(([key, turns]) => ({ key, rows: [...turns.keys()] })),
  );
  for (const { key, idx } of order) {
    const appended = await appendThreadTurn(ledger, rows.get(key)!.get(idx)!);
    if (appended.appended) result.appended++;
  }
  return result;
}

/** Compaction rows occupy log indices but not provider-message indices. */
function messageLogIndex(from: number, transcript: AssembledTranscript, message: number): number {
  return from + message + transcript.compactions.filter((entry) => entry.before <= message).length;
}
