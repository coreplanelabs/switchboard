import { evidenceRelevancePrompt, evidenceRelevanceSettings } from "../intake.js";
import type { RunLedger } from "../runLedger/ledger.js";
import {
  sourceEventReceiptOf,
  sourceEventRecordOf,
  sourceRelevanceRequestOf,
  sourceSnapshot,
  type SourceEventReceipt,
  type SourceRelevanceRecord,
  type SourceRelevanceRequest,
} from "../runLedger/sourceEvents.js";
import { captureSourceTaskSnapshot, sourceTaskSnapshotOf, type SourceTaskSnapshot } from "./sourceTaskSnapshot.js";
import { sourceHash } from "./receipts.js";

/** Private original save custody. The actual error, including a nullish throw,
 * remains untouched. Neither these bytes nor readback grant admission. */
export interface OriginalSourceRelevanceSave {
  request: SourceRelevanceRequest;
  error: unknown;
}
export interface SourceRelevancePreparation {
  version: 1;
  receipt: SourceEventReceipt;
  task: SourceTaskSnapshot;
  context: SourceRelevanceRequest["result"]["context"];
  inputHash: string;
}
export type SourceRelevancePreparationResult = {
  kind: "held";
  reason:
    | "admission-unproved"
    | "input-unproved"
    | "source-unproved"
    | "context-changed"
    | "identity-conflict"
    | "unavailable";
  /** Private controller evidence only. No source access, classifier, model or delivery authority. */
  preparation?: SourceRelevancePreparation;
  original?: OriginalSourceRelevanceSave;
  /** An exact historical save, never a newly admitted recommendation. */
  originalRecord?: SourceRelevanceRecord;
};
interface PreparationInput {
  receipt: unknown;
  task: unknown;
  /** Caller-owned revision of the classifier policy and actual model/settings binding. */
  classifierPolicy: unknown;
  capField?: string;
  timeoutMs?: number;
  original?: OriginalSourceRelevanceSave;
}
const json = (v: unknown) => JSON.stringify(sourceSnapshot(v));

/** Inactive read-only preparation. Separate boolean access checks and remote
 * canonical reads cannot prove joint admission. Always return a hold; this
 * helper has no classifier, provider, save operation or admission proof seam. */
export async function prepareSourceRelevanceEvidence(
  input: PreparationInput,
  ledger: Pick<RunLedger, "listLive" | "readSourceEvent">,
): Promise<SourceRelevancePreparationResult> {
  let original: OriginalSourceRelevanceSave | undefined;
  const held = (reason: SourceRelevancePreparationResult["reason"]): SourceRelevancePreparationResult => ({
    kind: "held",
    reason,
    ...(original ? { original } : {}),
  });
  try {
    original = input.original;
    if (original) {
      const request = sourceRelevanceRequestOf(original.request);
      if (!request) return held("input-unproved");
      original = { request, error: original.error };
    }
    const task = sourceTaskSnapshotOf(input.task);
    const receipt = sourceEventReceiptOf(sourceSnapshot(input.receipt ?? null));
    const classifierPolicy = sourceSnapshot(input.classifierPolicy ?? null);
    const settings = evidenceRelevanceSettings({ capField: input.capField, timeoutMs: input.timeoutMs });
    if (
      !task ||
      !receipt ||
      typeof classifierPolicy !== "string" ||
      !classifierPolicy.trim() ||
      new TextEncoder().encode(classifierPolicy).byteLength > 512
    )
      return held("input-unproved");
    const read = async () => {
      const value = await ledger.readSourceEvent?.(receipt.key);
      if (value === undefined) return;
      const record = await sourceEventRecordOf(sourceSnapshot(value));
      return record &&
        [1, 2, 3].includes(record.job.version) &&
        json(record.receipt) === json(receipt) &&
        record.event.version === 2 &&
        record.event.kind !== "request"
        ? record
        : undefined;
    };
    const taskMatches = async () => {
      const rows = (await ledger.listLive()).filter((row) => row.runId === task.owner.runId);
      const current = rows.length === 1 ? captureSourceTaskSnapshot(rows[0]!) : undefined;
      return current !== undefined && json(current) === json(task);
    };
    const record = await read();
    if (!record) return held("source-unproved");
    if (!(await taskMatches())) return held("context-changed");
    const inputBytes = {
      taskContext: json(task.task),
      message: json({ kind: record.event.kind, content: record.event.content }),
    };
    const context = {
      runId: task.owner.runId,
      requester: task.owner.requesterId,
      channelId: task.owner.channelId,
      threadKey: task.owner.threadKey,
      hash: await sourceHash(task),
    };
    const inputHash = await sourceHash(
      sourceSnapshot({
        version: 1,
        source: { receipt, kind: record.event.kind, content: record.event.content },
        task,
        prompt: evidenceRelevancePrompt(inputBytes),
        classifierPolicy,
        options: settings,
      }),
    );
    if (
      original &&
      (json(original.request.receipt) !== json(receipt) ||
        json(original.request.result.context) !== json(context) ||
        original.request.result.inputHash !== inputHash)
    )
      return held("identity-conflict");
    // Compare observed identities only. These reads establish neither current
    // source permission nor admission authority.
    const after = await read();
    if (
      !after ||
      json({ event: after.event, receipt: after.receipt }) !== json({ event: record.event, receipt: record.receipt })
    )
      return held("source-unproved");
    if (!(await taskMatches())) return held("context-changed");
    const saved =
      original && after.job.version === 3
        ? after.job.relevance.find((candidate) => json(candidate.context) === json(context))
        : undefined;
    if (saved) {
      const { at: _at, ...result } = saved;
      if (json(result) !== json(original!.request.result)) return held("identity-conflict");
    }
    return {
      ...held("admission-unproved"),
      preparation: { version: 1, receipt, task, context, inputHash },
      ...(saved ? { originalRecord: saved } : {}),
    };
  } catch {
    return held("unavailable");
  }
}
