import type { SourceInputReference } from "../references/sourceInputReference.js";
import type { SourceInputIntents } from "../runLedger/sourceInputIntent.js";
import type { RunLedger } from "../runLedger/ledger.js";
import { sourceEvidenceMessageFromRecord } from "../runLedger/sourceEvidence.js";
import { sourceHash } from "../references/receipts.js";
import { sourceSnapshot } from "../runLedger/sourceEvents.js";

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

/** Store a real source notice for a claimed synthetic orchestrator. This proves
 * row binding only; the access hash is not a current permission receipt. */
export async function seedSourceInputIntent(
  ledger: RunLedger,
  original: SourceInputIntents,
): Promise<SourceInputIntents> {
  const input = structuredClone(original),
    entry = input.entries[0]!;
  const owner = entry.owner;
  const saved = await ledger.receiveSourceEvent?.({
    version: 2,
    kind: "source-evidence",
    sourceId: "fixture:source",
    deliveryId: entry.id,
    objectId: "fixture:comment:1",
    changeId: "one",
    payload: {},
    content: { kind: "text", state: "present", text: "Synthetic source input." },
  });
  if (!saved || saved.kind === "refused") throw new Error("Source fixture was refused");
  const record = await ledger.readSourceEvent?.(saved.receipt.key);
  const message = await sourceEvidenceMessageFromRecord(record, {
    kind: "notice",
    owner: {
      runId: owner.runId,
      requesterId: owner.requester,
      channelId: owner.channelId,
      threadKey: owner.threadKey,
    },
  });
  if (!message) throw new Error("Source fixture is unavailable");
  const appended = await ledger.pushInbox(owner.runId, { ...message });
  if (!appended.ok) throw new Error("Inbox fixture was refused");
  const peek = await ledger.peekInbox(owner.runId, owner.gen, 0);
  const item = peek.ok && peek.items.find((row) => row.seq === appended.seq);
  if (!item) throw new Error("Inbox fixture is unavailable");
  entry.witness = item.witness;
  entry.reference = {
    ...entry.reference,
    receipt: saved.receipt,
    inputHash: await sourceHash(sourceSnapshot(message)),
    root: { runId: owner.runId, requester: owner.requester, channelId: owner.channelId, threadKey: owner.threadKey },
  };
  return input;
}
