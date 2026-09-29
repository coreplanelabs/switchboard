import { wrapUntrusted } from "../core/untrusted.js";
import type { MainWorkerRelayResult } from "../core/coordinator/mainWorkerRelay.js";
import type { RunnableTool } from "./runnableTool.js";

/** The run-bound capability owns the actor and main thread; model input is only an address and cursor. */
export interface MainWorkerCapability {
  read(input: { actId: string; afterSeq?: number }): Promise<MainWorkerRelayResult>;
}

const ACT_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

export const workProgressTool: RunnableTool = {
  name: "work_progress",
  description:
    "In a verified unshared Slack DM, read progress and the final report of work you started from this conversation. Use the act id returned " +
    "when that work started. Pass the returned cursor as afterSeq to read later progress. Report only what the " +
    "bounded result supports; a missing result is not evidence that work finished.",
  inputSchema: {
    type: "object",
    properties: {
      actId: { type: "string", description: "The main conversation's stable work id." },
      afterSeq: { type: "integer", minimum: 0, description: "The previous progress cursor; omit for the first read." },
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
    if (!ctx.mainWorker) return "error: work progress is not available in this context";
    const result = await ctx.mainWorker.read({
      actId: input.actId,
      ...(input.afterSeq !== undefined ? { afterSeq: input.afterSeq as number } : {}),
    });
    if (result.kind !== "found") return JSON.stringify(result);
    return JSON.stringify({
      ...result,
      progress: result.progress.map((event) => ({ ...event, title: wrapUntrusted(event.title) })),
      ...(result.final ? { final: { ...result.final, report: wrapUntrusted(result.final.report) } } : {}),
    });
  },
};
