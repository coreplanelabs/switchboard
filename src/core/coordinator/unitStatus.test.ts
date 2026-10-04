import { seedCoordinatorInstance, seedCoordinatorUnit } from "../testing/coordinatorInstance.js";
import { describe, expect, it, vi } from "vitest";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { contextThreadSessionKey } from "../runLedger/sessionLog.js";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { appendCoordinatorStatus, readCoordinatorStatus } from "./unitStatus.js";
import { freezeCoordinatorReport } from "./reportContext.js";

export function statusFixture() {
  const ledger = new InMemoryRunLedger();
  const instances = new InMemoryCoordinatorInstanceStore(ledger);
  const instance: CoordinatorInstance = {
    id: "plan-status",
    kind: "ship",
    runId: "host",
    userId: "cli:user",
    channelId: "cli:main",
    threadKey: "cli:main:1",
    repo: "acme/api",
    branch: "plan/status/u1",
    merge: "person",
    plan: { id: "status" },
    createdAt: 1,
  };
  const unit: CoordinatorUnit = {
    instanceId: instance.id,
    unit: "U11",
    slug: "u1",
    branch: instance.branch,
    dependsOn: [],
    rounds: [],
    threadKey: instance.threadKey,
    ending: {
      kind: "stopped",
      at: 2,
      report: "SECRET RAW EXCEPTION",
      outcome: { schemaVersion: 1, kind: "stopped", reviewRounds: 0 },
    },
  };
  const owner = {
    instanceId: instance.id,
    unit: unit.unit,
    attempt: 0,
    requester: instance.userId,
    channelId: instance.channelId,
    threadKey: instance.threadKey,
    deliveryId: "U11/0/end",
  };
  return { ledger, instances, instance, unit, owner };
}

describe("committed coordinator status context", () => {
  it.each(["first", "cached"] as const)(
    "refuses a mixed owner snapshot before the %s status acknowledgement",
    async (receipt) => {
      const f = statusFixture();
      f.unit.ending = { kind: "stopped", at: 2, report: "Original report" };
      await f.instances.put(f.instance);
      await f.instances.putUnits([f.unit]);
      if (receipt === "cached") expect(await appendCoordinatorStatus(f, f)).toBeDefined();
      const list = f.instances.listUnits.bind(f.instances);
      vi.spyOn(f.instances, "listUnits").mockImplementationOnce(async (id) => {
        const units = await list(id);
        seedCoordinatorInstance(f.instances, {
          ...f.instance,
          userId: "cli:another-user",
          runId: "another-run",
          attempt: 1,
        });
        await f.instances.putUnits(units);
        return units;
      });
      const append = vi.spyOn(f.ledger, "appendSession");
      expect(await appendCoordinatorStatus(f, f)).toBeUndefined();
      expect(append).not.toHaveBeenCalled();
    },
  );

  it("retains only a committed typed projection beside an unreadable raw report", async () => {
    const f = statusFixture();
    await f.instances.put(f.instance);
    await f.instances.putUnits([f.unit]);
    await freezeCoordinatorReport(f.ledger, f.owner, { text: "SECRET RAW EXCEPTION", threadText: "SECRET" });
    const ref = await appendCoordinatorStatus(f, f);
    expect(ref).toBeDefined();
    const tail = await f.ledger.readSessionTail(contextThreadSessionKey(f.instance.threadKey), 100_000);
    expect(tail.transcript.contexts?.map((c) => c?.status)).toEqual(["unknown", "known"]);
    const status = await readCoordinatorStatus(f.ledger, ref!);
    expect(status?.status).toEqual({ state: "recorded", kind: "stopped" });
    expect(JSON.stringify(status)).not.toContain("SECRET");
    expect(tail.transcript.messages.at(-1)?.content).toEqual([
      { type: "text", text: expect.stringContaining("Recorded work status") },
    ]);
    expect(
      await readCoordinatorStatus(f.ledger, Object.fromEntries(Object.entries(ref!).reverse()) as typeof ref & {}),
    ).toEqual(status);
  });
  it("cannot certify a proposed status or replace an original delivery with a later recovery", async () => {
    const f = statusFixture();
    await f.instances.put(f.instance);
    await f.instances.putUnits([f.unit]);
    const uncommitted = {
      ...f.unit,
      ending: {
        ...f.unit.ending!,
        kind: "merged",
        outcome: { schemaVersion: 1 as const, kind: "merged" as const, reviewRounds: 0 },
      },
    };
    expect(await appendCoordinatorStatus(f, { ...f, unit: uncommitted })).toBeUndefined();
    const original = await appendCoordinatorStatus(f, f);
    const later = {
      ...f.unit,
      ending: {
        ...f.unit.ending!,
        report: "different private text",
        at: 3,
        outcome: { schemaVersion: 1 as const, kind: "stopped" as const, reviewRounds: 1 },
      },
    };
    await f.instances.compareAndReplaceUnit(f.unit, later);
    expect(await appendCoordinatorStatus(f, { ...f, unit: later })).toEqual(original);
    expect((await readCoordinatorStatus(f.ledger, original!))?.observedAt).toBe(2);
  });
  it("leaves unknown producer outcomes unverified and excludes an unbound PR URL", async () => {
    const f = statusFixture();
    f.unit.ending = { kind: "arbitrary private kind", report: "SECRET", at: 2 };
    f.unit.pr = { number: 9, url: "https://example.invalid/secret" };
    await f.instances.put(f.instance);
    await f.instances.putUnits([f.unit]);
    const ref = await appendCoordinatorStatus(f, f);
    const saved = await readCoordinatorStatus(f.ledger, ref!);
    expect(saved?.status).toEqual({ state: "unverified" });
    expect(saved?.pr).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain("arbitrary");
    expect(await readCoordinatorStatus(f.ledger, { ...ref!, snapshotHash: "a".repeat(64) })).toBeUndefined();
  });
  it("keeps legacy delivery labels out of the reusable status text", async () => {
    const f = statusFixture();
    f.owner.deliveryId = "legacy-end:SECRET error detail";
    await f.instances.put(f.instance);
    await f.instances.putUnits([f.unit]);
    expect(await appendCoordinatorStatus(f, f)).toBeDefined();
    const tail = await f.ledger.readSessionTail(contextThreadSessionKey(f.instance.threadKey), 100_000);
    expect(JSON.stringify(tail.transcript.messages)).not.toContain("SECRET");
  });
  it("includes only a PR pointer bound to the committed terminal outcome", async () => {
    const f = statusFixture();
    f.unit.pr = { number: 9, url: "https://github.com/acme/api/pull/9" };
    f.unit.ending = {
      kind: "merged",
      at: 2,
      report: "SECRET",
      outcome: {
        schemaVersion: 1,
        kind: "merged",
        reviewRounds: 1,
        terminalPr: { state: "merged", ...f.unit.pr, mergeSha: "a".repeat(40) },
      },
    };
    await f.instances.put(f.instance);
    seedCoordinatorUnit(f.instances, f.unit);
    const ref = await appendCoordinatorStatus(f, f);
    expect(ref).toBeDefined();
    expect(await readCoordinatorStatus(f.ledger, ref!)).toMatchObject({
      status: { state: "recorded", kind: "merged" },
      pr: f.unit.pr,
    });
  });
  it("skips unproved bindings but fails if an admitted status cannot be stored", async () => {
    const f = statusFixture();
    await f.instances.put(f.instance);
    await f.instances.putUnits([f.unit]);
    expect(await appendCoordinatorStatus(f, { ...f, owner: { ...f.owner, threadKey: "cli:other:1" } })).toBeUndefined();
    vi.spyOn(f.ledger, "appendSession").mockResolvedValue({ ok: false, reason: "source-unavailable" } as never);
    await expect(appendCoordinatorStatus(f, f)).rejects.toThrow("could not be saved");
  });
});
