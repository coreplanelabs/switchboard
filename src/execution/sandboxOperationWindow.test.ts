import { describe, expect, it, vi } from "vitest";
import type { CheckpointRecord } from "./sandboxCheckpoint.js";
import {
  OPERATION_WINDOW_SIZE,
  decodeLifecycle,
  reserveOperation,
  recordOperationOutcome,
  readOperation,
  holdResetOperations,
  updateCheckpoint,
  requestAuthorityTransition,
  type LifecycleRecord,
  type OperationOwner,
  type OperationSelector,
  type WindowTransition,
} from "./sandboxOperationWindow.js";

const owner: OperationOwner = {
  runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ownerGen: "generation-original",
  allocationKey: "allocation-original",
  actorId: "a".repeat(64),
};
const checkpoint: CheckpointRecord = {
  owner: {
    run: owner.runId,
    requester: "mcp:operator",
    thread: "mcp:thread",
    repository: "example/project",
    ref: "main",
    head: "b".repeat(40),
    seed: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    container: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  },
  doorOrigin: "https://example.test",
  backupId: "backup-original",
};
const fresh = (): LifecycleRecord => ({
  ...checkpoint,
  version: 2,
  lifecycle: {
    allocation: { ...owner },
    binding: "bound",
    admission: "open",
    operationWindow: { issuedThrough: 0, settledThrough: 0, slots: Array(OPERATION_WINDOW_SIZE).fill(null) },
  },
});
function reserve(
  record: LifecycleRecord,
  operation: "warm-up" | "sdk" | "process" | "stream" = "warm-up",
  parentOrdinal?: number,
) {
  const result = reserveOperation(record, owner, operation, parentOrdinal);
  expect(result.kind).toBe("reserved");
  if (result.kind !== "reserved") throw new Error("operation not reserved");
  return result;
}
function changed(result: WindowTransition): LifecycleRecord {
  expect(["recorded", "unchanged"]).toContain(result.kind);
  if (result.kind !== "recorded" && result.kind !== "unchanged") throw new Error("no transition");
  return result.record;
}
const complete = (record: LifecycleRecord, selector: OperationSelector) =>
  changed(recordOperationOutcome(record, selector, { kind: "warm-up", outcome: { kind: "succeeded" } }));

describe("sandbox lifecycle record", () => {
  it("preserves a complete legacy checkpoint without upgrading its authority", () => {
    expect(decodeLifecycle(checkpoint)).toEqual({ kind: "legacy", record: checkpoint, authority: "unverified" });
    expect(requestAuthorityTransition(checkpoint, "bound").kind).toBe("held");
  });
  it("recognizes a pending versioned record separately from a missing legacy checkpoint", () => {
    const record = fresh();
    delete record.owner;
    record.lifecycle.binding = "pending";
    expect(decodeLifecycle(record)).toEqual({ kind: "versioned", record, authority: "unverified" });
    expect(reserveOperation(record, owner, "sdk").kind).toBe("held");
    expect(reserveOperation(record, owner, "warm-up").kind).toBe("reserved");
  });
  it("holds missing malformed and disguised lifecycle records instead of treating them as legacy", () => {
    const malformed = fresh();
    malformed.lifecycle.operationWindow.slots.pop();
    for (const input of [
      undefined,
      null,
      {},
      { ...checkpoint, lifecycle: fresh().lifecycle },
      { ...fresh(), version: 3 },
      malformed,
      { ...fresh(), callerPermitsDestroy: true },
    ])
      expect(decodeLifecycle(input)).toEqual({ kind: "unknown" });
  });
  it("preserves legacy ownership and origin during a checkpoint update", () => {
    const updated = updateCheckpoint(checkpoint, { owner: checkpoint.owner, backupId: "backup-next" });
    expect(updated).toEqual({
      kind: "legacy",
      record: { ...checkpoint, backupId: "backup-next" },
      authority: "unverified",
    });
  });
  it("preserves versioned closing and outstanding debt during a checkpoint update", () => {
    const pending = reserve(fresh());
    const record = pending.record;
    record.lifecycle.admission = "closing";
    const updated = updateCheckpoint(record, { ...checkpoint, backupId: "backup-next" });
    expect(updated.kind).toBe("versioned");
    if (updated.kind === "versioned") {
      expect(updated.record.lifecycle).toEqual(record.lifecycle);
      expect(updated.record.owner).toEqual(checkpoint.owner);
      expect(updated.record.doorOrigin).toBe(checkpoint.doorOrigin);
    }
    expect(readOperation(record, pending.selector)).toBe("admitted");
  });
  it("holds changed owner or origin and does not mint a missing birth", () => {
    expect(
      updateCheckpoint(fresh(), {
        ...checkpoint,
        owner: { ...checkpoint.owner, container: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      }).kind,
    ).toBe("unknown");
    expect(updateCheckpoint(fresh(), { ...checkpoint, doorOrigin: "https://changed.test" }).kind).toBe("unknown");
    const pending = fresh();
    delete pending.owner;
    pending.lifecycle.binding = "pending";
    expect(updateCheckpoint(pending, checkpoint).kind).toBe("unknown");
  });
  it("does not accept structural equality caller booleans or terminal status as canonical authority", () => {
    for (const target of ["bound", "closing", "closed", "retired"] as const)
      expect(requestAuthorityTransition(fresh(), target)).toEqual({
        kind: "held",
        reason: "canonical-receipt-unavailable",
      });
    expect(requestAuthorityTransition({ ...fresh(), terminal: true }, "retired").kind).toBe("held");
  });
  it("rejects reopening and new admission from an already closing or closed record", () => {
    for (const admission of ["closing", "closed"] as const) {
      const record = fresh();
      record.lifecycle.admission = admission;
      expect(requestAuthorityTransition(record, "open")).toEqual({ kind: "held", reason: "reopen-forbidden" });
      expect(reserveOperation(record, owner, "warm-up").kind).toBe("held");
    }
  });
});

describe("sandbox operation window", () => {
  it("a delayed duplicate cannot settle a different operation after its ring slot is reused", () => {
    let record = fresh();
    const selectors: OperationSelector[] = [];
    for (let i = 0; i < 16; i++) {
      const next = reserve(record);
      record = next.record;
      selectors.push(next.selector);
    }
    record = complete(record, selectors[0]!);
    const later = reserve(record);
    expect(later.selector.ordinal).toBe(17);
    const duplicate = recordOperationOutcome(later.record, selectors[0]!, {
      kind: "warm-up",
      outcome: { kind: "succeeded" },
    });
    expect(duplicate.kind).toBe("unchanged");
    expect(changed(duplicate)).toEqual(later.record);
    expect(readOperation(later.record, later.selector)).toBe("admitted");
  });

  it("refuses malformed selectors and retains malformed or generic callback outcomes", () => {
    const next = reserve(fresh());
    for (const value of [
      null,
      {},
      { ...next.selector, ordinal: -1 },
      { ...next.selector, ordinal: Number.MAX_SAFE_INTEGER + 1 },
      { ...next.selector, permitsDestroy: true },
    ]) {
      expect(readOperation(next.record, value as OperationSelector)).toBe("held");
    }
    for (const value of [
      null,
      { kind: "warm-up", outcome: null },
      { fulfilled: true },
      { kind: "warm-up", outcome: { kind: "succeeded", physicalSettled: true } },
    ]) {
      const result = recordOperationOutcome(
        next.record,
        next.selector,
        value as Parameters<typeof recordOperationOutcome>[2],
      );
      expect(readOperation(changed(result), next.selector)).toBe("unknown");
      expect(requestAuthorityTransition(changed(result), "retired").kind).toBe("held");
    }
  });
  it("reserves sixteen slots and refuses the seventeenth before any effect", () => {
    let record = fresh();
    const effect = vi.fn();
    for (let i = 0; i < 16; i++) {
      const result = reserve(record);
      record = result.record;
      effect();
    }
    const before = structuredClone(record);
    expect(reserveOperation(record, owner, "warm-up")).toEqual({ kind: "held", reason: "window-full" });
    expect(effect).toHaveBeenCalledTimes(16);
    expect(record).toEqual(before);
    expect(record.lifecycle.operationWindow.slots).toHaveLength(16);
  });
  it("matches exact generation actor allocation run and callback ordinal before changing debt", () => {
    const result = reserve(fresh());
    const foreign = [
      { ...owner, ownerGen: "foreign" },
      { ...owner, actorId: "b".repeat(64) },
      { ...owner, allocationKey: "other" },
      { ...owner, runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
    ];
    for (const identity of foreign) {
      expect(reserveOperation(result.record, identity, "warm-up").kind).toBe("held");
      expect(
        recordOperationOutcome(
          result.record,
          { ...identity, ordinal: 1 },
          { kind: "warm-up", outcome: { kind: "succeeded" } },
        ).kind,
      ).toBe("held");
    }
    expect(
      recordOperationOutcome(
        result.record,
        { ...owner, ordinal: 2 },
        { kind: "warm-up", outcome: { kind: "succeeded" } },
      ).kind,
    ).toBe("held");
    expect(readOperation(result.record, result.selector)).toBe("admitted");
  });
  it("advances only a contiguous settled prefix and then reuses the fixed ring", () => {
    let record = fresh();
    const selectors: OperationSelector[] = [];
    for (let i = 0; i < 16; i++) {
      const next = reserve(record);
      record = next.record;
      selectors.push(next.selector);
    }
    record = complete(record, selectors[1]!);
    expect(record.lifecycle.operationWindow.settledThrough).toBe(0);
    expect(reserveOperation(record, owner, "warm-up").kind).toBe("held");
    record = complete(record, selectors[0]!);
    expect(record.lifecycle.operationWindow.settledThrough).toBe(2);
    const next = reserve(record);
    expect(next.selector.ordinal).toBe(17);
    expect(next.record.lifecycle.operationWindow.slots).toHaveLength(16);
    expect(readOperation(next.record, selectors[0]!)).toBe("settled");
  });
  it("reads a lost mutation acknowledgment without replaying an effect or settlement", () => {
    const result = reserve(fresh());
    const effect = vi.fn();
    effect();
    const landed = complete(result.record, result.selector);
    expect(readOperation(landed, result.selector)).toBe("settled");
    expect(
      recordOperationOutcome(landed, result.selector, { kind: "warm-up", outcome: { kind: "succeeded" } }).kind,
    ).toBe("unchanged");
    expect(effect).toHaveBeenCalledOnce();
    expect(landed.lifecycle.operationWindow.settledThrough).toBe(1);
  });
  it("keeps unknown debt after timeout abort rejection and an unsupported fulfilled promise", () => {
    const outcomes = [
      { kind: "unknown", cause: "caller-timeout" },
      { kind: "unknown", cause: "caller-abort" },
      { kind: "warm-up", outcome: { kind: "failed", error: new Error("SDK refused") } },
      { kind: "unsupported" },
    ] as const;
    for (const outcome of outcomes) {
      const result = reserve(fresh());
      const held = changed(recordOperationOutcome(result.record, result.selector, outcome));
      expect(readOperation(held, result.selector)).toBe("unknown");
      expect(
        recordOperationOutcome(held, result.selector, { kind: "warm-up", outcome: { kind: "succeeded" } }).kind,
      ).toBe("held");
      expect(held.lifecycle.operationWindow.settledThrough).toBe(0);
    }
  });
  it("does not classify a warm-up result as process or stream completion", () => {
    for (const operation of ["sdk", "process", "stream"] as const) {
      const result = reserve(fresh(), operation);
      const held = changed(
        recordOperationOutcome(result.record, result.selector, { kind: "warm-up", outcome: { kind: "succeeded" } }),
      );
      expect(readOperation(held, result.selector)).toBe("unknown");
    }
  });
  it("retains reset-lost debt and rejects late callbacks from the old promise", () => {
    const result = reserve(fresh());
    const reset = changed(holdResetOperations(result.record, owner));
    expect(readOperation(reset, result.selector)).toBe("unknown");
    expect(
      recordOperationOutcome(reset, result.selector, { kind: "warm-up", outcome: { kind: "succeeded" } }).kind,
    ).toBe("held");
    expect(changed(holdResetOperations(reset, owner))).toEqual(reset);
  });
  it("enrolls a detached child separately before parent completion and refuses a full child window synchronously", () => {
    const parent = reserve(fresh(), "sdk");
    const child = reserve(parent.record, "warm-up", parent.selector.ordinal);
    expect(child.record.lifecycle.operationWindow.issuedThrough).toBe(2);
    expect(readOperation(child.record, child.selector)).toBe("admitted");
    let record = child.record;
    for (let i = 2; i < 16; i++) record = reserve(record).record;
    const effect = vi.fn();
    const answer = reserveOperation(record, owner, "warm-up", parent.selector.ordinal);
    if (answer.kind === "reserved") effect();
    expect(answer).toEqual({ kind: "held", reason: "window-full" });
    expect(effect).not.toHaveBeenCalled();
  });
  it("rejects absent or completed parent scopes and lets only an admitted parent continue while closing", () => {
    const parent = reserve(fresh(), "warm-up");
    const closing = structuredClone(parent.record);
    closing.lifecycle.admission = "closing";
    expect(reserveOperation(closing, owner, "warm-up", parent.selector.ordinal).kind).toBe("reserved");
    expect(reserveOperation(closing, owner, "warm-up", 2).kind).toBe("held");
    const done = complete(parent.record, parent.selector);
    expect(reserveOperation(done, owner, "warm-up", parent.selector.ordinal).kind).toBe("held");
    closing.lifecycle.admission = "closed";
    expect(reserveOperation(closing, owner, "warm-up", parent.selector.ordinal).kind).toBe("held");
  });
  it("refuses ordinal overflow and malformed ring gaps", () => {
    const exhausted = fresh();
    exhausted.lifecycle.operationWindow.issuedThrough = Number.MAX_SAFE_INTEGER;
    exhausted.lifecycle.operationWindow.settledThrough = Number.MAX_SAFE_INTEGER;
    expect(reserveOperation(exhausted, owner, "warm-up")).toEqual({ kind: "held", reason: "ordinal-exhausted" });
    const broken = reserve(fresh()).record;
    broken.lifecycle.operationWindow.slots[0] = null;
    expect(decodeLifecycle(broken).kind).toBe("unknown");
  });
  it("retains an out-of-order completed child while its parent remains unknown", () => {
    const parent = reserve(fresh(), "sdk");
    const child = reserve(parent.record, "warm-up", parent.selector.ordinal);
    const childDone = complete(child.record, child.selector);
    const held = changed(
      recordOperationOutcome(childDone, parent.selector, { kind: "unknown", cause: "caller-timeout" }),
    );
    expect(readOperation(held, child.selector)).toBe("settled");
    expect(readOperation(held, parent.selector)).toBe("unknown");
    expect(held.lifecycle.operationWindow.settledThrough).toBe(0);
    expect(requestAuthorityTransition(held, "retired").kind).toBe("held");
  });
});
