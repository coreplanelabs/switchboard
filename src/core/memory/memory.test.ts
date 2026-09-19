import { describe, expect, it, vi } from "vitest";
import type { Provider } from "../provider.js";
import { authorize } from "../authz/index.js";
import type { MemoryRecord, MemoryStore } from "./types.js";
import { InMemoryMemoryStore, NullMemoryStore } from "./stores.js";
import { memoryContextBlock, reflect } from "./index.js";
import { createTracer } from "../trace/tracer.js";

// The one authorization entry point, spied so the read-path test below can
// prove it is never consulted (the write gate is reflection's alone: reads are unchanged).
vi.mock("../authz/index.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../authz/index.js")>();
  return { ...mod, authorize: vi.fn(mod.authorize) };
});

// Feature: docs/reference/specs/memory.md — the dispatcher-facing read path that ties the
// store, scope deriver, budget, and renderer together.

const NOW = 1_700_000_000_000;

function rec(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem:org:acme:1",
    scopeKey: "org:acme",
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
    expect(await memoryContextBlock("acme", undefined, seeded, "deploy")).toBeUndefined();
    expect(await memoryContextBlock("acme", { enabled: false }, seeded, "deploy")).toBeUndefined();
  });

  it("returns undefined when enabled with a NullMemoryStore", async () => {
    expect(await memoryContextBlock("acme", { enabled: true }, new NullMemoryStore(), "deploy")).toBeUndefined();
  });

  it("returns undefined when enabled but nothing matches the query", async () => {
    const seeded = new InMemoryMemoryStore([rec()], { now: () => NOW });
    expect(await memoryContextBlock("acme", { enabled: true }, seeded, "unrelated question")).toBeUndefined();
  });

  it("renders the advisory block when enabled with matching records", async () => {
    const seeded = new InMemoryMemoryStore(
      [rec({ text: "prefers squashed history", keywords: ["squash", "history"] })],
      {
        now: () => NOW,
      },
    );
    const block = await memoryContextBlock("acme", { enabled: true }, seeded, "squash history please");
    expect(block).toBeDefined();
    expect(block!.split("\n")[0]).toBe("Background memory for org:acme (may be outdated — verify before acting):");
    expect(block).toContain("prefers squashed history");
  });

  it("honors the configured record limit", async () => {
    const seed = Array.from({ length: 6 }, (_, i) =>
      rec({ id: `r${i}`, text: `deploy note ${i}`, keywords: ["deploy"], createdAt: NOW - i }),
    );
    const seeded = new InMemoryMemoryStore(seed, { now: () => NOW });
    const block = await memoryContextBlock("acme", { enabled: true, limit: 2 }, seeded, "deploy");
    const bullets = block!.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(2);
  });
});

// Feature: docs/reference/specs/memory.md — user-scoped memory on the read
// path: org + the requesting user's records, never another user's.
// Feature: docs/reference/specs/memory.md §21–22 — repo and channel scopes join the
// one ranked pool; repo may arrive late (a promise) because the dispatcher
// starts the memory read before repo resolution finishes.
// Feature: docs/reference/specs/authorization.md item 8, docs/reference/specs/memory.md §22:
// reads are unchanged — the write gate is reflection's alone. The read path
// derives its scopes from the request and never asks the policy.
describe("memoryContextBlock — reads are not policy-gated", () => {
  it("retrieving every scope of a request never calls `authorize`; the write path (reflect) does — the same spy sees both", async () => {
    const store = new InMemoryMemoryStore(
      [
        rec({ id: "mem:org:acme:1", text: "deploy is npm run deploy", keywords: ["deploy"] }),
        rec({
          id: "mem:channel:slack:C1:0",
          scopeKey: "channel:slack:C1",
          text: "this channel is for deploy coordination",
          keywords: ["deploy"],
        }),
        rec({
          id: "mem:user:slack:UALICE:0",
          scopeKey: "user:slack:UALICE",
          text: "prefers deploy previews",
          keywords: ["deploy"],
        }),
        rec({
          id: "mem:repo:acme/api:0",
          scopeKey: "repo:acme/api",
          text: "acme/api deploys via make release",
          keywords: ["deploy"],
        }),
      ],
      { now: () => NOW },
    );
    vi.mocked(authorize).mockClear();
    const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy", "slack:UALICE", {
      channelId: "slack:C1",
      repo: "acme/api",
    });
    expect(block).toContain("org:acme + repo:acme/api + channel:slack:C1 + user:slack:UALICE");
    expect(vi.mocked(authorize)).not.toHaveBeenCalled();

    const provider: Provider = {
      name: "fake",
      async complete() {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                facts: [{ text: "the deploy command is npm run deploy", confidence: 0.9 }],
                summary: "",
              }),
            },
          ],
          stopReason: "end_turn",
        };
      },
    };
    await reflect({
      provider,
      model: "cheap-model",
      store,
      scopeKeys: { org: "org:acme", user: "user:slack:UALICE" },
      actor: {
        kind: "user",
        id: "slack:UALICE",
        grants: { actions: new Set(), channels: new Set(), repos: new Set() },
      },
      originChannelVisibility: "public",
      history: [],
      request: "how do we deploy?",
      answer: "npm run deploy",
      sourceThreadKey: "slack:C1:1.0",
    });
    expect(vi.mocked(authorize)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "slack:UALICE" }),
      "memory:write",
      expect.objectContaining({ type: "memory-scope", kind: "org", originChannelVisibility: "public" }),
    );
  });
});

describe("memoryContextBlock — repo + channel scopes", () => {
  const orgRec = rec({ id: "mem:org:acme:1", text: "deploy is npm run deploy", keywords: ["deploy"] });
  const repoRec = rec({
    id: "mem:repo:acme/api:0",
    scopeKey: "repo:acme/api",
    text: "acme/api deploys via make release",
    keywords: ["deploy", "release"],
  });
  const chanRec = rec({
    id: "mem:channel:slack:C1:0",
    scopeKey: "channel:slack:C1",
    text: "this channel is for deploy coordination",
    keywords: ["deploy", "channel"],
  });
  const otherChan = rec({
    id: "mem:channel:slack:C2:0",
    scopeKey: "channel:slack:C2",
    text: "deploy chatter for team two",
    keywords: ["deploy"],
  });
  const u1Rec = rec({
    id: "mem:user:slack:UALICE:0",
    scopeKey: "user:slack:UALICE",
    text: "prefers deploy previews",
    keywords: ["deploy", "preview"],
  });

  it("reads org + repo + channel + user and names all four in the prefix, in that order", async () => {
    const store = new InMemoryMemoryStore([orgRec, repoRec, chanRec, otherChan, u1Rec], { now: () => NOW });
    const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy", "slack:UALICE", {
      channelId: "slack:C1",
      repo: "acme/api",
    });
    expect(block!.split("\n")[0]).toBe(
      "Background memory for org:acme + repo:acme/api + channel:slack:C1 + user:slack:UALICE (may be outdated — verify before acting):",
    );
    for (const t of ["deploy is npm run deploy", "make release", "deploy coordination", "prefers deploy previews"])
      expect(block).toContain(t);
    expect(block).not.toContain("team two"); // another channel's scope is never read
  });

  it("accepts the repo as a promise (resolved after the other scopes were fetched) and includes it", async () => {
    const store = new InMemoryMemoryStore([orgRec, repoRec], { now: () => NOW });
    const repo = new Promise<string | undefined>((r) => setTimeout(() => r("acme/api"), 5));
    const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy", "slack:UALICE", { repo });
    expect(block).toContain("make release");
    expect(block!.split("\n")[0]).toContain("org:acme + repo:acme/api + user:slack:UALICE");
  });

  it("a repo promise that resolves to nothing (no repo bound) or rejects leaves the repo scope out, without failing the read", async () => {
    const store = new InMemoryMemoryStore([orgRec, repoRec], { now: () => NOW });
    const none = await memoryContextBlock("acme", { enabled: true }, store, "deploy", "slack:UALICE", {
      repo: Promise.resolve(undefined),
    });
    expect(none).not.toContain("make release");
    const failed = await memoryContextBlock("acme", { enabled: true }, store, "deploy", "slack:UALICE", {
      repo: Promise.reject(new Error("github down")),
    });
    expect(failed).toContain("deploy is npm run deploy");
    expect(failed).not.toContain("make release");
  });
});

// Feature: docs/reference/specs/memory.md §6/§19/§22 — the repository window: a run
// bound to a repository leads its block with that repository's newest facts (a
// `list` with `kind: "fact"`, `memory.repoWindow` records at most), then the
// keyword hits from the other scopes, under the one budget. The window read is
// advisory: a throwing `list` costs the run its window and one `[memory]`
// warning, never the block of hits. `repoWindow: 0` restores the retrieve-only
// read.
describe("memoryContextBlock — the repository window", () => {
  const repoFacts = (n: number, text: (i: number) => string = (i) => `repository lesson ${i + 1}`) =>
    Array.from({ length: n }, (_, i) =>
      rec({
        id: `mem:repo:acme/api:${i}`,
        scopeKey: "repo:acme/api",
        text: text(i),
        keywords: [],
        createdAt: NOW - (n - i) * 1000,
      }),
    );
  const orgHits = [
    rec({ id: "mem:org:acme:1", text: "deploy is npm run deploy", keywords: ["deploy"] }),
    rec({ id: "mem:org:acme:2", text: "previews come before deploy", keywords: ["deploy", "preview"] }),
  ];

  it("renders 24 repository facts newest first, then the hits, and no repository record twice", async () => {
    const store = new InMemoryMemoryStore([...repoFacts(30), ...orgHits], { now: () => NOW });
    const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy preview", undefined, {
      repo: "acme/api",
    });
    const bullets = block!.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(26);
    // The window: the 24 newest repository facts (30 down to 7), ahead of every hit.
    expect(bullets[0]).toContain("repository lesson 30");
    expect(bullets[23]).toContain("repository lesson 7");
    expect(bullets.slice(0, 24).every((b) => b.includes("repository lesson"))).toBe(true);
    // Then the keyword hits (ranked: both query tokens beat one), and each
    // repository record exactly once.
    expect(bullets[24]).toContain("previews come before deploy");
    expect(bullets[25]).toContain("deploy is npm run deploy");
    expect(new Set(bullets).size).toBe(26);
    // Summaries stay out of the window: only facts were listed.
    const withSummary = new InMemoryMemoryStore(
      [
        ...repoFacts(3),
        rec({
          id: "mem:repo:acme/api:s",
          scopeKey: "repo:acme/api",
          kind: "summary",
          text: "thread summary",
          keywords: [],
          createdAt: NOW,
        }),
        ...orgHits,
      ],
      { now: () => NOW },
    );
    const b2 = await memoryContextBlock("acme", { enabled: true }, withSummary, "deploy preview", undefined, {
      repo: "acme/api",
    });
    expect(b2).not.toContain("thread summary");
  });

  it("24 facts of 320 characters fit under the 3000-token budget with the hits; a 4000-token first record is kept alone", async () => {
    const store = new InMemoryMemoryStore(
      [...repoFacts(24, (i) => `lesson ${i + 1} ${"x".repeat(320 - `lesson ${i + 1} `.length)}`), ...orgHits],
      { now: () => NOW },
    );
    const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy preview", undefined, {
      repo: "acme/api",
    });
    const bullets = block!.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(26); // 24 × ~85 tokens ≈ 2100, room for both hits
    // The first-record rule as today: one record over the whole budget still lands.
    const huge = new InMemoryMemoryStore([...repoFacts(3, (i) => `${i + 1}${"y".repeat(16000)}`), ...orgHits], {
      now: () => NOW,
    });
    const hugeBlock = await memoryContextBlock("acme", { enabled: true }, huge, "deploy preview", undefined, {
      repo: "acme/api",
    });
    expect(hugeBlock!.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
  });

  it("a repository promise that rejects yields a block of hits only", async () => {
    const store = new InMemoryMemoryStore([...repoFacts(5), ...orgHits], { now: () => NOW });
    const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy preview", undefined, {
      repo: Promise.reject(new Error("github down")),
    });
    expect(block).toContain("deploy is npm run deploy");
    expect(block).not.toContain("repository lesson");
  });

  it("a store whose list throws yields the hits and exactly one [memory] warning", async () => {
    const inner = new InMemoryMemoryStore([...repoFacts(5), ...orgHits], { now: () => NOW });
    const store: MemoryStore = {
      retrieve: (q) => inner.retrieve(q),
      write: (s, r) => inner.write(s, r),
      forget: (s, id) => inner.forget(s, id),
      list: async () => {
        throw new Error("worker /list HTTP 500");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy preview", undefined, {
        repo: "acme/api",
      });
      expect(block).toContain("deploy is npm run deploy");
      expect(block).toContain("previews come before deploy");
      expect(block).not.toContain("repository lesson");
      const memoryWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("[memory]"));
      expect(memoryWarnings).toHaveLength(1);
      expect(String(memoryWarnings[0][0])).not.toContain("repository lesson"); // never a record's text
    } finally {
      warn.mockRestore();
    }
  });

  it("repoWindow: 0 yields today's block — the repository scope is retrieved, never listed", async () => {
    const store = new InMemoryMemoryStore(
      [
        rec({
          id: "mem:repo:acme/api:0",
          scopeKey: "repo:acme/api",
          text: "acme/api deploys via make release",
          keywords: ["deploy", "release"],
        }),
        ...repoFacts(3), // no query token → invisible to retrieve
        ...orgHits,
      ],
      { now: () => NOW },
    );
    const listSpy = vi.spyOn(store as MemoryStore, "list");
    const block = await memoryContextBlock("acme", { enabled: true, repoWindow: 0 }, store, "deploy", undefined, {
      repo: "acme/api",
    });
    expect(listSpy).not.toHaveBeenCalled();
    expect(block).toContain("make release"); // the keyword hit still arrives, via retrieve
    expect(block).not.toContain("repository lesson"); // no window
  });
});

describe("memoryContextBlock — user scope", () => {
  const orgRec = rec({ id: "mem:org:acme:1", text: "deploy is npm run deploy", keywords: ["deploy"] });
  const u1Rec = rec({
    id: "mem:user:slack:UALICE:0",
    scopeKey: "user:slack:UALICE",
    text: "prefers deploy previews before prod",
    keywords: ["deploy", "preview"],
  });
  const u2Rec = rec({
    id: "mem:user:slack:UBOB:0",
    scopeKey: "user:slack:UBOB",
    text: "never deploy on fridays",
    keywords: ["deploy", "friday"],
  });

  it("returns org records plus the requesting user's own records", async () => {
    const store = new InMemoryMemoryStore([orgRec, u1Rec, u2Rec], { now: () => NOW });
    const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy", "slack:UALICE");
    expect(block).toContain("deploy is npm run deploy");
    expect(block).toContain("prefers deploy previews before prod");
    expect(block).not.toContain("never deploy on fridays");
  });

  it("never surfaces another user's records", async () => {
    const store = new InMemoryMemoryStore([u1Rec, u2Rec], { now: () => NOW });
    const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy", "slack:UBOB");
    expect(block).toContain("never deploy on fridays");
    expect(block).not.toContain("prefers deploy previews");
  });

  it("names both scopes in the block prefix", async () => {
    const store = new InMemoryMemoryStore([orgRec], { now: () => NOW });
    const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy", "slack:UALICE");
    expect(block!.split("\n")[0]).toBe(
      "Background memory for org:acme + user:slack:UALICE (may be outdated — verify before acting):",
    );
  });

  it("without a user id reads org only (no user bucket is touched)", async () => {
    const store = new InMemoryMemoryStore([orgRec, u1Rec], { now: () => NOW });
    const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy");
    expect(block!.split("\n")[0]).toBe("Background memory for org:acme (may be outdated — verify before acting):");
    expect(block).not.toContain("prefers deploy previews");
  });

  it("ranks the merged set across scopes and applies limit + token budget to the one pool", async () => {
    const seed = [
      ...Array.from({ length: 5 }, (_, i) => rec({ id: `o${i}`, text: `deploy org note ${i}`, keywords: ["deploy"] })),
      ...Array.from({ length: 5 }, (_, i) =>
        rec({
          id: `u${i}`,
          scopeKey: "user:slack:UALICE",
          text: `deploy preview user note ${i}`,
          keywords: ["deploy", "preview"],
        }),
      ),
    ];
    const store = new InMemoryMemoryStore(seed, { now: () => NOW });
    const block = await memoryContextBlock(
      "acme",
      { enabled: true, limit: 3 },
      store,
      "deploy preview",
      "slack:UALICE",
    );
    const bullets = block!.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(3);
    // Both query tokens hit the user notes, one hits the org notes → the user
    // notes outrank across the scope boundary; the limit is not per scope.
    expect(bullets.every((b) => b.includes("user note"))).toBe(true);
  });
});

describe("memoryContextBlock — the caller's span (docs/reference/specs/tracing.md item 24)", () => {
  it("hands the span to every scope's retrieve, and nothing when it has none", async () => {
    const seeded = new InMemoryMemoryStore([rec()], { now: () => NOW });
    const spy = vi.spyOn(seeded as MemoryStore, "retrieve");
    const span = createTracer({ clock: () => NOW }).start("dispatch.memory_read", { sinks: [] });
    await memoryContextBlock("acme", { enabled: true }, seeded, "deploy", "UALICE", { channelId: "C1" }, span);
    expect(spy.mock.calls.length).toBeGreaterThan(1);
    for (const call of spy.mock.calls) expect(call[1]).toEqual({ span });
    spy.mockClear();
    await memoryContextBlock("acme", { enabled: true }, seeded, "deploy");
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const call of spy.mock.calls) expect(call[1]).toBeUndefined();
  });
});
