import { describe, expect, it } from "vitest";
import { selectBindingsToPurge } from "./bindingPurge.js";

// The resident keeps a thread binding after eviction by design (docs/reference/specs/
// resident-repos.md item 23) — so a load run that attaches fifty synthetic
// threads leaves fifty evicted rows on the resident's detail page forever. The
// `purge-bindings` debug op (item 56) deletes exactly the bindings a harness
// created and no longer needs; this is its decision, pure and testable.

const b = (threadKey: string, evicted: boolean) => ({ threadKey, evicted });

describe("selectBindingsToPurge", () => {
  it("selects evicted bindings under the prefix, keeps live ones under it (named), and never touches other namespaces", () => {
    const decision = selectBindingsToPurge(
      [b("load:r1:0", true), b("load:r1:1", false), b("load:r2:0", true), b("slack:C1:1.0", true), b("cli:x", false)],
      "load:",
    );
    expect(decision).toEqual({ ok: true, purge: ["load:r1:0", "load:r2:0"], keptLive: ["load:r1:1"] });
  });

  it("a narrower prefix (one load run) purges only that run's bindings", () => {
    const decision = selectBindingsToPurge([b("load:r1:0", true), b("load:r2:0", true)], "load:r1:");
    expect(decision).toEqual({ ok: true, purge: ["load:r1:0"], keptLive: [] });
  });

  it("refuses a prefix that is not a whole namespace or longer: empty, no colon, or a bare partial namespace", () => {
    for (const prefix of ["", "load", "l", "slack"]) {
      const d = selectBindingsToPurge([b("load:r1:0", true)], prefix);
      expect(d.ok).toBe(false);
      expect(!d.ok && d.error).toMatch(/prefix/);
    }
  });

  it("refuses the production namespaces outright — a purge is for synthetic keys only", () => {
    for (const prefix of ["slack:", "slack:C1:", "http:", "mcp:", "cli:"]) {
      const d = selectBindingsToPurge([b(`${prefix}x`, true)], prefix);
      expect(d.ok).toBe(false);
      expect(!d.ok && d.error).toMatch(/production namespace/);
    }
  });

  it("nothing under the prefix → ok with an empty purge list", () => {
    expect(selectBindingsToPurge([b("slack:C1:1.0", true)], "load:")).toEqual({ ok: true, purge: [], keptLive: [] });
  });
});
