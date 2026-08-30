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

  it("list returns [] and forget returns false (#278 human controls)", async () => {
    const store = new NullMemoryStore();
    expect(await store.list("org:coreplanelabs", 10)).toEqual([]);
    expect(await store.forget("org:coreplanelabs", "mem:org:coreplanelabs:0")).toBe(false);
  });
});

// Feature: features/memory.md §24 (#278) — human controls: list a scope's active
// records newest first; forget = soft-delete (status `forgotten`, provenance
// kept) that hides the record from retrieval, list, and dedup.
describe("InMemoryMemoryStore.list / forget (#278)", () => {
  const seed = () =>
    new InMemoryMemoryStore(
      [
        rec({ id: "a", createdAt: NOW - 3000, text: "oldest deploy note" }),
        rec({ id: "b", createdAt: NOW - 2000, text: "middle deploy note" }),
        rec({ id: "c", createdAt: NOW - 1000, text: "newest deploy note" }),
        rec({ id: "s", createdAt: NOW, text: "superseded deploy note", status: "superseded" }),
        rec({ id: "u", scopeKey: "user:slack:U1", text: "user deploy note" }),
      ],
      { now: () => NOW },
    );

  it("list: the scope's ACTIVE records, newest first, capped at limit; never another scope's", async () => {
    const store = seed();
    expect((await store.list("org:coreplanelabs", 10)).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect((await store.list("org:coreplanelabs", 2)).map((r) => r.id)).toEqual(["c", "b"]);
    expect((await store.list("user:slack:U1", 10)).map((r) => r.id)).toEqual(["u"]);
    expect(await store.list("user:slack:U2", 10)).toEqual([]);
  });

  it("list with a query keeps only records a query token hits (whole-token, text or keywords), newest first, no usage bump (#293)", async () => {
    const store = seed();
    const hits = await store.list("org:coreplanelabs", 10, "newest oldest");
    expect(hits.map((r) => r.id)).toEqual(["c", "a"]);
    expect(hits.every((r) => r.useCount === 0 && r.lastUsedAt === undefined)).toBe(true);
    expect((await store.list("org:coreplanelabs", 10, "npm")).map((r) => r.id)).toEqual(["c", "b", "a"]); // keyword hit
    expect(await store.list("org:coreplanelabs", 10, "new")).toEqual([]); // substring is not a token
    expect(await store.list("org:coreplanelabs", 10, "!!!")).toEqual([]); // no tokens → nothing
    expect((await store.list("org:coreplanelabs", 1, "deploy")).map((r) => r.id)).toEqual(["c"]); // limit applies after the filter
    expect(await new NullMemoryStore().list("org:coreplanelabs", 10, "deploy")).toEqual([]);
  });

  it("list does not bump usage (it is a human view, not a retrieval)", async () => {
    const store = seed();
    const [first] = await store.list("org:coreplanelabs", 1);
    expect(first.useCount).toBe(0);
    expect(first.lastUsedAt).toBeUndefined();
  });

  it("forget: flips an active same-scope record to `forgotten` (kept, not removed) and returns true", async () => {
    const store = seed();
    expect(await store.forget("org:coreplanelabs", "b")).toBe(true);
    expect((await store.list("org:coreplanelabs", 10)).map((r) => r.id)).toEqual(["c", "a"]);
    expect((await store.retrieve({ scopeKey: "org:coreplanelabs", query: "middle deploy note", limit: 10 })).map((r) => r.id)).not.toContain("b");
  });

  it("forget: unknown id, foreign-scope id, or an already non-active record → false, nothing changes", async () => {
    const store = seed();
    expect(await store.forget("org:coreplanelabs", "nope")).toBe(false);
    expect(await store.forget("org:coreplanelabs", "u")).toBe(false); // lives in user:slack:U1
    expect(await store.forget("org:coreplanelabs", "s")).toBe(false); // superseded
    expect((await store.list("user:slack:U1", 10)).map((r) => r.id)).toEqual(["u"]);
    expect(await store.forget("org:coreplanelabs", "b")).toBe(true);
    expect(await store.forget("org:coreplanelabs", "b")).toBe(false); // second time: no longer active
  });

  it("a forgotten record is no longer a dedup target: re-asserting its text creates a fresh active record", async () => {
    const store = seed();
    await store.forget("org:coreplanelabs", "b");
    await store.write("org:coreplanelabs", [{ kind: "fact", text: "middle deploy note", sourceThreadKey: "slack:C1:2.0" }]);
    const ids = (await store.list("org:coreplanelabs", 10)).map((r) => r.id);
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain("b");
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

  it("dedup is whitespace/case-insensitive", async () => {
    const store = new InMemoryMemoryStore([], { now: () => NOW });
    await store.write("org:coreplanelabs", [cand]);
    await store.write("org:coreplanelabs", [{ ...cand, text: "  The deploy   command is NPM run deploy " }]);
    const out = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 });
    expect(out).toHaveLength(1);
  });

  it("supersede: marks the named active record superseded (kept, not deleted) and inserts the new one", async () => {
    const store = new InMemoryMemoryStore([], { now: () => NOW });
    await store.write("org:coreplanelabs", [cand]);
    const [old] = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 });
    await store.write("org:coreplanelabs", [
      { ...cand, text: "the deploy command is now npm run ship", supersedes: old.id },
    ]);
    const out = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 });
    expect(out.map((r) => r.text)).toEqual(["the deploy command is now npm run ship"]);
    expect(out[0].supersedes).toBe(old.id);
    expect(old.status).toBe("superseded"); // soft delete: provenance preserved
  });

  it("supersede of an unknown or other-scope id still inserts the new record, superseding nothing", async () => {
    const store = new InMemoryMemoryStore([], { now: () => NOW });
    await store.write("org:other", [cand]);
    const [other] = await store.retrieve({ scopeKey: "org:other", query: "deploy", limit: 8 });
    await store.write("org:coreplanelabs", [
      { ...cand, text: "new fact about deploy", supersedes: other.id },
      { ...cand, text: "another deploy fact", supersedes: "mem:org:coreplanelabs:999" },
    ]);
    expect(other.status).toBe("active");
    const out = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 });
    expect(out).toHaveLength(2);
  });

  it("a candidate that restates the record it supersedes is a no-op dedup (target stays active, nothing inserted)", async () => {
    const store = new InMemoryMemoryStore([], { now: () => NOW });
    await store.write("org:coreplanelabs", [cand]);
    const [old] = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 });
    await store.write("org:coreplanelabs", [{ ...cand, text: "The deploy command is npm run deploy", supersedes: old.id }]);
    expect(old.status).toBe("active");
    const out = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 });
    expect(out).toHaveLength(1);
    expect(out[0].useCount).toBe(3); // first retrieval + dedup bump + this retrieval
  });

  it("a targeted supersede is NOT swallowed by a text collision with an UNRELATED record", async () => {
    // The extractor sees existing record text verbatim; a collision (accidental or
    // induced) with some other record must not cancel an explicit correction.
    const store = new InMemoryMemoryStore([], { now: () => NOW });
    await store.write("org:coreplanelabs", [cand, { ...cand, text: "the on-call rotation is weekly" }]);
    const all = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy rotation", limit: 8 });
    const deployFact = all.find((r) => r.text === cand.text)!;
    const onCall = all.find((r) => r.text.includes("on-call"))!;
    await store.write("org:coreplanelabs", [{ ...cand, supersedes: onCall.id }]); // text == deployFact's text
    expect(onCall.status).toBe("superseded"); // the correction happened
    expect(deployFact.status).toBe("active");
    const out = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 });
    expect(out.filter((r) => r.supersedes === onCall.id)).toHaveLength(1); // the new record landed
  });

  it("an UNRESOLVABLE `supersedes` (unknown id, or target already superseded earlier in the batch) still inserts — never falls back to global dedup", async () => {
    const store = new InMemoryMemoryStore([], { now: () => NOW });
    await store.write("org:coreplanelabs", [cand, { ...cand, text: "the on-call rotation is weekly" }]);
    const all = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy rotation", limit: 8 });
    const deployFact = all.find((r) => r.text === cand.text)!;
    const onCall = all.find((r) => r.text.includes("on-call"))!;
    // One batch: two corrections of the same record; the second's text collides
    // with an unrelated record AND its target is already superseded by the first.
    await store.write("org:coreplanelabs", [
      { ...cand, text: "the on-call rotation is biweekly", supersedes: onCall.id },
      { ...cand, supersedes: onCall.id }, // text == deployFact's text
      { ...cand, supersedes: "mem:org:coreplanelabs:9999" }, // unknown id, same collision
    ]);
    expect(onCall.status).toBe("superseded");
    expect(deployFact.useCount).toBe(1); // only this test's retrieval — never bumped by a dedup
    const out = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy rotation", limit: 8 });
    expect(out.filter((r) => r.text === cand.text)).toHaveLength(3); // original + both corrections landed
    expect(out.some((r) => r.text === "the on-call rotation is biweekly")).toBe(true);
  });

  it("superseded records never match retrieval and are not dedup targets", async () => {
    const store = new InMemoryMemoryStore([], { now: () => NOW });
    await store.write("org:coreplanelabs", [cand]);
    const [old] = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 });
    await store.write("org:coreplanelabs", [{ ...cand, text: "deploy v2", supersedes: old.id }]);
    // Re-asserting the old text is a NEW active record, not a bump on the superseded one.
    await store.write("org:coreplanelabs", [cand]);
    const out = await store.retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 });
    expect(out.map((r) => r.text).sort()).toEqual(["deploy v2", "the deploy command is npm run deploy"]);
    expect(old.status).toBe("superseded");
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
