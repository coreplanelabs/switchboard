import { describe, expect, it } from "vitest";
import { InMemoryRunLedger } from "./inMemory.js";
import { inboxDeliveryWitness } from "./inboxDelivery.js";
import { sourceHash } from "../references/receipts.js";
import { LEASE_MS } from "./types.js";

const target = { runId: "r1", channelId: "slack:C1", threadKey: "slack:C1:delivery-link", requester: "slack:UALICE" };
const expected = {
  version: 1,
  runId: "r1",
  seq: 1,
  digest: "3ed493011602085386f145a8cbb88489ea0a86f7644985bc8a9adac3d1396577",
};
async function fixture() {
  const ledger = new InMemoryRunLedger(() => 123);
  await ledger.claim({
    runId: "r1",
    threadKey: target.threadKey,
    gen: "g1",
    startedAt: 1000,
    leaseMs: LEASE_MS,
    system: "Review",
    tools: [],
    meta: { agent: "review", channelId: target.channelId, threadKey: target.threadKey, userId: target.requester },
  });
  const sent = await ledger.deliverInbox("r1", {
    version: 1,
    key: "decision-one",
    message: { text: "Original input", userId: target.requester },
  });
  const peek = await ledger.peekInbox("r1", "g1", 0);
  if (sent.kind !== "delivered" || !peek.ok) throw new Error("expected stored delivery and observation");
  return { ledger, receipt: sent.receipt, item: peek.items[0] };
}

describe("keyed delivery row witness", () => {
  it("links distinct payload and custody hashes through reclaim without acknowledging consumption", async () => {
    const f = await fixture();
    expect(f.receipt.bodyHash).toBe("b45bed885d30fa1aae0a18b7d80268529ce453f12643683ef6fdb7b4978eb299");
    expect(f.item.witness.digest).toBe(expected.digest);
    expect(await inboxDeliveryWitness(f.receipt, f.item, target)).toEqual(expected);
    await f.ledger.handoff("g1", ["r1"]);
    await f.ledger.reclaim("g2", 2000, LEASE_MS);
    const peek = await f.ledger.peekInbox("r1", "g2", 0);
    if (!peek.ok) throw new Error("expected current-owner observation");
    expect(await inboxDeliveryWitness(f.receipt, peek.items[0], target)).toEqual(expected);
    expect(peek.items[0].message.target).toMatchObject({ producerGen: "g1" });
    expect(await f.ledger.readInbox("r1", 0)).toHaveLength(1);
    expect(peek.boundary.lastStep).toBeNull();
  });

  it("refuses changed input even if its row witness is recomputed", async () => {
    const f = await fixture();
    expect(await inboxDeliveryWitness(f.receipt, f.item, target)).toEqual(expected);
    expect(
      await inboxDeliveryWitness(
        f.receipt,
        {
          ...f.item,
          witness: { ...f.item.witness, digest: "0".repeat(64) },
        },
        target,
      ),
    ).toBeUndefined();
    f.item.message.text = "Changed input";
    expect(await inboxDeliveryWitness(f.receipt, f.item, target)).toBeUndefined();
    f.item.witness.digest = await sourceHash(f.item.message);
    expect(await inboxDeliveryWitness(f.receipt, f.item, target)).toBeUndefined();
  });

  it("holds foreign destination coordinates and mismatched row identities", async () => {
    const f = await fixture();
    expect(await inboxDeliveryWitness(f.receipt, f.item, target)).toEqual(expected);
    for (const changed of [
      { ...target, runId: "r2" },
      { ...target, channelId: "slack:C2" },
      { ...target, threadKey: "slack:C1:other" },
      { ...target, requester: "slack:UOTHER" },
    ])
      expect(await inboxDeliveryWitness(f.receipt, f.item, changed)).toBeUndefined();
    expect(await inboxDeliveryWitness(f.receipt, { ...f.item, seq: 2 }, target)).toBeUndefined();
    expect(
      await inboxDeliveryWitness(f.receipt, { ...f.item, witness: { ...f.item.witness, runId: "r2" } }, target),
    ).toBeUndefined();
  });

  it("holds unknown receipt, witness and custody schemas", async () => {
    const f = await fixture();
    expect(await inboxDeliveryWitness(f.receipt, f.item, target)).toEqual(expected);
    expect(await inboxDeliveryWitness({ ...f.receipt, version: 99 }, f.item, target)).toBeUndefined();
    expect(
      await inboxDeliveryWitness(f.receipt, { ...f.item, witness: { ...f.item.witness, version: 99 } }, target),
    ).toBeUndefined();
    expect(
      await inboxDeliveryWitness(
        f.receipt,
        { ...f.item, message: { ...f.item.message, target: { version: 99 } } },
        target,
      ),
    ).toBeUndefined();
  });

  it("captures both receipts and row bytes before asynchronous hashing", async () => {
    const f = await fixture();
    const pending = inboxDeliveryWitness(f.receipt, f.item, { ...target });
    f.receipt.bodyHash = "0".repeat(64);
    f.item.message.text = "Later mutation";
    f.item.witness.digest = "0".repeat(64);
    expect(await pending).toEqual(expected);
  });

  it("holds unsafe row accessors without reading their values", async () => {
    const f = await fixture();
    expect(await inboxDeliveryWitness(f.receipt, f.item, target)).toEqual(expected);
    let reads = 0;
    const unsafe = Object.defineProperty({}, "text", {
      enumerable: true,
      get: () => {
        reads++;
        return "unsafe";
      },
    });
    expect(await inboxDeliveryWitness(f.receipt, { ...f.item, message: unsafe }, target)).toBeUndefined();
    expect(reads).toBe(0);
  });
});
