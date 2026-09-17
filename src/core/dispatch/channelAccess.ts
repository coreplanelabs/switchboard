import type { ChannelIO, IncomingMessage } from "../types.js";
import type { LedgerWriteThrough } from "../runLedger/writeThrough.js";
import { closeRestartRow, closeResumedRow, type RestartContext, type ResumeContext } from "./admission.js";

/** Check before commands, history and admission, including restored requests.
 * A failed lookup has no execution effects, so durable callers can retry. */
export async function checkChannelAccess(
  ledger: LedgerWriteThrough,
  ctx: { io: ChannelIO; msg: IncomingMessage; resume?: ResumeContext; restart?: RestartContext },
): Promise<"allow" | "deny" | "retry"> {
  if (!ctx.io.checkAccess) return "allow";
  let allowed: boolean;
  try {
    allowed = await ctx.io.checkAccess(ctx.msg.userId);
  } catch {
    // A reclaimed row remains durable without a new heartbeat. The next
    // recovery sweep can reclaim it after the lease expires.
    return "retry";
  }
  if (allowed) return "allow";
  const { resume, restart } = ctx;
  const row = resume?.row ?? restart?.row;
  if (row) {
    const adopted = ledger.adopt({
      runId: row.runId,
      threadKey: row.threadKey,
      state: row.state,
      lastStep: resume?.lastStep.step ?? 0,
      lastSeq: resume?.lastSeq ?? 0,
      ...(row.meta.session ? { session: row.meta.session } : {}),
    });
    try {
      if (resume) await closeResumedRow(adopted, resume, "requester lost channel access");
      else if (restart) await closeRestartRow(adopted, restart, "requester lost channel access");
    } finally {
      await adopted.close();
    }
  }
  return "deny";
}
