import { describe, expect, it } from "vitest";
import { reserveUid, uidOwner, issuedUidCount, resetUidGeneration, claimUid, uidLedger } from "./uidOwnership";

function store(legacy: unknown = []) {
  const rows = new Map<string, unknown>([["resident:spentPoolUsers", legacy]]);
  const tx = {
    get: async (key: string) => structuredClone(rows.get(key)),
    put: async (key: string, value: unknown) => {
      rows.set(key, structuredClone(value));
    },
    list: async ({ prefix, startAfter = "", limit }: { prefix: string; startAfter?: string; limit: number }) =>
      new Map(
        [...rows]
          .filter(([key]) => key.startsWith(prefix) && key > startAfter)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit),
      ),
  } as any;
  return { tx, rows };
}

describe("indexed resident UID ownership", () => {
  it("reserves fresh identities beyond 250 owners and reuses only the exact owner", async () => {
    const { tx } = store();
    for (let i = 0; i < 251; i++) await reserveUid(tx, `thread:t${i}`);
    expect(await reserveUid(tx, "thread:next")).toBe("worker285");
    expect(await reserveUid(tx, "thread:t0")).toBe("worker34");
    expect(await uidOwner(tx, "worker34")).toBe("thread:t0");
    expect(await uidOwner(tx, "worker285")).toBe("thread:next");
    expect(await issuedUidCount(tx)).toBe(252);
  });

  it("does not treat an empty legacy ledger as proof that precreated OS identities are fresh", async () => {
    const { tx } = store([]);
    expect(await reserveUid(tx, "thread:new")).toBe("worker34");
    expect(await uidOwner(tx, "worker2")).toBeNull();
    expect(await uidOwner(tx, "worker34")).toBe("thread:new");
    expect(await issuedUidCount(tx)).toBe(1);
  });

  it("preserves legacy ownership without assigning an old identity to a new owner", async () => {
    const { tx, rows } = store([{ user: "worker33", owner: "thread:old" }]);
    expect(await reserveUid(tx, "thread:new")).toBe("worker34");
    expect(await reserveUid(tx, "thread:old")).toBe("worker33");
    expect(rows.get("resident:spentPoolUsers")).toEqual([{ user: "worker33", owner: "thread:old" }]);
    expect(await uidOwner(tx, "worker33")).toBe("thread:old");
    expect(await issuedUidCount(tx)).toBe(2);
  });

  it("refuses missing or corrupt ownership rather than inventing an empty generation", async () => {
    const { tx, rows } = store();
    rows.delete("resident:spentPoolUsers");
    await expect(reserveUid(tx, "thread:a")).rejects.toThrow("UID generation is unverified");
    await resetUidGeneration(tx);
    expect(await reserveUid(tx, "thread:a")).toBe("worker2");
    rows.set("uid:state", { generation: "broken", next: 1, issued: 0 });
    await expect(reserveUid(tx, "thread:b")).rejects.toThrow("UID generation is unverified");
  });

  it("retains old evidence after a confirmed caller rotates the VM generation", async () => {
    const { tx, rows } = store();
    expect(await reserveUid(tx, "thread:old")).toBe("worker34");
    const before = structuredClone(rows.get("uid:state")) as { generation: string };
    await resetUidGeneration(tx);
    expect(await reserveUid(tx, "thread:new")).toBe("worker35");
    expect(await uidOwner(tx, "worker35")).toBe("thread:new");
    expect(rows.get(`uid:${before.generation}:user:worker34`)).toBe("thread:old");
    expect(await issuedUidCount(tx)).toBe(1);
  });

  it("reserves beyond surviving live bindings after a confirmed VM recreation", async () => {
    const { tx, rows } = store([{ user: "worker2", owner: "thread:old" }]);
    expect(await reserveUid(tx, "thread:old")).toBe("worker2");
    rows.set("thread:old", { threadKey: "old", user: "worker2", evicted: false });
    rows.set("thread:unindexed", { threadKey: "unindexed", user: "worker99", evicted: false });
    await resetUidGeneration(tx);
    expect(await reserveUid(tx, "thread:new")).toBe("worker100");
    expect(await claimUid(tx, "worker2", "thread:old")).toBe(true);
    expect(await uidOwner(tx, "worker100")).toBe("thread:new");
    expect(await uidOwner(tx, "worker2")).toBe("thread:old");
    expect(await issuedUidCount(tx)).toBe(2);
  });

  it("claims a missing legacy identity without borrowing another owner's account", async () => {
    const { tx } = store();
    expect(await claimUid(tx, "worker33", "thread:old")).toBe(true);
    expect(await claimUid(tx, "worker33", "thread:new")).toBe(false);
    expect(await reserveUid(tx, "thread:new")).toBe("worker34");
    expect(await uidLedger(tx)).toEqual(
      new Map([
        ["worker33", "thread:old"],
        ["worker34", "thread:new"],
      ]),
    );
  });
});
