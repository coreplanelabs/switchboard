import { describe, expect, it } from "vitest";
import { mintRecord, normalizeText, planEviction, planWrite, rankRecords } from "./engine.js";
import type { MemoryCandidate, MemoryRecord } from "./types.js";

// Feature: features/memory.md — the store-agnostic engine shared by the
// in-process store and the Memory Worker's Durable Object (PR3, #85). The
// store tests prove each backend applies the plan; these prove the plan.

const NOW = 1_700_000_000_000;
const SCOPE = "org:coreplanelabs";

function rec(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem:org:coreplanelabs:0",
    scopeKey: SCOPE,
    kind: "fact",
    text: "the deploy command is npm run deploy",
    keywords: ["deploy"],
    sourceThreadKey: "slack:C1:1.0",
    createdAt: NOW,
    useCount: 0,
    status: "active",
    ...over,
  };
}
const cand = (text: string, over: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
  kind: "fact",
  text,
  sourceThreadKey: "slack:C1:1.0",
  ...over,
});
const mint = (c: MemoryCandidate) => mintRecord(SCOPE, 99, NOW, c);

describe("normalizeText", () => {
  it("trims, lowercases, collapses whitespace", () => {
    expect(normalizeText("  The  DEPLOY\n command ")).toBe("the deploy command");
  });
});

describe("rankRecords", () => {
  it("drops non-active and non-matching records, orders best first, cuts at limit, does not mutate usage", () => {
    const hit = rec({ id: "hit" });
    const better = rec({ id: "better", text: "deploy then rollback", keywords: ["deploy", "rollback"] });
    const superseded = rec({ id: "old", status: "superseded" });
    const miss = rec({ id: "miss", text: "vacation policy", keywords: ["vacation"] });
    const out = rankRecords([hit, superseded, miss, better], "deploy rollback", NOW, 1);
    expect(out.map((r) => r.id)).toEqual(["better"]);
    expect(better.useCount).toBe(0);
    expect(rankRecords([hit], "", NOW, 8)).toEqual([]);
  });
});

describe("planWrite", () => {
  it("inserts a new fact with a minted, namespaced record", () => {
    const plan = planWrite([], cand("new fact"), mint);
    expect(plan.action).toBe("insert");
    if (plan.action !== "insert") return;
    expect(plan.record.id).toBe(`mem:${SCOPE}:99`);
    expect(plan.record.keywords).toEqual(["new", "fact"]); // tokenized default
    expect(plan.supersede).toBeUndefined();
  });

  it("dedups against any active record when there is no supersedes", () => {
    const existing = rec();
    const plan = planWrite([existing], cand(" THE deploy command is npm run deploy "), mint);
    expect(plan).toEqual({ action: "dedup", target: existing });
  });

  it("never dedups against a superseded record", () => {
    expect(planWrite([rec({ status: "superseded" })], cand("the deploy command is npm run deploy"), mint).action).toBe("insert");
  });

  it("resolves a supersede target only among active same-list records", () => {
    const target = rec({ id: "t" });
    const plan = planWrite([target], cand("corrected", { supersedes: "t" }), mint);
    expect(plan.action === "insert" && plan.supersede).toBe(target);
    const none = planWrite([target], cand("corrected", { supersedes: "unknown" }), mint);
    expect(none.action === "insert" && none.supersede).toBeUndefined();
  });

  it("with supersedes, dedups only against its own target — a collision with an unrelated record never swallows the correction", () => {
    const target = rec({ id: "t", text: "stale" });
    const unrelated = rec({ id: "u", text: "the deploy command is npm run ship" });
    const plan = planWrite([target, unrelated], cand("the deploy command is npm run ship", { supersedes: "t" }), mint);
    expect(plan.action).toBe("insert");
    expect(plan.action === "insert" && plan.supersede).toBe(target);
    // Restating the target's own text is a dedup on the target.
    expect(planWrite([target], cand("stale", { supersedes: "t" }), mint)).toEqual({ action: "dedup", target });
    // Unresolvable id → no dedup at all, even against an identical unrelated record.
    expect(planWrite([unrelated], cand("the deploy command is npm run ship", { supersedes: "zzz" }), mint).action).toBe("insert");
  });
});

describe("mintRecord", () => {
  it("carries every candidate field, stamps id/createdAt/useCount/status, and defaults keywords to tokens", () => {
    const r = mintRecord(SCOPE, 3, NOW, cand("Deploy via npm", { confidence: 0.8, supersedes: "x", sourceRunId: "run" }));
    expect(r).toEqual({
      id: `mem:${SCOPE}:3`,
      scopeKey: SCOPE,
      kind: "fact",
      text: "Deploy via npm",
      keywords: ["deploy", "via", "npm"],
      sourceThreadKey: "slack:C1:1.0",
      sourceRunId: "run",
      createdAt: NOW,
      useCount: 0,
      confidence: 0.8,
      supersedes: "x",
      status: "active",
    });
  });
});

// Feature: features/memory.md — per-scope cap (#253): the pure eviction plan.
describe("planEviction (#253)", () => {
  const NOW = 1_700_000_000_000;
  const mk = (id: string, createdAt: number, lastUsedAt?: number): MemoryRecord => ({
    id,
    scopeKey: "org:coreplanelabs",
    kind: "fact",
    text: id,
    keywords: [id],
    sourceThreadKey: "slack:C1:1.0",
    createdAt,
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    useCount: 0,
    status: "active",
  });

  it("evicts nothing at or under the cap", () => {
    const active = [mk("a", NOW - 3), mk("b", NOW - 2), mk("c", NOW - 1)];
    expect(planEviction(active, 3)).toEqual([]);
    expect(planEviction(active, 10)).toEqual([]);
    expect(planEviction([], 1)).toEqual([]);
  });

  it("evicts exactly (active − cap) records, least recently USED first (lastUsedAt ?? createdAt)", () => {
    const active = [
      mk("old-but-hot", NOW - 10_000, NOW - 1), // created long ago, used just now → keep
      mk("recent-never-used", NOW - 5), // never used → falls back to createdAt
      mk("stale", NOW - 9_000, NOW - 8_000), // used long ago → evict first
      mk("mid", NOW - 4_000, NOW - 3_000),
    ];
    expect(planEviction(active, 2).map((r) => r.id)).toEqual(["stale", "mid"]);
    expect(planEviction(active, 3).map((r) => r.id)).toEqual(["stale"]);
  });

  it("breaks a lastUsedAt tie by lower createdAt (the older record goes first) and never returns non-active rows", () => {
    const active = [mk("newer", NOW - 100, NOW - 50), mk("older", NOW - 200, NOW - 50), mk("keep", NOW, NOW)];
    expect(planEviction(active, 2).map((r) => r.id)).toEqual(["older"]);
    const withDead = [...active, { ...mk("gone", NOW - 999), status: "forgotten" as const }];
    expect(planEviction(withDead, 2).map((r) => r.id)).toEqual(["older"]);
  });
});
