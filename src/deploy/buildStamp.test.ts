import { describe, expect, it } from "vitest";
import { buildStamp, defineArgs, spawnOutcome, DEFINE_COMMIT, DEFINE_BUILT_AT } from "../../deploy/bin/build-stamp.mjs";
import { buildId, injectedBuildStamp, resolveBuildStamp, UNKNOWN_COMMIT } from "./buildStamp.js";

// Feature: docs/reference/specs/execution.md item 13 — every Worker script reports the
// commit it was built from on its own /healthz, injected at deploy time. This
// replaces a hand-edited build marker, which a deploy could forget to bump and
// then could neither prove a deploy nor expire a stale test override.

describe("resolveBuildStamp (what a Worker reports)", () => {
  it("keeps an injected commit and timestamp", () => {
    expect(resolveBuildStamp("161930af4597eb8bba9d9b72bd47ed93d6d8cf85", "2026-09-04T19:02:01.000Z")).toEqual({
      commit: "161930af4597eb8bba9d9b72bd47ed93d6d8cf85",
      builtAt: "2026-09-04T19:02:01.000Z",
    });
  });

  it("keeps the -dirty suffix — a stamp must not launder an uncommitted build", () => {
    expect(resolveBuildStamp("161930a-dirty", null).commit).toBe("161930a-dirty");
  });

  it("says `unknown` for anything that is not a commit, and never invents a timestamp", () => {
    for (const bad of [null, undefined, "", "   ", 42, {}]) {
      expect(resolveBuildStamp(bad, null)).toEqual({ commit: UNKNOWN_COMMIT });
    }
    expect(resolveBuildStamp("161930a", "")).toEqual({ commit: "161930a" });
    expect(resolveBuildStamp("161930a", 1234)).toEqual({ commit: "161930a" });
  });

  it("trims, so a shell-mangled injection cannot become part of the sha", () => {
    expect(resolveBuildStamp("  161930a\n", " 2026-09-04T19:02:01.000Z ")).toEqual({
      commit: "161930a",
      builtAt: "2026-09-04T19:02:01.000Z",
    });
  });
});

describe("buildId (what a stored artifact compares against)", () => {
  it("distinguishes two builds of the same dirty tree — the same commit, different builds", () => {
    const a = buildId({ commit: "161930a-dirty", builtAt: "2026-09-04T19:02:01.000Z" });
    const b = buildId({ commit: "161930a-dirty", builtAt: "2026-09-04T21:40:00.000Z" });
    expect(a).not.toBe(b);
  });

  it("distinguishes a redeploy of the SAME clean commit — still a later build", () => {
    expect(buildId({ commit: "161930a", builtAt: "2026-09-04T19:02:01.000Z" })).not.toBe(
      buildId({ commit: "161930a", builtAt: "2026-09-04T23:00:09.000Z" }),
    );
  });

  it("is stable for one deployed version, so sibling isolates agree", () => {
    const stamp = { commit: "161930a", builtAt: "2026-09-04T19:02:01.000Z" };
    expect(buildId(stamp)).toBe(buildId({ ...stamp }));
    expect(buildId(stamp)).toBe("161930a@2026-09-04T19:02:01.000Z");
  });

  it("falls back to the commit alone when nothing stamped a time", () => {
    expect(buildId({ commit: UNKNOWN_COMMIT })).toBe(UNKNOWN_COMMIT);
  });
});

describe("injectedBuildStamp (no injection present)", () => {
  it("degrades to unknown instead of throwing on the undeclared identifiers", () => {
    // This process has no esbuild `--define`, so the globals do not exist.
    // Reading an undeclared identifier is a ReferenceError; only `typeof`
    // tolerates it. That this returns at all is the regression test.
    expect(injectedBuildStamp()).toEqual({ commit: UNKNOWN_COMMIT });
  });
});

describe("buildStamp / defineArgs (the deploy side)", () => {
  const now = new Date("2026-09-04T19:02:01.000Z");

  it("stamps the commit and the build time", () => {
    expect(buildStamp({ commit: "161930a", dirty: false, now })).toEqual({
      commit: "161930a",
      builtAt: "2026-09-04T19:02:01.000Z",
    });
  });

  it("marks a dirty tree, because wrangler builds the tree and not the commit", () => {
    expect(buildStamp({ commit: "161930a", dirty: true, now }).commit).toBe("161930a-dirty");
  });

  it("emits esbuild defines whose values are JS string literals", () => {
    expect(defineArgs({ commit: "161930a", builtAt: "2026-09-04T19:02:01.000Z" })).toEqual([
      "--define",
      `${DEFINE_COMMIT}:"161930a"`,
      "--define",
      `${DEFINE_BUILT_AT}:"2026-09-04T19:02:01.000Z"`,
    ]);
  });

  it("escapes a value that would otherwise close the literal and inject code", () => {
    const args = defineArgs({ commit: '"; globalThis.pwned = 1; "', builtAt: "x" });
    expect(args[1]).toBe(`${DEFINE_COMMIT}:"\\"; globalThis.pwned = 1; \\""`);
    expect(JSON.parse(args[1].slice(DEFINE_COMMIT.length + 1))).toBe('"; globalThis.pwned = 1; "');
  });

  it("names the same identifiers the Workers read", () => {
    expect([DEFINE_COMMIT, DEFINE_BUILT_AT]).toEqual(["SWITCHBOARD_BUILD_COMMIT", "SWITCHBOARD_BUILT_AT"]);
  });

  it("says WHY a deploy ended, so a killed wrangler is not read as a failed one", () => {
    expect(spawnOutcome({ status: 0 })).toEqual({ code: 0 });
    expect(spawnOutcome({ status: 1 })).toEqual({ code: 1 });
    expect(spawnOutcome({ error: { message: "spawn wrangler ENOENT" } })).toEqual({
      code: 1,
      message: "could not run wrangler: spawn wrangler ENOENT",
    });
    // A signal kill reports status: null — the signal is the only evidence.
    expect(spawnOutcome({ signal: "SIGINT", status: null })).toEqual({
      code: 1,
      message: "wrangler was killed by SIGINT — the deploy did not finish",
    });
    expect(spawnOutcome({ status: null })).toEqual({ code: 1, message: "wrangler exited with no status" });
  });
});
