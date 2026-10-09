import { describe, expect, it } from "vitest";
import {
  claimPoolBinding,
  mayRunAsPoolUser,
  ownedPoolUsers,
  parsePoolBindings,
  parseSpentPoolUsers,
  rebuildPoolBindingIndex,
  releasePoolBinding,
  spendPoolUser,
  unavailablePoolUsers,
} from "./residentPoolSpends.js";

const pool = ["worker2", "worker3", "worker4"];

describe("dynamic resident UID ownership", () => {
  it("accepts recorded identities beyond 250 owners without allowing cross-owner reuse", () => {
    const history = Array.from({ length: 251 }, (_, i) => ({ user: `worker${i + 2}`, owner: `thread:t${i}` }));
    expect(parseSpentPoolUsers(history, undefined)?.get("worker252")).toBe("thread:t250");
    const next = spendPoolUser(history, undefined, "worker253", "thread:next");
    expect(next?.at(-1)).toEqual({ user: "worker253", owner: "thread:next" });
    expect(mayRunAsPoolUser(next, undefined, "worker253", ["next"], undefined)).toBe(true);
    expect(mayRunAsPoolUser(next, undefined, "worker253", ["other"], undefined)).toBe(false);
    expect(spendPoolUser(next, undefined, "worker253", "thread:other")).toBeNull();
  });

  it("rejects privileged, malformed or unrecorded identities in dynamic mode", () => {
    const own = spendPoolUser([], undefined, "worker252", "thread:a");
    expect(mayRunAsPoolUser(own, undefined, "worker252", ["a"], undefined)).toBe(true);
    for (const user of [
      "root",
      "worker1",
      "worker0",
      "worker02",
      "worker-2",
      "worker2;id",
      "worker99999999999999999",
    ]) {
      expect(spendPoolUser([], undefined, user, "thread:a")).toBeNull();
      expect(mayRunAsPoolUser(own, undefined, user, ["a"], undefined)).toBe(false);
    }
    expect(mayRunAsPoolUser(own, undefined, "worker253", ["a"], undefined)).toBe(false);
  });
});

describe("resident pool UID spends", () => {
  it("refuses a missing or malformed generation ledger", () => {
    for (const value of [
      undefined,
      null,
      {},
      ["worker2"],
      [
        { user: "worker2", owner: "thread:a" },
        { user: "worker2", owner: "thread:b" },
      ],
      [{ user: "worker99", owner: "thread:a" }],
      [{ user: "worker2", owner: "" }],
    ]) {
      expect(parseSpentPoolUsers(value, pool)).toBeNull();
      expect(spendPoolUser(value, pool, "worker3", "thread:c")).toBeNull();
    }
  });

  it("spends each UID once for a new owner and never allows a different owner to reuse it", () => {
    const first = spendPoolUser([], pool, "worker2", "thread:a");
    expect(first).toEqual([{ user: "worker2", owner: "thread:a" }]);
    expect(spendPoolUser(first, pool, "worker2", "thread:b")).toBeNull();
    expect(spendPoolUser(first, pool, "worker2", "op:1")).toBeNull();
    expect(spendPoolUser(first, pool, "worker3", "op:1")).toEqual([
      { user: "worker2", owner: "thread:a" },
      { user: "worker3", owner: "op:1" },
    ]);
  });

  it("lets only the exact bound thread reclaim its UID after a confirmed recycle", () => {
    const first = spendPoolUser([], pool, "worker2", "thread:a");
    expect(spendPoolUser(first, pool, "worker2", "thread:a")).toEqual(first);
    expect(spendPoolUser(first, pool, "worker2", "thread:b")).toBeNull();
  });

  it("makes a detached thread's UID available only to that same owner", () => {
    const spent = parseSpentPoolUsers(
      [
        { user: "worker2", owner: "thread:a" },
        { user: "worker3", owner: "op:one" },
      ],
      pool,
    )!;
    expect(unavailablePoolUsers(spent, "thread:a")).toEqual(new Set(["worker3"]));
    expect(unavailablePoolUsers(spent, "thread:b")).toEqual(new Set(["worker2", "worker3"]));
    expect(ownedPoolUsers(spent, "thread:a")).toEqual(["worker2"]);
    expect(ownedPoolUsers(spent, "thread:b")).toEqual([]);
  });

  it("refuses UID-scoped work while two retained bindings name one UID", () => {
    const claimed = spendPoolUser([], pool, "worker2", "thread:a");
    expect(mayRunAsPoolUser(claimed, pool, "worker2", ["a"], undefined)).toBe(true);
    expect(mayRunAsPoolUser(claimed, pool, "worker2", ["a", "b"], undefined)).toBe(false);
    expect(mayRunAsPoolUser(claimed, pool, "worker2", ["b"], undefined)).toBe(false);
    expect(mayRunAsPoolUser(claimed, pool, "worker2", [], undefined)).toBe(false);
  });

  it("admits an op only with its exact active owner and no retained thread", () => {
    const claimed = spendPoolUser([], pool, "worker2", "op:one");
    expect(mayRunAsPoolUser(claimed, pool, "worker2", [], "op:one")).toBe(true);
    expect(mayRunAsPoolUser(claimed, pool, "worker2", [], "op:two")).toBe(false);
    expect(mayRunAsPoolUser(claimed, pool, "worker2", ["thread"], "op:one")).toBe(false);
  });
});

describe("resident pool UID binding index", () => {
  it("rebuilds a bounded per-UID view from legacy bindings, including duplicates", () => {
    const bindings = Array.from({ length: 1830 }, (_, n) => ({
      threadKey: `old-${n}`,
      user: "",
      evicted: true,
    }));
    bindings.push({ threadKey: "a", user: "worker2", evicted: false });
    bindings.push({ threadKey: "b", user: "worker2", evicted: false });
    expect(rebuildPoolBindingIndex(bindings, pool)).toEqual(
      new Map([
        ["worker2", ["a", "b"]],
        ["worker3", []],
        ["worker4", []],
      ]),
    );
    expect(
      mayRunAsPoolUser(spendPoolUser([], pool, "worker2", "thread:a"), pool, "worker2", ["a", "b"], undefined),
    ).toBe(false);
  });

  it("refuses absent, malformed or duplicate index rows", () => {
    for (const value of [undefined, null, {}, [""], ["a", "a"], [1], ["a", null]]) {
      expect(parsePoolBindings(value)).toBeNull();
      expect(claimPoolBinding(value, "b")).toBeNull();
      expect(releasePoolBinding(value, "a")).toBeNull();
    }
  });

  it("adds and removes only the exact claimant and refuses an inconsistent mutation", () => {
    expect(claimPoolBinding([], "a")).toEqual(["a"]);
    expect(claimPoolBinding(["a"], "b")).toEqual(["a", "b"]);
    expect(claimPoolBinding(["a"], "a")).toBeNull();
    expect(releasePoolBinding(["a", "b"], "a")).toEqual(["b"]);
    expect(releasePoolBinding(["b"], "a")).toBeNull();
  });

  it("refuses malformed live rows during legacy migration", () => {
    expect(rebuildPoolBindingIndex([{ threadKey: "x", user: "worker99", evicted: false }], pool)).toBeNull();
    expect(rebuildPoolBindingIndex([{ threadKey: "", user: "worker2", evicted: false }], pool)).toBeNull();
  });

  it("ignores an invalid evicted legacy row without blocking resident startup", () => {
    expect(rebuildPoolBindingIndex([{ threadKey: "", user: "", evicted: true }], pool)).toEqual(
      new Map(pool.map((user) => [user, []])),
    );
  });
});
