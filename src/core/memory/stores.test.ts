import { describe, expect, it } from "vitest";
import type { MemoryCandidate, MemoryRecord } from "./types.js";
import { InMemoryMemoryStore, NullMemoryStore, selectMemoryStore } from "./stores.js";

// Feature: features/memory.md — the two MemoryStore implementations (AGENTS.md
// invariant 2) and the store selector.

const NOW = 1_700_000_000_000;

function rec(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem:org:coreplanelabs:seed",
    scopeKey: "org:coreplanelabs",
    kind: "fact",
    text: "the deploy command is npm run deploy",
    keywords: ["deploy", "command", "npm"],
    sourceThreadKey: "slack:C1:1.0",
    createdAt: NOW,
    useCount: 0,
    status: "active",
    ...over,
  };
}

describe("NullMemoryStore", () => {
  it("retrieve always returns [] and write is a no-op", async () => {
    const store = new NullMemoryStore();
    expect(await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 })).toEqual([]);
    await expect(
      store.write("org:coreplanelabs", [{ kind: "fact", text: "x", sourceThreadKey: "slack:C1:1.0" }]),
    ).resolves.toBeUndefined();
  });
});

describe("InMemoryMemoryStore.retrieve", () => {
  it("ranks matches keyword-first, recency second", async () => {
    const rMore = rec({
      id: "more",
      createdAt: NOW - 100 * 24 * 60 * 60 * 1000, // old
      keywords: ["deploy", "rollback"],
      text: "deploy then rollback",
    });
    const rFewer = rec({ id: "fewer", createdAt: NOW, keywords: ["deploy"], text: "deploy notes" });
    const store = new InMemoryMemoryStore([rFewer, rMore], { now: () => NOW });
    const out = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy rollback", limit: 8 });
    expect(out.map((r) => r.id)).toEqual(["more", "fewer"]);
  });

  it("returns only records in the requested scope", async () => {
    const mine = rec({ id: "mine", scopeKey: "org:coreplanelabs" });
    const other = rec({ id: "other", scopeKey: "org:other" });
    const store = new InMemoryMemoryStore([mine, other], { now: () => NOW });
    const out = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 });
    expect(out.map((r) => r.id)).toEqual(["mine"]);
  });

  it("drops records the query does not match (relevance gate)", async () => {
    const hit = rec({ id: "hit", text: "deploy is npm run deploy", keywords: ["deploy"] });
    const miss = rec({ id: "miss", text: "vacation policy is 20 days", keywords: ["vacation", "policy"] });
    const store = new InMemoryMemoryStore([hit, miss], { now: () => NOW });
    const out = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 });
    expect(out.map((r) => r.id)).toEqual(["hit"]);
  });

  it("respects the limit", async () => {
    const seed = Array.from({ length: 5 }, (_, i) =>
      rec({ id: `r${i}`, text: `deploy variant ${i}`, keywords: ["deploy"], createdAt: NOW - i }),
    );
    const store = new InMemoryMemoryStore(seed, { now: () => NOW });
    const out = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 2 });
    expect(out).toHaveLength(2);
  });

  it("bumps lastUsedAt and useCount on retrieval", async () => {
    const store = new InMemoryMemoryStore([rec({ id: "r", useCount: 0 })], { now: () => NOW });
    const out = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 });
    expect(out[0].useCount).toBe(1);
    expect(out[0].lastUsedAt).toBe(NOW);
  });
});

describe("InMemoryMemoryStore.write", () => {
  const cand: MemoryCandidate = {
    kind: "fact",
    text: "the deploy command is npm run deploy",
    keywords: ["deploy"],
    sourceThreadKey: "slack:C1:1.0",
  };

  it("inserts a candidate as an active, namespaced record", async () => {
    const store = new InMemoryMemoryStore([], { now: () => NOW });
    await store.write("org:coreplanelabs", [cand]);
    const out = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 });
    expect(out).toHaveLength(1);
    expect(out[0].scopeKey).toBe("org:coreplanelabs");
    expect(out[0].status).toBe("active");
    expect(out[0].createdAt).toBe(NOW);
    expect(out[0].id.startsWith("mem:org:coreplanelabs:")).toBe(true);
  });

  it("dedups an identical candidate (bumps useCount instead of inserting)", async () => {
    const store = new InMemoryMemoryStore([], { now: () => NOW });
    await store.write("org:coreplanelabs", [cand]); // insert, useCount 0
    await store.write("org:coreplanelabs", [cand]); // dedup, useCount 1
    const out = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 });
    expect(out).toHaveLength(1); // not duplicated
    expect(out[0].useCount).toBe(2); // 1 from the dup write + 1 from this retrieval
  });
});

describe("selectMemoryStore", () => {
  it("returns a NullMemoryStore when memory is disabled or config is absent", () => {
    expect(selectMemoryStore(undefined)).toBeInstanceOf(NullMemoryStore);
    expect(selectMemoryStore({ enabled: false })).toBeInstanceOf(NullMemoryStore);
  });
  it("returns the injected store when enabled", () => {
    const injected = new InMemoryMemoryStore();
    expect(selectMemoryStore({ enabled: true }, injected)).toBe(injected);
  });
  it("falls back to a fresh InMemoryMemoryStore when enabled with nothing injected", () => {
    expect(selectMemoryStore({ enabled: true })).toBeInstanceOf(InMemoryMemoryStore);
  });
});
