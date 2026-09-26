import { describe, expect, it, vi } from "vitest";
import { GitBindings } from "./gitBindings.js";

describe("GitBindings", () => {
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
