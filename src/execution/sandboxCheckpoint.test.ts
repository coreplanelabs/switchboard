import { describe, expect, it, vi } from "vitest";
import {
  CHECKPOINT_TTL_SECONDS,
  checkpointIfSafe,
  parsePreservationOwner,
  passivePreservationReceipt,
  preservationReceipt,
  type PreservationOwner,
} from "./sandboxCheckpoint.js";
import { IDLE_DAYS_MAX } from "../core/budgets.js";

const owner: PreservationOwner = {
  run: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  requester: "slack:requester",
  thread: "slack:C1:1.0",
  repository: "owner/repo",
  ref: "work/example/u1",
  head: "a".repeat(40),
  seed: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  container: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
};

function host() {
  const backup = vi.fn(async (_options: { dir: string; gitignore: false; ttl: number }) => ({ id: "backup-id" }));
  const save = vi.fn(async (_id: string, _bound: PreservationOwner) => {});
  const verify = vi.fn(async (_id: string) => true);
  const currentOwner = vi.fn(async () => owner);
  return { safeQuiescence: vi.fn(async () => true), backup, save, verify, currentOwner };
}

describe("checkpointIfSafe", () => {
  it("backs up the complete checkout for longer than the Ship idle window", async () => {
    const f = host();
    expect(await checkpointIfSafe(owner, f)).toBe(true);
    expect(f.backup).toHaveBeenCalledWith({
      dir: "/workspace/checkout",
      gitignore: false,
      ttl: CHECKPOINT_TTL_SECONDS,
    });
    expect(CHECKPOINT_TTL_SECONDS).toBeGreaterThan(IDLE_DAYS_MAX * 24 * 60 * 60);
    expect(f.verify).toHaveBeenCalledWith("backup-id");
    expect(f.save).toHaveBeenCalledWith("backup-id", owner);
  });

  it("retains when backup fails or the owner or incarnation changes", async () => {
    const f = host();
    f.backup.mockRejectedValueOnce(new Error("upload failed"));
    expect(await checkpointIfSafe(owner, f)).toBe(false);
    expect(f.save).not.toHaveBeenCalled();
    f.currentOwner.mockResolvedValueOnce({ ...owner, container: crypto.randomUUID() });
    expect(await checkpointIfSafe(owner, f)).toBe(false);
    expect(f.save).not.toHaveBeenCalled();
    f.verify.mockResolvedValueOnce(false);
    expect(await checkpointIfSafe(owner, f)).toBe(false);
    expect(f.save).not.toHaveBeenCalled();
    f.safeQuiescence.mockResolvedValueOnce(false);
    expect(await checkpointIfSafe(owner, f)).toBe(false);
  });
});

describe("preservationReceipt", () => {
  it("rejects malformed identities and arbitrary file or command fields", () => {
    expect(parsePreservationOwner(owner)).toEqual(owner);
    for (const extra of ["path", "command", "env"]) {
      expect(parsePreservationOwner({ ...owner, [extra]: "/workspace/checkout" })).toBeNull();
    }
    expect(parsePreservationOwner({ ...owner, head: "main" })).toBeNull();
    expect(parsePreservationOwner({ ...owner, requester: "other" })).toBeNull();
  });

  it("a stopped-container receipt reads only durable facts and never wakes or starts replacement work", async () => {
    const readRecord = vi.fn(async () => ({ owner, backupId: "backup-id" }));
    const head = vi.fn(async () => true);
    expect(await passivePreservationReceipt(owner, readRecord, head)).toEqual({ state: "present" });
    expect(readRecord).toHaveBeenCalledOnce();
    expect(head).toHaveBeenCalledWith("backup-id");
    // The seam takes no container, gate or SDK argument at all; the Worker
    // wiring test checks that the route obtains only a raw DO storage stub.
    expect(await passivePreservationReceipt({ ...owner, run: crypto.randomUUID() }, readRecord, head)).toEqual({
      state: "unknown",
    });
    expect(head).toHaveBeenCalledOnce();
  });
  const record = { owner, backupId: "backup-id" };
  it("refuses every wrong owner or incarnation without disclosing a checkpoint", () => {
    for (const key of Object.keys(owner) as (keyof PreservationOwner)[]) {
      expect(preservationReceipt({ ...owner, [key]: "different" }, record, true)).toEqual({ state: "unknown" });
    }
    expect(preservationReceipt(owner, null, true)).toEqual({ state: "unknown" });
  });

  it("distinguishes present lost and unknown without reading checkout contents", () => {
    expect(preservationReceipt(owner, record, true)).toEqual({ state: "present" });
    expect(preservationReceipt(owner, record, false)).toEqual({ state: "lost" });
    expect(preservationReceipt(owner, { owner }, false)).toEqual({ state: "unknown" });
    expect(preservationReceipt(owner, { owner }, true)).toEqual({ state: "unknown" });
  });
});
