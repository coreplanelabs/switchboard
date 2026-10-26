import { testSourceInput } from "./sourceInputs.js";
import type { SourceEventReceipt } from "../runLedger/sourceEvents.js";
import type { SourceObligationJob } from "../runLedger/sourceObligations.js";

/** Future metadata seeded only by tests. No production obligation writer. */
export function testSourceObligationJob(receipt: SourceEventReceipt): SourceObligationJob {
  return {
    version: 4,
    eventKey: receipt.key,
    stage: "received",
    state: "waiting",
    prior: {
      version: 2,
      eventKey: receipt.key,
      stage: "received",
      state: "leased",
      attempts: 1,
      nextAttemptAt: receipt.receivedAt + 60_000,
      releases: [],
      lease: {
        owner: "fixture-owner",
        token: "fixture-token",
        claimedAt: receipt.receivedAt,
        until: receipt.receivedAt + 60_000,
      },
    },
    attempts: 1,
    nextAttemptAt: receipt.receivedAt + 60_000,
    obligations: [
      {
        reference: { ...testSourceInput(), receipt },
        context: { version: 1, status: "known", revision: 1, origins: [], slack: [], mcp: [] },
        state: "uncertain",
        automaticUntil: receipt.receivedAt + 60_000,
        reservedBytes: 8_000,
        settlementMaxBytes: 4_000,
        protections: [],
      },
    ],
  };
}
