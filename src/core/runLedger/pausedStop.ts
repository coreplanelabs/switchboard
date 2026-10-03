import { reclaimedRunRecord } from "../dispatch/record.js";
import type { RunLedger } from "./ledger.js";

/** Close a retry pause only after its hard stop and pause marker are durable.
 * Both stop and pause call this after their own ledger write, so either order
 * of the two writes closes the row without treating a SIGTERM handoff as idle. */
export async function sealPausedHardStop(
  ledger: Pick<RunLedger, "listLive" | "readEvents" | "finish">,
  runId: string,
  gen: string,
  now: () => number,
): Promise<"sealed" | "gone" | "other-owner" | "not-paused" | "fenced"> {
  const row = (await ledger.listLive()).find((r) => r.runId === runId);
  if (!row) return "gone";
  if (row.ownerGen !== gen) return "other-owner";
  if (row.phase !== "handoff" || row.state.pausedForRetry !== true || row.stop !== "hard" || row.meta.hosted)
    return "not-paused";
  const record = reclaimedRunRecord({
    row,
    events: await ledger.readEvents(runId),
    status: "stopped_hard",
    finishedAt: now(),
  });
  const result = await ledger.finish(runId, gen, record, { requireStoppedPause: true });
  return result.ok ? "sealed" : "fenced";
}
