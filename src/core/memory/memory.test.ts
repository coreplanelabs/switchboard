import { describe, expect, it, vi } from "vitest";
import type { Provider } from "../../providers/types.js";
import { authorize } from "../authz/index.js";
import type { MemoryRecord, MemoryStore } from "./types.js";
import { InMemoryMemoryStore, NullMemoryStore } from "./stores.js";
import { memoryContextBlock, reflect } from "./index.js";
import { createTracer } from "../trace/tracer.js";

// The one authorization entry point, spied so the read-path test below can
// prove it is never consulted (authorization R11: reads are unchanged).
vi.mock("../authz/index.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../authz/index.js")>();
  return { ...mod, authorize: vi.fn(mod.authorize) };
});

// Feature: features/memory.md — the dispatcher-facing read path that ties the
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

// Feature: features/memory.md (#107 PR B) — user-scoped memory on the read
// path: org + the requesting user's records, never another user's.
// Feature: features/memory.md §21–22 (#253) — repo and channel scopes join the
// one ranked pool; repo may arrive late (a promise) because the dispatcher
// starts the memory read before repo resolution finishes.
// Feature: features/authorization.md item 8, features/memory.md §22 (R11):
// reads are unchanged — the write gate is reflection's alone. The read path
// derives its scopes from the request and never asks the policy.
describe("memoryContextBlock — reads are not policy-gated (authorization R11)", () => {
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
          id: "mem:user:slack:U1:0",
          scopeKey: "user:slack:U1",
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
    const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy", "slack:U1", {
      channelId: "slack:C1",
      repo: "acme/api",
    });
    expect(block).toContain("org:acme + repo:acme/api + channel:slack:C1 + user:slack:U1");
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
      scopeKeys: { org: "org:acme", user: "user:slack:U1" },
      actor: { kind: "user", id: "slack:U1", grants: { actions: new Set(), channels: new Set(), repos: new Set() } },
      originChannelVisibility: "public",
      history: [],
      request: "how do we deploy?",
      answer: "npm run deploy",
      sourceThreadKey: "slack:C1:1.0",
    });
    expect(vi.mocked(authorize)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "slack:U1" }),
      "memory:write",
      expect.objectContaining({ type: "memory-scope", kind: "org", originChannelVisibility: "public" }),
    );
  });
});

describe("memoryContextBlock — repo + channel scopes (#253)", () => {
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
    id: "mem:user:slack:U1:0",
    scopeKey: "user:slack:U1",
    text: "prefers deploy previews",
    keywords: ["deploy", "preview"],
  });

  it("reads org + repo + channel + user and names all four in the prefix, in that order", async () => {
    const store = new InMemoryMemoryStore([orgRec, repoRec, chanRec, otherChan, u1Rec], { now: () => NOW });
    const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy", "slack:U1", {
      channelId: "slack:C1",
      repo: "acme/api",
    });
    expect(block!.split("\n")[0]).toBe(
      "Background memory for org:acme + repo:acme/api + channel:slack:C1 + user:slack:U1 (may be outdated — verify before acting):",
    );
    for (const t of ["deploy is npm run deploy", "make release", "deploy coordination", "prefers deploy previews"])
      expect(block).toContain(t);
    expect(block).not.toContain("team two"); // another channel's scope is never read
  });

  it("accepts the repo as a promise (resolved after the other scopes were fetched) and includes it", async () => {
    const store = new InMemoryMemoryStore([orgRec, repoRec], { now: () => NOW });
    const repo = new Promise<string | undefined>((r) => setTimeout(() => r("acme/api"), 5));
    const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy", "slack:U1", { repo });
    expect(block).toContain("make release");
    expect(block!.split("\n")[0]).toContain("org:acme + repo:acme/api + user:slack:U1");
  });

  it("a repo promise that resolves to nothing (no repo bound) or rejects leaves the repo scope out, without failing the read", async () => {
    const store = new InMemoryMemoryStore([orgRec, repoRec], { now: () => NOW });
    const none = await memoryContextBlock("acme", { enabled: true }, store, "deploy", "slack:U1", {
      repo: Promise.resolve(undefined),
    });
    expect(none).not.toContain("make release");
    const failed = await memoryContextBlock("acme", { enabled: true }, store, "deploy", "slack:U1", {
      repo: Promise.reject(new Error("github down")),
    });
    expect(failed).toContain("deploy is npm run deploy");
    expect(failed).not.toContain("make release");
  });
});

describe("memoryContextBlock — user scope (#107 PR B)", () => {
  const orgRec = rec({ id: "mem:org:acme:1", text: "deploy is npm run deploy", keywords: ["deploy"] });
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
    const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy", "slack:U1");
    expect(block).toContain("deploy is npm run deploy");
    expect(block).toContain("prefers deploy previews before prod");
    expect(block).not.toContain("never deploy on fridays");
  });

  it("never surfaces another user's records", async () => {
    const store = new InMemoryMemoryStore([u1Rec, u2Rec], { now: () => NOW });
    const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy", "slack:U2");
    expect(block).toContain("never deploy on fridays");
    expect(block).not.toContain("prefers deploy previews");
  });

  it("names both scopes in the block prefix", async () => {
    const store = new InMemoryMemoryStore([orgRec], { now: () => NOW });
    const block = await memoryContextBlock("acme", { enabled: true }, store, "deploy", "slack:U1");
    expect(block!.split("\n")[0]).toBe(
      "Background memory for org:acme + user:slack:U1 (may be outdated — verify before acting):",
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
          scopeKey: "user:slack:U1",
          text: `deploy preview user note ${i}`,
          keywords: ["deploy", "preview"],
        }),
      ),
    ];
    const store = new InMemoryMemoryStore(seed, { now: () => NOW });
    const block = await memoryContextBlock("acme", { enabled: true, limit: 3 }, store, "deploy preview", "slack:U1");
    const bullets = block!.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(3);
    // Both query tokens hit the user notes, one hits the org notes → the user
    // notes outrank across the scope boundary; the limit is not per scope.
    expect(bullets.every((b) => b.includes("user note"))).toBe(true);
  });
});

describe("memoryContextBlock — the caller's span (features/tracing.md item 24)", () => {
  it("hands the span to every scope's retrieve, and nothing when it has none", async () => {
    const seeded = new InMemoryMemoryStore([rec()], { now: () => NOW });
    const spy = vi.spyOn(seeded as MemoryStore, "retrieve");
    const span = createTracer({ clock: () => NOW }).start("dispatch.memory_read", { sinks: [] });
    await memoryContextBlock("acme", { enabled: true }, seeded, "deploy", "U1", { channelId: "C1" }, span);
    expect(spy.mock.calls.length).toBeGreaterThan(1);
    for (const call of spy.mock.calls) expect(call[1]).toEqual({ span });
    spy.mockClear();
    await memoryContextBlock("acme", { enabled: true }, seeded, "deploy");
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const call of spy.mock.calls) expect(call[1]).toBeUndefined();
  });
});
