import { wrapUntrusted } from "../core/untrusted.js";
import type {
  MainWorkReadInput,
  MainWorkReadReceipt,
  MainWorkReadRefresh,
} from "../core/coordinator/mainWorkObservation.js";
import type { MainWorkerRelayResult } from "../core/coordinator/mainWorkerRelay.js";
import type { RunnableTool } from "./runnableTool.js";

/** The run-bound capability owns the actor and main thread; model input is only an address and cursor. */
export interface MainWorkerCapability {
  read(input: MainWorkReadInput): Promise<MainWorkerRelayResult>;
  recordRead?(
    input: MainWorkReadInput,
    callId: string,
    result: Extract<MainWorkerRelayResult, { kind: "found" }>,
    content: string,
  ): Promise<void>;
  restoreRead?(receipt: MainWorkReadReceipt): (() => Promise<MainWorkReadRefresh>) | undefined;
}

const ACT_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

export const workProgressTool: RunnableTool = {
  name: "work_progress",
  description:
    "In a verified unshared Slack DM, read progress and the final report of work you started from this conversation. Use the act id returned " +
    "when that work started. Pass the returned cursor as afterSeq to read later progress. Report only what the " +
    "bounded result supports; a missing result is not evidence that work finished. A recorded settlement carries " +
    "typed producer facts; its report is display text. An unverified settlement supplies no typed outcome. " +
    "A merged pull request in an aborted outcome does not prove the unfinished work landed or authorize another writer. " +
    "When history is present, pass its cursor as afterHistory for more saved outcomes. Missing history and attempts before its observed predecessor remain unverified.",
  inputSchema: {
    type: "object",
    properties: {
      actId: { type: "string", description: "The main conversation's stable work id." },
      afterSeq: { type: "integer", minimum: 0, description: "The previous progress cursor; omit for the first read." },
      afterHistory: {
        type: "integer",
        minimum: 0,
        description: "The previous history cursor; omit for the first read.",
      },
    },
    required: ["actId"],
    additionalProperties: false,
  },
  sideEffectFree: true,
  failsInText: true,
  async run(input, ctx) {
    if (typeof input.actId !== "string" || !ACT_ID.test(input.actId)) return "error: invalid work id";
    if (input.afterSeq !== undefined && (!Number.isSafeInteger(input.afterSeq) || (input.afterSeq as number) < 0))
      return "error: invalid progress cursor";
    if (
      input.afterHistory !== undefined &&
      (!Number.isSafeInteger(input.afterHistory) || (input.afterHistory as number) < 0)
    )
      return "error: invalid history cursor";
    if (!ctx.mainWorker) return "error: work progress is not available in this context";
    const request = {
      actId: input.actId,
      ...(input.afterSeq !== undefined ? { afterSeq: input.afterSeq as number } : {}),
      ...(input.afterHistory !== undefined ? { afterHistory: input.afterHistory as number } : {}),
    };
    const result = await ctx.mainWorker.read(request);
    if (result.kind !== "found") return JSON.stringify(result);
    const content = renderWorkProgress(result);
    if (ctx.callId) await ctx.mainWorker.recordRead?.(request, ctx.callId, result, content);
    return content;
  },
};

export function renderWorkProgress(result: Extract<MainWorkerRelayResult, { kind: "found" }>): string {
  const { observation, ...projection } = result;
  return JSON.stringify({
    ...projection,
    asOf: { observedAt: observation.observedAt, snapshotHash: observation.snapshotHash },
    progress: result.progress.map((event) => ({ ...event, title: wrapUntrusted(event.title) })),
    ...(result.final ? { final: { ...result.final, report: wrapUntrusted(result.final.report) } } : {}),
    ...(result.history
      ? {
          history: {
            ...result.history,
            receipts: result.history.receipts.map((receipt) => ({
              ...receipt,
              report: wrapUntrusted(receipt.report),
            })),
          },
        }
      : {}),
  });
}
