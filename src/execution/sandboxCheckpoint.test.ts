import { describe, expect, it, vi } from "vitest";
import {
  boundSeedMarkerDecision,
  CHECKPOINT_TTL_SECONDS,
  checkpointIfSafe,
  seedClaimHeadMatches,
  parsePreservationOwner,
  normalizedSeedDoorOrigin,
  boundSeedOriginMatches,
  passivePreservationReceipt,
  passiveSlotEvidence,
  parseSlotEvidenceRequest,
  preservationReceipt,
  type PreservationOwner,
} from "./sandboxCheckpoint.js";
import { IDLE_DAYS_MAX } from "../core/budgets.js";
import { IdleGuard, SANDBOX_SLEEP_AFTER_MS, type IdleGuardHost } from "./sandboxIdle.js";

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

describe("trusted seed door origin", () => {
  it("normalizes only a credential-free HTTPS origin, not a URL with a path or secrets", () => {
    expect(normalizedSeedDoorOrigin("https://DOOR.example:443/")).toBe("https://door.example");
    expect(normalizedSeedDoorOrigin("https://door.example:8443/")).toBe("https://door.example:8443");
    for (const url of [
      "",
      "http://door.example",
      "https://user:bearer@door.example",
      "https://door.example/git",
      "https://door.example/?q=x",
      "https://door.example/#x",
      "https://door.example\\n.evil",
    ]) {
      expect(normalizedSeedDoorOrigin(url)).toBeNull();
    }
  });

  it("refuses changed or missing origin on exact cached owner; an old record cannot be upgraded", () => {
    expect(boundSeedOriginMatches("https://door.example", "https://DOOR.example/")).toBe(true);
    expect(boundSeedOriginMatches("https://door.example", "https://other.example")).toBe(false);
    expect(boundSeedOriginMatches("https://door.example", "")).toBe(false);
    expect(boundSeedOriginMatches(undefined, "https://door.example")).toBe(false);
  });
});

describe("seedClaimHeadMatches", () => {
  it("accepts a bound owner's cached seed after a commit advances checkout HEAD", () => {
    expect(seedClaimHeadMatches(owner.head, "d".repeat(40), true)).toBe(true);
    expect(seedClaimHeadMatches(owner.head, owner.head, false)).toBe(true);
  });

  it("accepts a bound owner's cached seed with uncommitted work at the original HEAD", () => {
    expect(seedClaimHeadMatches(owner.head, owner.head, true)).toBe(true);
  });

  it("refuses a fresh seed if fix-up checks out a different HEAD than the claim", () => {
    expect(seedClaimHeadMatches(owner.head, "d".repeat(40), false)).toBe(false);
  });
});

describe("bound seed marker decisions", () => {
  const expected = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb main -";

  it("answers cached for the original marker despite committed or uncommitted workspace changes", () => {
    expect(boundSeedMarkerDecision(expected, expected, true)).toBe("cached");
  });

  it("refuses a bound retry when the writer removes the marker after the pre-check", () => {
    expect(boundSeedMarkerDecision(null, expected, true)).toBe("refuse");
  });

  it("refuses a bound retry when the writer replaces the marker after the pre-check", () => {
    expect(boundSeedMarkerDecision("another seed", expected, true)).toBe("refuse");
  });

  it("allows an unbound fresh seed on a missing or different marker", () => {
    expect(boundSeedMarkerDecision(null, expected, false)).toBe("fresh");
    expect(boundSeedMarkerDecision("different", expected, false)).toBe("fresh");
  });
});

describe("checkpointIfSafe", () => {
  it("never treats sampled pause around checkout upload as complete retirement evidence", async () => {
    const f = host();
    // All three observations see a paused writer. A detached process can
    // still resume and edit the checkout while the directory upload awaits.
    let checkout = "before";
    let uploaded = "";
    f.backup.mockImplementation(async () => {
      uploaded = checkout;
      checkout = "private work after upload began";
      return { id: "backup-id" };
    });
    let now = 0;
    const destroy = vi.fn(async () => {});
    const kill = vi.fn(async () => {});
    const idleHost: IdleGuardHost = {
      now: () => now,
      containerRunning: () => true,
      sweepScheduled: async () => true,
      scheduleSweep: async () => {},
      // Exercise the old direct caller even when it bypasses the type error.
      // The guard must never accept a backup observation as its stop permit.
      beforeDestroy: async () => (await checkpointIfSafe(owner, f)) as unknown as boolean,
      destroySandbox: destroy,
      killContainer: kill,
      loadLastServedAt: async () => undefined,
      saveLastServedAt: async () => {},
      log: () => {},
      wait: async () => {},
    };
    const idle = new IdleGuard(idleHost);
    await idle.wake();
    now = SANDBOX_SLEEP_AFTER_MS;
    await idle.expired();
    expect(checkout).not.toBe(uploaded);
    expect(destroy).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("backs up the complete checkout for longer than the Ship idle window", async () => {
    const f = host();
    expect(await checkpointIfSafe(owner, f)).toEqual({ state: "stored", backupId: "backup-id" });
    expect(f.backup).toHaveBeenCalledWith({
      dir: "/workspace/checkout",
      gitignore: false,
      ttl: CHECKPOINT_TTL_SECONDS,
    });
    expect(CHECKPOINT_TTL_SECONDS).toBeGreaterThan(IDLE_DAYS_MAX * 24 * 60 * 60);
    expect(f.verify).toHaveBeenCalledWith("backup-id");
    expect(f.save).toHaveBeenCalledWith("backup-id", owner);
  });

  it("never snapshots a paused writer without an independent quiescence witness", async () => {
    const f = host();
    f.safeQuiescence.mockResolvedValue(false);
    expect(await checkpointIfSafe(owner, f)).toEqual({ state: "unknown" });
    expect(f.backup).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  it("retains when backup fails or the owner or incarnation changes", async () => {
    const f = host();
    f.backup.mockRejectedValueOnce(new Error("upload failed"));
    expect(await checkpointIfSafe(owner, f)).toEqual({ state: "unknown" });
    expect(f.save).not.toHaveBeenCalled();
    f.currentOwner.mockResolvedValueOnce({ ...owner, container: crypto.randomUUID() });
    expect(await checkpointIfSafe(owner, f)).toEqual({ state: "unknown" });
    expect(f.save).not.toHaveBeenCalled();
    f.verify.mockResolvedValueOnce(false);
    expect(await checkpointIfSafe(owner, f)).toEqual({ state: "unknown" });
    expect(f.save).not.toHaveBeenCalled();
    f.safeQuiescence.mockResolvedValueOnce(false);
    expect(await checkpointIfSafe(owner, f)).toEqual({ state: "unknown" });
  });

  it("retains when ownership changes while an upload is in flight", async () => {
    const f = host();
    f.currentOwner.mockResolvedValueOnce(owner).mockResolvedValueOnce({ ...owner, run: crypto.randomUUID() });
    expect(await checkpointIfSafe(owner, f)).toEqual({ state: "unknown" });
    expect(f.backup).toHaveBeenCalledOnce();
    expect(f.save).not.toHaveBeenCalled();
  });
});

describe("preservationReceipt", () => {
  it("accepts a Git-valid seeded ref with a plus sign in an owner claim", () => {
    expect(parsePreservationOwner({ ...owner, ref: "feature/fix+retry" })).toEqual({
      ...owner,
      ref: "feature/fix+retry",
    });
    expect(parsePreservationOwner({ ...owner, ref: "feature/fix?retry" })).toBeNull();
  });

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

describe("passive slot evidence", () => {
  const claim = (({ container: _container, ...rest }) => rest)(owner);
  const objectId = "d".repeat(64);

  it("reports a matched running owner and complete checkpoint as retained, never as a stop permit", async () => {
    const read = vi.fn(async () => ({
      objectId,
      threadName: owner.thread,
      running: true,
      seedState: "seeded" as const,
      record: { owner, backupId: "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee" },
    }));
    const archive = vi.fn(async () => true);
    expect(await passiveSlotEvidence({ claim, objectId }, read, archive)).toEqual({
      state: "retained",
      objectId,
      birthContainer: owner.container,
      seedState: "seeded",
      checkpoint: "present",
      platformInstance: "unknown",
      liveIncarnation: "unknown",
      exclusiveOwner: "unknown",
      quiescence: "unknown",
      liveCheckout: "unknown",
      reason: "quiescence_and_live_bytes_unproven",
    });
    expect(archive).toHaveBeenCalledWith("eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee");
  });

  it("discloses no owner or checkpoint when the DO, claim, or running state is uncertain", async () => {
    const read = vi.fn(async () => ({
      objectId,
      threadName: owner.thread,
      running: true,
      seedState: "seeded" as "seeded" | "unseeded",
      record: { owner },
    }));
    const archive = vi.fn(async () => true);
    expect(await passiveSlotEvidence({ claim, objectId: "f".repeat(64) }, read, archive)).toEqual({ state: "unknown" });
    expect(
      await passiveSlotEvidence({ claim: { ...claim, run: crypto.randomUUID() }, objectId }, read, archive),
    ).toEqual({ state: "unknown" });
    read.mockResolvedValueOnce({
      objectId,
      threadName: owner.thread,
      running: false,
      seedState: "seeded",
      record: { owner },
    });
    expect(await passiveSlotEvidence({ claim, objectId }, read, archive)).toEqual({ state: "unknown" });
    read.mockResolvedValueOnce({
      objectId,
      threadName: owner.thread,
      running: true,
      seedState: "unseeded",
      record: { owner },
    });
    expect(await passiveSlotEvidence({ claim, objectId }, read, archive)).toEqual({ state: "unknown" });
    expect(archive).not.toHaveBeenCalled();
  });

  it("accepts only the complete claim and DO id, without paths or commands", () => {
    expect(parseSlotEvidenceRequest({ claim, objectId })).toEqual({ claim, objectId });
    expect(parseSlotEvidenceRequest({ claim, objectId, path: "/workspace/checkout" })).toBeNull();
    expect(parseSlotEvidenceRequest({ claim: { ...claim, command: "ps" }, objectId })).toBeNull();
    expect(parseSlotEvidenceRequest({ claim, objectId: "short" })).toBeNull();
  });

  it("keeps a matching owner retained when the R2 checkpoint is missing", async () => {
    const read = async () => ({
      objectId,
      threadName: owner.thread,
      running: true,
      seedState: "seeded" as const,
      record: { owner, backupId: "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee" },
    });
    const result = await passiveSlotEvidence({ claim, objectId }, read, async () => false);
    expect(result).toMatchObject({ state: "retained", checkpoint: "lost", quiescence: "unknown" });
  });
});
