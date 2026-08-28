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
