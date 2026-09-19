import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

// The refresh cycle's rebuild no longer holds the mirror mutex for the build
// (docs/reference/specs/resident-repos.md item 47): a heavy build used to hold
// the lock for minutes and push concurrent attaches past ATTACH_MUTEX_WAIT_MS
// (60 s) into mirror-busy 503s and cold fallbacks. `runBuild` now takes the
// lock twice, briefly — the staging seed (a consistent hardlink copy of the
// warm checkout, plus the mirror fetch into the staging tree) and the swap
// (two renames, the markers moving with the tree) — while the reset/clean,
// the deps-view re-link and the build itself run OUTSIDE the lock in the
// staging tree. materializeThreadDeps keeps its torn-cache guarantee: its
// `cp -al` still reads CHECKOUT_DIR under the same mutex, and the checkout
// now changes only by rename under that mutex. Plain Node, the entry read as
// text, never loaded — like instanceStep.test.ts.

const source = readSource("worker.ts");

/** One method of the entry's classes, asserting the entry declares it. */
function method(name: string): string {
  const body = methodOf(source, name);
  expect(body, `worker.ts declares ${name}`).not.toBeNull();
  return body!;
}

describe("the refresh rebuild holds the mirror lock only to stage and to swap — never for the build", () => {
  const body = method("runBuild");

  it("takes the lock exactly twice, under the stage and swap leases", () => {
    expect(body.match(/withMirrorLock\(/g)?.length).toBe(2);
    expect(body).toContain('step: "checkout-stage"');
    expect(body).toContain('step: "checkout-swap"');
  });

  it("no lock lease budgets the build — REFRESH_BUILD_TIMEOUT_MS bounds only the off-lock build command", () => {
    expect(body).not.toMatch(/budgetMs:[^}]*REFRESH_BUILD_TIMEOUT_MS/);
  });

  it("the staging seed and the mirror fetch sit inside the stage lock; reset/clean, deps view and build run between the locks; the swap closes under the swap lock", () => {
    // withMirrorLock(callback, 0, {step}) — the lease literal follows its
    // callback's body, so each lease marks where its locked section ENDS.
    const at = {
      seed: body.indexOf("stageCheckoutScript("),
      fetch: body.indexOf("CHECKOUT_FETCH_COMMAND"),
      stageLease: body.indexOf('step: "checkout-stage"'),
      update: body.indexOf("checkoutUpdateCommand("),
      view: body.indexOf("linkDepsView("),
      build: body.indexOf("buildUserRun(input.buildCmd"),
      swap: body.indexOf("swapCheckoutScript("),
      swapLease: body.indexOf('step: "checkout-swap"'),
    };
    for (const [name, index] of Object.entries(at)) expect(index, `runBuild names ${name}`).toBeGreaterThan(-1);
    expect(at.seed, "the seed is inside the stage lock").toBeLessThan(at.stageLease);
    expect(at.fetch, "the mirror fetch is inside the stage lock").toBeLessThan(at.stageLease);
    expect(at.update, "the reset/clean runs after the stage lock").toBeGreaterThan(at.stageLease);
    expect(at.view, "the deps view is re-linked off-lock").toBeGreaterThan(at.stageLease);
    expect(at.view).toBeLessThan(at.build);
    expect(at.build, "the build runs before the swap lock is taken").toBeLessThan(at.swap);
    expect(at.swap, "the swap is inside the swap lock").toBeLessThan(at.swapLease);
  });

  it("between the locks nothing touches the warm checkout — every off-lock command names the staging tree", () => {
    const stageLease = body.indexOf('step: "checkout-stage"');
    const between = body.slice(stageLease, body.indexOf("withMirrorLock(", stageLease));
    expect(between).not.toMatch(/(?<!STAGING_|RETIRED_)CHECKOUT_DIR/);
  });

  it("the markers move with the tree — written inside the swap lock, after the renames", () => {
    const swap = body.indexOf("swapCheckoutScript(");
    const swapLease = body.indexOf('step: "checkout-swap"');
    for (const marker of ["writeDiskMarkers({ depsKey", "writeDiskMarkers({ builtSha"]) {
      const at = body.indexOf(marker);
      expect(at, `${marker} follows the renames`).toBeGreaterThan(swap);
      expect(at, `${marker} is inside the swap lock`).toBeLessThan(swapLease);
    }
  });

  it("a failed rebuild's leftover staging tree is swept and removed BEFORE the stage lock is taken — never under it", () => {
    const clear = body.indexOf('"checkout-stage-clear"');
    expect(clear, "runBuild clears the leftover staging tree").toBeGreaterThan(-1);
    expect(clear, "the clear runs off-lock, before the stage lease").toBeLessThan(body.indexOf("withMirrorLock("));
    expect(body.indexOf("checkout-stage-stale-sweep"), "stale writers are killed before the rm").toBeLessThan(clear);
  });

  it("the stage lease budgets the section's own sum — the stage script plus the mirror fetch, one git-network budget each", () => {
    expect(body).toContain('step: "checkout-stage", budgetMs: 2 * GIT_NETWORK_TIMEOUT_MS');
  });

  it("the retired tree is removed after the swap lock is released — the lock is never held for a large rm", () => {
    const retire = body.indexOf('"checkout-retire"');
    expect(retire, "runBuild removes the retired tree").toBeGreaterThan(-1);
    expect(retire).toBeGreaterThan(body.indexOf('step: "checkout-swap"'));
  });
});

describe("materializeThreadDeps keeps its torn-cache guarantee", () => {
  it("materializeDepsView still hardlink-copies under the mirror mutex, bounded by the attach wait", () => {
    const body = method("materializeDepsView");
    expect(body).toContain("withMirrorLock");
    expect(body).toContain("ATTACH_MUTEX_WAIT_MS");
  });
});
