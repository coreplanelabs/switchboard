import { describe, expect, it } from "vitest";
import { prepareSourceEvidenceMessage } from "./sourceEvidence.js";
import { bindInboxCustody, messageFromInbox } from "./inboxMessage.js";
import { InMemoryRunLedger } from "./inMemory.js";
import { LEASE_MS } from "./types.js";

const destination = {
  runId: "child-one",
  channelId: "slack:C1",
  threadKey: "slack:C1:work",
  requester: "slack:UALICE",
};
async function fixture(authorId: string | null = "fixture:bot:4") {
  const ledger = new InMemoryRunLedger(() => 123);
  const event = {
    version: 1,
    kind: "source-evidence",
    sourceId: "fixture:installation:2",
    deliveryId: "delivery-one",
    objectId: "fixture:comment:7",
    changeId: "revision-one",
    occurredAt: 100,
    ...(authorId === null ? {} : { authorId }),
    payload: { text: "Check the retry limit." },
  };
  const received = await ledger.receiveSourceEvent(event);
  if (received.kind !== "received") throw new Error("expected canonical source receipt");
  const message = {
    version: 1,
    kind: "source-evidence",
    text: "Check the retry limit.",
    source: {
      sourceId: event.sourceId,
      deliveryId: event.deliveryId,
      objectId: event.objectId,
      changeId: event.changeId,
      authorId,
      occurredAt: 100,
    },
    receipt: received.receipt,
    decision: { runId: "orchestrator-one", id: JSON.stringify(["orchestrator-one", "fold-one"]) },
  };
  return { ledger, message };
}

describe("typed source evidence message", () => {
  it.each(["fixture:bot:4", "slack:UALICE", null])(
    "preserves author %s as evidence without requester identity",
    async (authorId) => {
      const { message } = await fixture(authorId);
      expect(await prepareSourceEvidenceMessage(message)).toEqual(message);
      expect(messageFromInbox(message, 0)).toBeUndefined();
      expect(Object.keys(message).sort()).toEqual(["decision", "kind", "receipt", "source", "text", "version"]);
    },
  );

  it("keeps a source receipt and saved decision reference through durable delivery and reclaim", async () => {
    const { ledger, message } = await fixture();
    await ledger.claim({
      runId: destination.runId,
      threadKey: destination.threadKey,
      gen: "g1",
      startedAt: 1000,
      leaseMs: LEASE_MS,
      system: "Review",
      tools: [],
      meta: {
        agent: "review",
        userId: destination.requester,
        channelId: destination.channelId,
        threadKey: destination.threadKey,
      },
    });
    expect(
      await ledger.deliverInbox(destination.runId, { version: 1, key: message.decision.id, message }),
    ).toMatchObject({ kind: "delivered", receipt: { seq: 1 } });
    await ledger.handoff("g1", [destination.runId]);
    await ledger.reclaim("g2", 2000, LEASE_MS);
    const peek = await ledger.peekInbox(destination.runId, "g2", 0);
    if (!peek.ok) throw new Error("expected retained source message");
    expect(await prepareSourceEvidenceMessage(peek.items[0].message, destination)).toEqual(message);
    expect(messageFromInbox(peek.items[0].message, 0, destination)).toBeUndefined();
    expect(peek.items[0].message.target).toMatchObject({ producerGen: "g1" });
    expect(peek.boundary.lastStep).toBeNull();
  });

  it("rejects requester, credential and control fields instead of copying them into evidence", async () => {
    const { message } = await fixture();
    expect(await prepareSourceEvidenceMessage(message)).toEqual(message);
    for (const shadow of [
      { userId: destination.requester },
      { authenticatedAs: "access:shadow" },
      { postedBy: "app:shadow" },
      { directAudience: { kind: "slack-unshared-im" } },
      { fromRunId: "other" },
      { approvalConnection: {} },
      { plane: { steer: "reissue" } },
    ])
      expect(await prepareSourceEvidenceMessage({ ...message, ...shadow })).toBeUndefined();
  });

  it("holds mismatched source receipts, malformed decisions and unknown schemas", async () => {
    const { message } = await fixture();
    expect(await prepareSourceEvidenceMessage(message)).toEqual(message);
    for (const changed of [
      { ...message, source: { ...message.source, deliveryId: "other-delivery" } },
      { ...message, decision: { ...message.decision, runId: "other-orchestrator" } },
      { ...message, decision: { ...message.decision, id: "not-json" } },
      { ...message, version: 99 },
      { ...message, receipt: { ...message.receipt, version: 99 } },
      { ...message, source: { ...message.source, authenticatedAs: "access:shadow" } },
    ])
      expect(await prepareSourceEvidenceMessage(changed)).toBeUndefined();
  });

  it("requires matching stored custody and refuses supplied custody on a wire message", async () => {
    const { message } = await fixture();
    const stored = bindInboxCustody(message, { ...destination, producerGen: "g1" })!;
    expect(await prepareSourceEvidenceMessage(stored, destination)).toEqual(message);
    expect(await prepareSourceEvidenceMessage(stored)).toBeUndefined();
    expect(await prepareSourceEvidenceMessage(message, destination)).toBeUndefined();
    expect(await prepareSourceEvidenceMessage(stored, { ...destination, requester: "slack:UOTHER" })).toBeUndefined();
    expect(await prepareSourceEvidenceMessage({ ...stored, target: { version: 99 } }, destination)).toBeUndefined();
  });

  it("keeps empty source text and unknown authors without fabricating a sender", async () => {
    const { message } = await fixture(null);
    const empty = { ...message, text: "" };
    expect(await prepareSourceEvidenceMessage(empty)).toEqual(empty);
    expect(messageFromInbox(empty, 0)).toBeUndefined();
  });

  it("captures source and decision data before hashing", async () => {
    const { message } = await fixture();
    const original = structuredClone(message);
    const pending = prepareSourceEvidenceMessage(message);
    message.text = "Later text";
    message.source.authorId = "fixture:other";
    message.decision.id = "other";
    expect(await pending).toEqual(original);
  });

  it("holds unsafe or oversized input without truncation", async () => {
    const { message } = await fixture();
    expect(await prepareSourceEvidenceMessage(message)).toEqual(message);
    let reads = 0;
    const unsafe = Object.defineProperty({ ...message }, "text", {
      enumerable: true,
      get: () => {
        reads++;
        return "unsafe";
      },
    });
    expect(await prepareSourceEvidenceMessage(unsafe)).toBeUndefined();
    expect(reads).toBe(0);
    expect(await prepareSourceEvidenceMessage({ ...message, text: "é".repeat(201 * 1024) })).toBeUndefined();
  });
});
