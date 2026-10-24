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

/** Isolated native checkpoint fixture. These synthetic native IDs prove the
 * store boundary only; they do not claim acceptance by a running harness. */
export async function seedSourceInputCheckpoints(ledger: RunLedger) {
  const id = "source-consumer",
    gen = "g1",
    thread = "cli:thread";
  const policy = { version: 1, commandRoute: "native", identity: "write" };
  const launch = { version: 1, harness: "pi", phase: "prepared", ordinal: 0, sessionPolicy: policy };
  const requireOk = (result: { ok: boolean }) => {
    if (!result.ok) throw new Error(`Native checkpoint fixture refused: ${JSON.stringify(result)}`);
  };
  requireOk(
    await ledger.claim({
      runId: id,
      threadKey: thread,
      gen,
      startedAt: 1,
      leaseMs: 10000,
      system: "original",
      tools: [],
      meta: { agent: "orchestrator", userId: "cli:alice", channelId: "cli:main", threadKey: thread },
      state: { harnessLaunch: launch },
    }),
  );
  requireOk(await ledger.setState(id, gen, { harnessLaunch: { ...launch, phase: "begun" } }));
  requireOk(
    await ledger.setState(id, gen, {
      harness: { harness: "pi", launchOrdinal: 0, sessionFile: "original-native-session", sessionPolicy: policy },
    }),
  );
  const session = `fixture:checkpoint:${crypto.randomUUID()}`;
  await ledger.claimSession(session, id, gen);
  const step = {
    step: 0,
    seq: 0,
    turnIndex: 0,
    inFlight: [],
    inboxConsumedSeq: 0,
    remainingMs: 1000,
    turn: 0,
    iteration: 0,
  };
  requireOk(await ledger.step(id, gen, step, [], session));
  requireOk(await ledger.pushInbox(id, { text: "Unrelated first row" }));
  const first = await seedSourceInputIntent(ledger, testSourceInputIntent());
  requireOk(await ledger.pushInbox(id, { text: "Unrelated third row" }));
  const second = testSourceInputIntent();
  second.entries[0]!.id = "source-input-two";
  const another = await seedSourceInputIntent(ledger, second);
  const intents: SourceInputIntents = { version: 1, entries: [...first.entries, ...another.entries] };
  requireOk(await ledger.setState(id, gen, { sourceInputIntents: intents }));
  for (const entry of intents.entries) entry.phase = "begun";
  requireOk(
    await ledger.setState(id, gen, {
      sourceInputIntents: intents,
      contextDependencies: {
        version: 4,
        status: "known",
        revision: 0,
        origins: [],
        slack: [],
        mcp: [],
        sourceInputs: intents.entries.map((entry) => entry.reference),
      },
    }),
  );
  const receipt: import("../runLedger/sourceInputIntent.js").SourceInputAdmission = {
    version: 1,
    inputId: intents.entries[0]!.id,
    intentHash: await sourceHash(sourceSnapshot(intents.entries[0])),
    native: {
      harness: "pi",
      sessionId: "original-native-session",
      sessionIdentity: "native-session-uuid",
      entryId: "native-entry-one",
      entryHash: "a".repeat(64),
    },
  };
  return { id, gen, thread, session, step, intents, receipt };
}
