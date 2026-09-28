import { describe, expect, it, vi } from "vitest";
import { GitBindings } from "./gitBindings.js";

describe("GitBindings", () => {
  it("gives a replacement registration a new request generation", () => {
    const bindings = new GitBindings();
    expect(bindings.register("run", { repo: "o/r", ref: "feature" }, undefined)).toBe(true);
    const first = bindings.generationOf("run");
    expect(first).toBeDefined();
    bindings.unregister("run");
    expect(bindings.generationOf("run")).toBeUndefined();
    expect(bindings.register("run", { repo: "o/r", ref: "feature" }, undefined)).toBe(true);
    expect(bindings.generationOf("run")).not.toBe(first);
  });

  it("starts an existing PR blocked and invalidates in-flight requests when its authority changes", () => {
    const bindings = new GitBindings();
    expect(bindings.register("run", { repo: "o/r", ref: "feature" }, undefined, undefined, true)).toBe(true);
    expect(bindings.publicationOf("run")).toMatchObject({ blocked: expect.any(String) });
    const before = bindings.generationOf("run");
    const head = "a".repeat(40);
    expect(bindings.setPublication("run", { ref: "feature", expectedHeadSha: head })).toBe(true);
    expect(bindings.publicationOf("run")).toEqual({ ref: "feature", expectedHeadSha: head });
    expect(bindings.generationOf("run")).not.toBe(before);
    expect(bindings.setPublication("run", { ref: "other", expectedHeadSha: head })).toBe(false);
    expect(bindings.publicationOf("run")).toMatchObject({ blocked: expect.any(String) });
    bindings.unregister("run");
    expect(bindings.register("run", { repo: "o/r", ref: "feature" }, undefined, undefined, true)).toBe(true);
    expect(bindings.publicationOf("run")).toMatchObject({ blocked: expect.any(String) });
  });

  it("allows one durable existing-PR write intent and advances only after its accepted outcome commits", async () => {
    const bindings = new GitBindings();
    const old = "a".repeat(40);
    const next = "b".repeat(40);
    const update = { ref: "refs/heads/feature", old, next };
    const begin = vi.fn(async () => true);
    const finish = vi.fn(async () => true);
    expect(bindings.register("run", { repo: "o/r", ref: "feature" }, undefined, undefined, true)).toBe(true);
    expect(bindings.setPublication("run", { ref: "feature", expectedHeadSha: old })).toBe(true);
    expect(bindings.setPublicationRecorder("run", { begin, finish })).toBe(true);
    const claim = await bindings.beginPublication("run", update);
    expect(claim).toBeDefined();
    expect(await bindings.beginPublication("run", update)).toBeUndefined();
    expect(begin).toHaveBeenCalledOnce();
    expect(await claim!.finish("accepted")).toBe(true);
    expect(finish).toHaveBeenCalledWith(update, "accepted");
    expect(bindings.publicationOf("run")).toEqual({ ref: "feature", expectedHeadSha: next });
    expect(await claim!.finish("accepted")).toBe(false);
    expect(await bindings.beginPublication("run", update)).toBeUndefined();
  });

  it("blocks later writes when a trusted outcome fails to commit or authority is revoked in flight", async () => {
    const bindings = new GitBindings();
    const old = "a".repeat(40);
    const update = { ref: "refs/heads/feature", old, next: "b".repeat(40) };
    expect(bindings.register("run", { repo: "o/r", ref: "feature" }, undefined, undefined, true)).toBe(true);
    expect(bindings.setPublication("run", { ref: "feature", expectedHeadSha: old })).toBe(true);
    expect(bindings.setPublicationRecorder("run", { begin: async () => true, finish: async () => false })).toBe(true);
    const claim = await bindings.beginPublication("run", update);
    expect(await claim!.finish("accepted")).toBe(false);
    expect(bindings.publicationOf("run")).toMatchObject({ blocked: expect.any(String) });
    expect(await bindings.beginPublication("run", update)).toBeUndefined();

    bindings.unregister("run");
    expect(bindings.register("run", { repo: "o/r", ref: "feature" }, undefined, undefined, true)).toBe(true);
    expect(bindings.setPublication("run", { ref: "feature", expectedHeadSha: old })).toBe(true);
    expect(bindings.setPublicationRecorder("run", { begin: async () => true, finish: async () => true })).toBe(true);
    const inFlight = await bindings.beginPublication("run", update);
    expect(bindings.setPublication("run", { blocked: "run ended" })).toBe(true);
    expect(await inFlight!.finish("accepted")).toBe(true);
    expect(bindings.publicationOf("run")).toEqual({ blocked: "run ended" });
  });

  it("keeps an uncertain forwarded write blocked without inventing a rejection receipt", async () => {
    const bindings = new GitBindings();
    const old = "a".repeat(40);
    const update = { ref: "refs/heads/feature", old, next: "b".repeat(40) };
    const finish = vi.fn(async () => true);
    expect(bindings.register("run", { repo: "o/r", ref: "feature" }, undefined, undefined, true)).toBe(true);
    expect(bindings.setPublication("run", { ref: "feature", expectedHeadSha: old })).toBe(true);
    expect(bindings.setPublicationRecorder("run", { begin: async () => true, finish })).toBe(true);
    const claim = await bindings.beginPublication("run", update);
    expect(await claim!.finish("unknown")).toBe(false);
    expect(finish).not.toHaveBeenCalled();
    expect(bindings.publicationOf("run")).toMatchObject({ blocked: expect.any(String) });
    expect(await bindings.beginPublication("run", update)).toBeUndefined();
  });

  it("holds every branch write behind one durable intent and keeps an unknown outcome blocked", async () => {
    const bindings = new GitBindings();
    const update = { ref: "refs/heads/feature", old: "0".repeat(40), next: "b".repeat(40) };
    const begin = vi.fn(async () => true);
    const finish = vi.fn(async () => true);
    expect(bindings.register("run", { repo: "o/r", ref: "feature" }, undefined)).toBe(true);
    expect(bindings.setBranchRecorder("run", { begin, finish })).toBe(true);
    const claim = await bindings.beginBranch("run", update);
    expect(claim).toBeDefined();
    expect(begin).toHaveBeenCalledWith(update);
    expect(await bindings.beginBranch("run", update)).toBeUndefined();
    expect(await claim!.finish("unknown")).toBe(false);
    expect(finish).not.toHaveBeenCalled();
    expect(bindings.publicationOf("run")).toEqual({ blocked: "publication outcome is uncertain" });
    expect(await bindings.beginBranch("run", update)).toBeUndefined();
  });

  it("never admits a branch recorder for an existing PR", () => {
    const bindings = new GitBindings();
    expect(bindings.register("run", { repo: "o/r", ref: "feature" }, undefined, undefined, true)).toBe(true);
    expect(bindings.setBranchRecorder("run", { begin: async () => true, finish: async () => true })).toBe(false);
  });

  it("ends branch admission before waiting while a forwarded claim may still settle", async () => {
    const bindings = new GitBindings();
    const update = { ref: "refs/heads/feature", old: "a".repeat(40), next: "b".repeat(40) };
    expect(bindings.register("run", { repo: "o/r", ref: "feature" }, undefined)).toBe(true);
    expect(bindings.setBranchRecorder("run", { begin: async () => true, finish: async () => true })).toBe(true);
    const claim = await bindings.beginBranch("run", update);
    expect(claim).toBeDefined();
    expect(bindings.blockBranch("run", "run ending")).toBe(true);
    expect(await bindings.beginBranch("run", update)).toBeUndefined();
    const waiting = bindings.waitForPublication("run", 1_000);
    expect(await claim!.finish("accepted")).toBe(true);
    expect(await waiting).toBe(true);
    expect(bindings.publicationOf("run")).toEqual({ blocked: "run ending" });
  });

  it("waits for the pending claim's durable finish before letting the run seal", async () => {
    const bindings = new GitBindings();
    const old = "a".repeat(40);
    const update = { ref: "refs/heads/feature", old, next: "b".repeat(40) };
    expect(bindings.register("run", { repo: "o/r", ref: "feature" }, undefined, undefined, true)).toBe(true);
    expect(bindings.setPublication("run", { ref: "feature", expectedHeadSha: old })).toBe(true);
    expect(bindings.setPublicationRecorder("run", { begin: async () => true, finish: async () => true })).toBe(true);
    const claim = await bindings.beginPublication("run", update);
    expect(bindings.setPublication("run", { blocked: "run ending" })).toBe(true);
    const waiting = bindings.waitForPublication("run", 1_000);
    let settled = false;
    void waiting.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(await claim!.finish("accepted")).toBe(true);
    expect(await waiting).toBe(true);
    expect(bindings.publicationOf("run")).toEqual({ blocked: "run ending" });
  });

  it("times out a forwarded claim without authorizing another write", async () => {
    const bindings = new GitBindings();
    const old = "a".repeat(40);
    const update = { ref: "refs/heads/feature", old, next: "b".repeat(40) };
    expect(bindings.register("run", { repo: "o/r", ref: "feature" }, undefined, undefined, true)).toBe(true);
    expect(bindings.setPublication("run", { ref: "feature", expectedHeadSha: old })).toBe(true);
    expect(bindings.setPublicationRecorder("run", { begin: async () => true, finish: async () => true })).toBe(true);
    const claim = await bindings.beginPublication("run", update);
    expect(claim).toBeDefined();
    expect(bindings.setPublication("run", { blocked: "run ending" })).toBe(true);
    expect(await bindings.waitForPublication("run", 1)).toBe(false);
    expect(await bindings.beginPublication("run", update)).toBeUndefined();
    expect(await claim!.finish("unknown")).toBe(false);
    expect(bindings.publicationOf("run")).toEqual({ blocked: "publication outcome is uncertain" });
  });

  it("holds a first repository and branch only after each durable write succeeds", async () => {
    const bindings = new GitBindings();
    const persist = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    expect(bindings.register("run", {}, undefined, persist)).toBe(true);
    expect(await bindings.bindRepo("run", "o/r")).toBe(false);
    expect(bindings.get("run")).toEqual({ repo: undefined, ref: undefined });
    expect(await bindings.bindRepo("run", "o/r")).toBe(true);
    expect(await bindings.bindRef("run", "refs/heads/feature")).toBe(true);
    expect(bindings.get("run")).toEqual({ repo: "o/r", ref: "refs/heads/feature", refConfirmed: false });
    expect(await bindings.confirmRef("run", "refs/heads/feature")).toBe(false);
    expect(bindings.get("run")?.refConfirmed).toBe(false);
    expect(await bindings.confirmRef("run", "refs/heads/feature")).toBe(true);
    expect(bindings.get("run")?.refConfirmed).toBe(true);
    expect(await bindings.bindRef("run", "refs/heads/other")).toBe(false);
    expect(await bindings.bindRepo("run", "other/r")).toBe(false);
    expect(persist).toHaveBeenCalledTimes(5);
  });

  it("rejects a carried target that conflicts with the run's resolved target", () => {
    const bindings = new GitBindings();
    expect(
      bindings.register("run", { repo: "o/r", ref: "feature" }, { repo: "o/other", ref: "feature" }, async () => true),
    ).toBe(false);
    expect(bindings.get("run")).toBeUndefined();
    expect(
      bindings.register("run", { repo: "o/r", ref: "feature" }, { repo: "o/r", ref: "feature" }, async () => true),
    ).toBe(true);
  });

  it("restores pending and confirmed first-branch states without elevating a legacy row", () => {
    const bindings = new GitBindings();
    const ref = "refs/heads/feature";
    expect(bindings.register("pending", { repo: "o/r" }, { repo: "o/r", ref, refConfirmed: false })).toBe(true);
    expect(bindings.get("pending")).toMatchObject({ ref, refConfirmed: false });
    expect(bindings.register("confirmed", { repo: "o/r" }, { repo: "o/r", ref, refConfirmed: true })).toBe(true);
    expect(bindings.get("confirmed")).toMatchObject({ ref, refConfirmed: true });
    expect(bindings.register("legacy", { repo: "o/r" }, { repo: "o/r", ref })).toBe(true);
    expect(bindings.get("legacy")).toMatchObject({ ref, refConfirmed: false });
  });
});
