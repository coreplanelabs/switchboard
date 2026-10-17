import { describe, expect, it } from "vitest";
import { prepareSourceEvidenceMessage, sourceEvidenceMessageFromRecord } from "./sourceEvidence.js";
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

describe("source notice and fold messages", () => {
  const owner = {
    runId: "orchestrator-one",
    requesterId: "slack:UALICE",
    channelId: "slack:C1",
    threadKey: "slack:C1:work",
  };
  async function common(content: unknown = { kind: "text", state: "present", text: "Check the retry limit." }) {
    const { ledger, message: legacy } = await fixture();
    const event = {
      version: 2,
      kind: (content as { kind: string }).kind === "facts" ? "source-fact" : "source-evidence",
      sourceId: legacy.source.sourceId,
      deliveryId: "delivery-two",
      objectId: legacy.source.objectId,
      changeId: "revision-two",
      authorId: "fixture:bot:4",
      occurredAt: 100,
      payload: { opaque: "native text is not common content" },
      content,
    };
    const received = await ledger.receiveSourceEvent(event);
    if (received.kind === "refused") throw new Error("expected canonical common event");
    const message = {
      version: 2,
      kind: "source-evidence",
      source: { ...legacy.source, deliveryId: event.deliveryId, changeId: event.changeId, kind: event.kind },
      receipt: received.receipt,
      routing: { kind: "notice", owner },
      content,
    };
    return { ledger, event, message };
  }

  it("projects common content from the consistent source record and never parses its native payload", async () => {
    const { ledger, message } = await common();
    const record = await ledger.readSourceEvent(message.receipt.key);
    expect(await sourceEvidenceMessageFromRecord(record, { kind: "notice", owner })).toEqual(message);
    expect(
      await sourceEvidenceMessageFromRecord(
        { ...record, event: { ...record!.event, content: { kind: "text", state: "present", text: "Changed source" } } },
        { kind: "notice", owner },
      ),
    ).toBeUndefined();
    expect(
      await sourceEvidenceMessageFromRecord(
        { ...record, receipt: { ...record!.receipt, bodyHash: "f".repeat(64) } },
        { kind: "notice", owner },
      ),
    ).toBeUndefined();
    const legacy = await fixture();
    expect(
      await sourceEvidenceMessageFromRecord(await legacy.ledger.readSourceEvent(legacy.message.receipt.key), {
        kind: "notice",
        owner,
      }),
    ).toBeUndefined();
  });

  it("captures both stored source and route before asynchronous validation", async () => {
    const { ledger, message } = await common({ kind: "facts", facts: { state: "closed", nested: { count: 2 } } });
    const record = (await ledger.readSourceEvent(message.receipt.key))!;
    const routing = { kind: "notice" as const, owner: { ...owner } };
    const pending = sourceEvidenceMessageFromRecord(record, routing);
    routing.owner.requesterId = "slack:UOTHER";
    record.event.payload = { text: "Changed native payload" };
    expect(await pending).toEqual(message);
    expect(
      await sourceEvidenceMessageFromRecord(await ledger.readSourceEvent(message.receipt.key), {
        kind: "notice",
        owner,
      }),
    ).toEqual(message);
  });

  it("preserves first notices through keyed delivery and reclaim only under their root custody", async () => {
    const { ledger, message } = await common({ kind: "text", state: "deleted", text: null });
    const root = {
      runId: owner.runId,
      requester: owner.requesterId,
      channelId: owner.channelId,
      threadKey: owner.threadKey,
    };
    await ledger.claim({
      runId: root.runId,
      threadKey: root.threadKey,
      gen: "g1",
      startedAt: 1000,
      leaseMs: LEASE_MS,
      system: "Orchestrator",
      tools: [],
      meta: { agent: "orchestrator", userId: root.requester, channelId: root.channelId, threadKey: root.threadKey },
    });
    const delivery = await ledger.deliverInbox(root.runId, { version: 1, key: "notice-one", message });
    expect(delivery).toMatchObject({ kind: "delivered", receipt: { runId: root.runId, seq: 1 } });
    await ledger.handoff("g1", [root.runId]);
    await ledger.reclaim("g2", 2000, LEASE_MS);
    const peek = await ledger.peekInbox(root.runId, "g2", 0);
    if (!peek.ok) throw new Error("expected held original notice");
    expect(await prepareSourceEvidenceMessage(peek.items[0].message, root)).toEqual(message);
    expect(messageFromInbox(peek.items[0].message, 0, root)).toBeUndefined();
    expect(peek.items[0].message.target).toMatchObject({ producerGen: "g1" });
    expect(peek.boundary.lastStep).toBeNull();
    const foreign = bindInboxCustody(message, { ...destination, producerGen: "g1" })!;
    expect(await prepareSourceEvidenceMessage(foreign, destination)).toBeUndefined();
  });

  it("refuses source requests, mixed schemas and authority fields while retaining a valid notice", async () => {
    const { ledger, event, message } = await common();
    expect(await prepareSourceEvidenceMessage(message)).toEqual(message);
    for (const changed of [
      { ...message, userId: owner.requesterId },
      { ...message, decision: { runId: owner.runId, id: JSON.stringify([owner.runId, "fold-one"]) } },
      { ...message, text: "Shadow requester text" },
      { ...message, routing: { ...message.routing, authenticatedAs: "access:shadow" } },
      { ...message, routing: { ...message.routing, owner: { ...owner, producerGen: "g1" } } },
      { ...message, source: { ...message.source, kind: "request" } },
      { ...message, content: { kind: "facts", facts: { state: "closed" } } },
    ])
      expect(await prepareSourceEvidenceMessage(changed)).toBeUndefined();
    const request = await ledger.receiveSourceEvent({ ...event, kind: "request", deliveryId: "request-one" });
    if (request.kind === "refused") throw new Error("expected source request record");
    expect(
      await sourceEvidenceMessageFromRecord(await ledger.readSourceEvent(request.receipt.key), {
        kind: "notice",
        owner,
      }),
    ).toBeUndefined();
  });

  it("retains a first notice without inventing a prior fold decision", async () => {
    const { message } = await common();
    expect(await prepareSourceEvidenceMessage(message)).toEqual(message);
    expect(messageFromInbox(message, 0)).toBeUndefined();
  });

  it("keeps typed facts and text lifecycle values without requester authority", async () => {
    for (const content of [
      { kind: "text", state: "present", text: "" },
      { kind: "text", state: "deleted", text: null },
      { kind: "text", state: "withdrawn", text: "Original text", metadata: { path: "src/retry.ts", line: null } },
      { kind: "facts", facts: { head: "a".repeat(40), state: "closed", nested: { value: null } } },
    ]) {
      const { message } = await common(content);
      expect(await prepareSourceEvidenceMessage(message)).toEqual(message);
      expect(messageFromInbox(message, 0)).toBeUndefined();
    }
  });

  it("requires a fold to name its original orchestrator decision", async () => {
    const { message } = await common();
    const folded = {
      ...message,
      routing: { kind: "fold", owner, decision: { runId: owner.runId, id: JSON.stringify([owner.runId, "fold-one"]) } },
    };
    expect(await prepareSourceEvidenceMessage(folded)).toEqual(folded);
    expect(
      await prepareSourceEvidenceMessage({
        ...folded,
        routing: { ...folded.routing, decision: { ...folded.routing.decision, runId: "foreign-root" } },
      }),
    ).toBeUndefined();
    expect(await prepareSourceEvidenceMessage({ ...message, routing: { kind: "fold", owner } })).toBeUndefined();
    expect(
      await prepareSourceEvidenceMessage({ ...message, routing: { ...folded.routing, kind: "notice" } }),
    ).toBeUndefined();
  });
});
