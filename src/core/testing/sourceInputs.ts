import type { SourceInputReference } from "../references/sourceInputReference.js";

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
