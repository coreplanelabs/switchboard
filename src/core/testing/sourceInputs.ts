import type { SourceInputReference } from "../references/sourceInputReference.js";
import type { SourceInputIntents } from "../runLedger/sourceInputIntent.js";

/** Synthetic receipt for codec and storage tests; not canonical access proof. */
export function testSourceInput(fold = false): SourceInputReference {
  return {
    version: 1,
    receipt: { version: 1, key: `source:${"a".repeat(64)}`, sequence: 1, receivedAt: 123, bodyHash: "b".repeat(64) },
    root: { runId: "source-root", requester: "cli:user", channelId: "cli:main", threadKey: "cli:thread" },
    routing: fold
      ? { kind: "fold", decision: { id: '["source-root","call-1"]', hash: "c".repeat(64) } }
      : { kind: "notice" },
    inputHash: "d".repeat(64),
    accessHash: "e".repeat(64),
  };
}

/** Synthetic native intent metadata; not source access or native acceptance. */
export function testSourceInputIntent(harness: "pi" | "opencode" = "pi"): SourceInputIntents {
  const owner = {
    runId: "source-consumer",
    gen: "g1",
    requester: "cli:alice",
    channelId: "cli:main",
    threadKey: "cli:thread",
  };
  return {
    version: 1,
    entries: [
      {
        id: "source-input-one",
        phase: "prepared",
        owner,
        native: { harness, sessionId: "original-native-session", launchOrdinal: 0 },
        reference: {
          ...testSourceInput(),
          root: {
            runId: owner.runId,
            requester: owner.requester,
            channelId: owner.channelId,
            threadKey: owner.threadKey,
          },
        },
        witness: { version: 1, runId: owner.runId, seq: 8, digest: "f".repeat(64) },
        renderedHash: "a".repeat(64),
      },
    ],
  };
}
