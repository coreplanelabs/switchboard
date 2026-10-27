import type { AudienceCheck } from "../../audienceDecision.js";
import type { ContextDependencies } from "../../references/contextDependencies.js";
import type { SourceInputAdmission, SourceInputIntent } from "../../runLedger/sourceInputIntent.js";
import type { LedgerRun } from "../../runLedger/writeThrough.js";
import { readPiSourceInputReceipt } from "./sourceInputReceipt.js";

/** Settle an existing native input. The host reads the original file through
 * its executor; this operation never submits a command or starts a model.
 * The tracked writer verifies canonical readback before each exact ACK. */
export async function checkpointPiSourceInput(
  original: SourceInputIntent,
  file: { path: string; content: string },
  run: Pick<LedgerRun, "sourceInputCheckpoint">,
  validate: (context: ContextDependencies) => Promise<AudienceCheck>,
): Promise<boolean> {
  const native = readPiSourceInputReceipt(original, file);
  if (!native.ok) return false;
  const receipt: SourceInputAdmission = {
    version: 1,
    inputId: native.receipt.inputId,
    intentHash: native.receipt.intentHash,
    native: {
      harness: "pi",
      sessionId: native.receipt.native.sessionFile,
      sessionIdentity: native.receipt.native.sessionId,
      entryId: native.receipt.native.entryId,
      entryHash: native.receipt.native.entryHash,
    },
  };
  const committed = await run.sourceInputCheckpoint({ operation: "commit", receipt }, validate);
  if (!committed.ok || !committed.checkpoint) return false;
  if (committed.checkpoint.acknowledged) return true;
  const acknowledged = await run.sourceInputCheckpoint(
    { operation: "ack", inputId: receipt.inputId, receiptHash: committed.checkpoint.receiptHash },
    validate,
  );
  return (
    acknowledged.ok &&
    acknowledged.checkpoint?.acknowledged === true &&
    acknowledged.checkpoint.receiptHash === committed.checkpoint.receiptHash
  );
}
