import type { IncomingMessage } from "../../core/types.js";
import type { RunLedger } from "../../core/runLedger/ledger.js";
import type { RunStore } from "../../core/runStore.js";
import type { LinearDelivery } from "./inbox.js";
import { LINEAR_TIMING } from "../../core/budgets.js";

/** A durable request or inbox entry proves admission even when the consumer
 * died before recording the run binding. These reads are internal recovery,
 * never a listing returned to a Linear user. */
export async function recoverLinearDelivery(
  deps: { ledger: Pick<RunLedger, "listLive" | "readInbox">; store: Pick<RunStore, "get" | "list"> },
  delivery: LinearDelivery,
  msg: IncomingMessage,
): Promise<"handled" | "unknown"> {
  const matches = (request: Record<string, unknown> | undefined) =>
    request?.messageId === msg.messageId && request?.userId === msg.userId && request?.threadKey === msg.threadKey;
  for (const row of await deps.ledger.listLive()) {
    if (row.meta.threadKey !== msg.threadKey) continue;
    if (matches(row.meta.request)) return "handled";
    if ((await deps.ledger.readInbox(row.runId, 0)).some((item) => matches(item.message))) return "handled";
  }
  // A finish can race the live listing. Check the bound run, then the thread's
  // finished records, paging across identical finish timestamps as well.
  const proves = async (id: string) => {
    const record = await deps.store.get(id);
    return (
      record?.threadKey === msg.threadKey &&
      record.replyOk === true &&
      record.events.some((event) => event.type === "input" && event.messageId === msg.messageId)
    );
  };
  if (delivery.runId && (await proves(delivery.runId))) return "handled";
  let before: number | undefined, beforeId: string | undefined;
  for (;;) {
    const rows = await deps.store.list({
      threadKey: msg.threadKey,
      sinceMs: delivery.event.receivedAt - LINEAR_TIMING.webhookSkewMs,
      limit: 100,
      before,
      beforeId,
    });
    for (const row of rows) if (await proves(row.id)) return "handled";
    if (rows.length < 100) return "unknown";
    const last = rows[rows.length - 1]!;
    if (last.finishedAt === before && last.id === beforeId) throw new Error("linear_recovery_cursor_stalled");
    before = last.finishedAt;
    beforeId = last.id;
  }
}
