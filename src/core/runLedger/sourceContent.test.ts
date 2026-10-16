import { describe, expect, it } from "vitest";
import { prepareSourceEvent, sourceEventRecordOf } from "./sourceEvents.js";
import { InMemoryRunLedger } from "./inMemory.js";

const legacy = {
  version: 1,
  sourceId: "fixture:source:1",
  deliveryId: "one",
  objectId: "comment:7",
  changeId: "revision:1",
  kind: "source-evidence",
  payload: { native: { body: "remote bytes" } },
};

describe("common source event content", () => {
  it("keeps message metadata as data and covers it with the receipt", async () => {
    const input = {
      ...legacy,
      version: 2,
      content: {
        kind: "text",
        state: "present",
        text: "Check this line",
        metadata: { path: "src/retry.ts", line: null, originalLine: 20, authenticatedAs: "an untrusted label" },
      },
    };
    const before = await prepareSourceEvent(input);
    expect(before?.event).toEqual(input);
    const after = await prepareSourceEvent({
      ...input,
      content: { ...input.content, metadata: { path: "src/other.ts" } },
    });
    expect(after?.key).toBe(before?.key);
    expect(after?.bodyHash).not.toBe(before?.bodyHash);
    for (const metadata of [null, [], "opaque"])
      expect(await prepareSourceEvent({ ...input, content: { ...input.content, metadata } })).toBeUndefined();
  });

  it("retains normalized text independently of the provider payload and binds it to the source receipt", async () => {
    const input = {
      ...legacy,
      version: 2,
      content: { kind: "text", state: "present", text: "Missing retry coverage" },
    };
    const prepared = await prepareSourceEvent(input);
    expect(prepared?.event).toEqual(input);
    expect(prepared?.json).toContain('"text":"Missing retry coverage"');
    const changed = await prepareSourceEvent({
      ...input,
      content: { kind: "text", state: "present", text: "Other coverage" },
    });
    expect(changed?.key).toBe(prepared?.key);
    expect(changed?.bodyHash).not.toBe(prepared?.bodyHash);
    const deleted = await prepareSourceEvent({ ...input, content: { ...input.content, state: "deleted" } });
    expect(deleted?.key).toBe(prepared?.key);
    expect(deleted?.bodyHash).not.toBe(prepared?.bodyHash);
  });

  it("preserves unknown text and typed facts as source data without control authority", async () => {
    const unknown = { ...legacy, version: 2, content: { kind: "text", state: "present", text: null } };
    expect((await prepareSourceEvent(unknown))?.event).toEqual(unknown);
    for (const state of ["deleted", "withdrawn"]) {
      const changed = { ...unknown, content: { ...unknown.content, state } };
      expect((await prepareSourceEvent(changed))?.event).toEqual(changed);
    }
    const fact = {
      ...legacy,
      version: 2,
      kind: "source-fact",
      content: {
        kind: "facts",
        facts: {
          action: "checkpoint",
          before: null,
          head: "a".repeat(40),
        },
      },
    };
    expect((await prepareSourceEvent(fact))?.event).toEqual(fact);
    expect(await prepareSourceEvent({ ...fact, kind: "checkpoint" })).toBeUndefined();
  });

  it("keeps legacy records readable without inferring normalized content from their payload", async () => {
    expect((await prepareSourceEvent(legacy))?.event).toEqual(legacy);
    expect(Object.hasOwn((await prepareSourceEvent(legacy))!.event, "content")).toBe(false);
    const request = {
      ...legacy,
      version: 2,
      kind: "request",
      content: { kind: "text", state: "present", text: "Check this change" },
    };
    expect((await prepareSourceEvent(request))?.event).toEqual(request);
  });

  it("holds unsupported, downgraded, malformed and authority-bearing content", async () => {
    const good = { ...legacy, version: 2, content: { kind: "text", state: "present", text: "Relevant comment" } };
    expect((await prepareSourceEvent(good))?.event).toEqual(good);
    for (const changed of [
      { version: 3 },
      { version: 1 },
      { content: undefined },
      { kind: "source-fact" },
      { content: { kind: "text", state: "present", text: 7 } },
      { content: { kind: "text", state: "present", text: "x", authenticatedAs: "admin" } },
      { content: { kind: "facts", facts: {} } },
      { content: { kind: "text", text: "missing lifecycle" } },
      { content: { kind: "text", state: "unknown", text: "invalid lifecycle" } },
    ])
      expect(await prepareSourceEvent({ ...good, ...changed })).toBeUndefined();
  });

  it("saves and replays the exact common content through the existing event store", async () => {
    const ledger = new InMemoryRunLedger(() => 1_000);
    const input = {
      ...legacy,
      version: 2,
      content: { kind: "text", state: "present", text: "Preserve the original owner" },
    };
    const received = await ledger.receiveSourceEvent(input);
    expect(received).toMatchObject({ kind: "received", receipt: { sequence: 1, receivedAt: 1_000 } });
    if (received.kind === "refused") throw new Error("Source reception failed");
    expect(await ledger.receiveSourceEvent(JSON.parse(JSON.stringify(input)))).toEqual({
      kind: "duplicate",
      receipt: received.receipt,
    });
    const stored = await ledger.readSourceEvent(received.receipt.key);
    expect(stored?.event).toEqual(input);
    expect(
      await sourceEventRecordOf({
        ...stored,
        event: { ...input, content: { kind: "text", state: "present", text: "Altered bytes" } },
      }),
    ).toBeUndefined();
    expect(
      await ledger.receiveSourceEvent({ ...input, content: { kind: "text", state: "present", text: "Changed text" } }),
    ).toEqual({
      kind: "refused",
      reason: "delivery-conflict",
    });
  });

  it("does not replace an older stored event when a new schema reuses its delivery identity", async () => {
    const ledger = new InMemoryRunLedger(() => 1_000);
    const received = await ledger.receiveSourceEvent(legacy);
    expect(received.kind).toBe("received");
    if (received.kind === "refused") throw new Error("Source reception failed");
    expect(
      await ledger.receiveSourceEvent({
        ...legacy,
        version: 2,
        content: { kind: "text", state: "present", text: "remote bytes" },
      }),
    ).toEqual({
      kind: "refused",
      reason: "delivery-conflict",
    });
    expect((await ledger.readSourceEvent(received.receipt.key))?.event).toEqual(legacy);
  });
});
