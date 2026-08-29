import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "./types.js";
import { InMemoryMemoryStore, NullMemoryStore } from "./stores.js";
import { memoryContextBlock } from "./index.js";

// Feature: features/memory.md — the dispatcher-facing read path that ties the
// store, scope deriver, budget, and renderer together.

const NOW = 1_700_000_000_000;

function rec(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem:org:coreplanelabs:1",
    scopeKey: "org:coreplanelabs",
    kind: "fact",
    text: "deploy is npm run deploy",
    keywords: ["deploy"],
    sourceThreadKey: "slack:C1:1.0",
    createdAt: NOW,
    useCount: 0,
    status: "active",
    ...over,
  };
}

describe("memoryContextBlock", () => {
  it("returns undefined when memory is disabled (even with a seeded store injected)", async () => {
    const seeded = new InMemoryMemoryStore([rec()], { now: () => NOW });
    expect(await memoryContextBlock(undefined, seeded, "deploy")).toBeUndefined();
    expect(await memoryContextBlock({ enabled: false }, seeded, "deploy")).toBeUndefined();
  });

  it("returns undefined when enabled with a NullMemoryStore", async () => {
    expect(await memoryContextBlock({ enabled: true }, new NullMemoryStore(), "deploy")).toBeUndefined();
  });

  it("returns undefined when enabled but nothing matches the query", async () => {
    const seeded = new InMemoryMemoryStore([rec()], { now: () => NOW });
    expect(await memoryContextBlock({ enabled: true }, seeded, "unrelated question")).toBeUndefined();
  });

  it("renders the advisory block when enabled with matching records", async () => {
    const seeded = new InMemoryMemoryStore([rec({ text: "prefers squashed history", keywords: ["squash", "history"] })], {
      now: () => NOW,
    });
    const block = await memoryContextBlock({ enabled: true }, seeded, "squash history please");
    expect(block).toBeDefined();
    expect(block!.split("\n")[0]).toBe(
      "Background memory for org:coreplanelabs (may be outdated — verify before acting):",
    );
    expect(block).toContain("prefers squashed history");
  });

  it("honors the configured record limit", async () => {
    const seed = Array.from({ length: 6 }, (_, i) =>
      rec({ id: `r${i}`, text: `deploy note ${i}`, keywords: ["deploy"], createdAt: NOW - i }),
    );
    const seeded = new InMemoryMemoryStore(seed, { now: () => NOW });
    const block = await memoryContextBlock({ enabled: true, limit: 2 }, seeded, "deploy");
    const bullets = block!.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(2);
  });
});

// Feature: features/memory.md (#107 PR B) — user-scoped memory on the read
// path: org + the requesting user's records, never another user's.
describe("memoryContextBlock — user scope (#107 PR B)", () => {
  const orgRec = rec({ id: "mem:org:coreplanelabs:1", text: "deploy is npm run deploy", keywords: ["deploy"] });
  const u1Rec = rec({
    id: "mem:user:slack:U1:0",
    scopeKey: "user:slack:U1",
    text: "prefers deploy previews before prod",
    keywords: ["deploy", "preview"],
  });
  const u2Rec = rec({
    id: "mem:user:slack:U2:0",
    scopeKey: "user:slack:U2",
    text: "never deploy on fridays",
    keywords: ["deploy", "friday"],
  });

  it("returns org records plus the requesting user's own records", async () => {
    const store = new InMemoryMemoryStore([orgRec, u1Rec, u2Rec], { now: () => NOW });
    const block = await memoryContextBlock({ enabled: true }, store, "deploy", "slack:U1");
    expect(block).toContain("deploy is npm run deploy");
    expect(block).toContain("prefers deploy previews before prod");
    expect(block).not.toContain("never deploy on fridays");
  });

  it("never surfaces another user's records", async () => {
    const store = new InMemoryMemoryStore([u1Rec, u2Rec], { now: () => NOW });
    const block = await memoryContextBlock({ enabled: true }, store, "deploy", "slack:U2");
    expect(block).toContain("never deploy on fridays");
    expect(block).not.toContain("prefers deploy previews");
  });

  it("names both scopes in the block prefix", async () => {
    const store = new InMemoryMemoryStore([orgRec], { now: () => NOW });
    const block = await memoryContextBlock({ enabled: true }, store, "deploy", "slack:U1");
    expect(block!.split("\n")[0]).toBe(
      "Background memory for org:coreplanelabs + user:slack:U1 (may be outdated — verify before acting):",
    );
  });

  it("without a user id reads org only (no user bucket is touched)", async () => {
    const store = new InMemoryMemoryStore([orgRec, u1Rec], { now: () => NOW });
    const block = await memoryContextBlock({ enabled: true }, store, "deploy");
    expect(block!.split("\n")[0]).toBe("Background memory for org:coreplanelabs (may be outdated — verify before acting):");
    expect(block).not.toContain("prefers deploy previews");
  });

  it("ranks the merged set across scopes and applies limit + token budget to the one pool", async () => {
    const seed = [
      ...Array.from({ length: 5 }, (_, i) => rec({ id: `o${i}`, text: `deploy org note ${i}`, keywords: ["deploy"] })),
      ...Array.from({ length: 5 }, (_, i) =>
        rec({ id: `u${i}`, scopeKey: "user:slack:U1", text: `deploy preview user note ${i}`, keywords: ["deploy", "preview"] }),
      ),
    ];
    const store = new InMemoryMemoryStore(seed, { now: () => NOW });
    const block = await memoryContextBlock({ enabled: true, limit: 3 }, store, "deploy preview", "slack:U1");
    const bullets = block!.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(3);
    // Both query tokens hit the user notes, one hits the org notes → the user
    // notes outrank across the scope boundary; the limit is not per scope.
    expect(bullets.every((b) => b.includes("user note"))).toBe(true);
  });
});
