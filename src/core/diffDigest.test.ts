import { describe, expect, it } from "vitest";
import { distillDiffStats, parseDigestReport } from "./diffDigest.js";

// Feature: docs/reference/specs/distilled-diffs.md. distillDiffStats is the
// pure, I/O-free core the diff_digest tool renders: `git diff --numstat` +
// `git diff --name-status` for one range in, a compact digest (per-file
// +adds/-dels, totals, risky-file flags) and its totals out. These tests pin
// the parse, the totals and the risky-flag heuristics.

const NUMSTAT = [
  "3\t1\tsrc/core/foo.ts",
  "2\t0\tdb/migrations/001_init.sql",
  "1\t1\tsrc/auth/login.ts",
  "0\t3\tsrc/old/legacy.ts",
  "5\t2\tpackage-lock.json",
].join("\n");

const NAME_STATUS = [
  "M\tsrc/core/foo.ts",
  "A\tdb/migrations/001_init.sql",
  "M\tsrc/auth/login.ts",
  "D\tsrc/old/legacy.ts",
  "M\tpackage-lock.json",
].join("\n");

describe("distillDiffStats", () => {
  it("computes correct per-file and total add/delete counts", () => {
    const { text, totals } = distillDiffStats(NUMSTAT, NAME_STATUS);
    expect(text).toContain("5 files changed, +11 -7");
    expect(text).toContain("src/core/foo.ts  +3 -1");
    expect(text).toContain("db/migrations/001_init.sql  +2 -0");
    expect(text).toContain("src/auth/login.ts  +1 -1");
    expect(text).toContain("src/old/legacy.ts  +0 -3");
    expect(text).toContain("package-lock.json  +5 -2");
    expect(totals).toEqual({ files: 5, additions: 11, deletions: 7 });
  });

  it("orders files by churn, largest first", () => {
    const { text } = distillDiffStats(NUMSTAT, NAME_STATUS);
    const order = ["package-lock.json", "src/core/foo.ts", "src/old/legacy.ts"].map((p) => text.indexOf(p));
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it("labels file status (added / deleted / renamed) from the name-status listing", () => {
    const { text } = distillDiffStats(
      "2\t0\ta.ts\n0\t3\tb.ts\n1\t1\tsrc/{old.ts => new.ts}",
      "A\ta.ts\nD\tb.ts\nR090\tsrc/old.ts\tsrc/new.ts",
    );
    expect(text).toContain("a.ts  +2 -0  (added)");
    expect(text).toContain("b.ts  +0 -3  (deleted)");
    // the rename shows its NEW path, plainly — not git's compact `{a => b}` form
    expect(text).toContain("src/new.ts  +1 -1  (renamed)");
    expect(text).not.toContain("=>");
  });

  it("flags risky files: migration, auth, whole-file deletion, lockfile", () => {
    const { text } = distillDiffStats(NUMSTAT, NAME_STATUS);
    expect(text).toContain("Risky files");
    expect(text).toMatch(/db\/migrations\/001_init\.sql — .*migration\/schema/);
    expect(text).toMatch(/src\/auth\/login\.ts — .*auth\/permission-sensitive/);
    expect(text).toMatch(/src\/old\/legacy\.ts — .*whole-file deletion/);
    expect(text).toMatch(/package-lock\.json — .*lockfile/);
  });

  it("does not flag ordinary source files as risky", () => {
    const { text } = distillDiffStats("1\t0\tsrc/core/foo.ts", "M\tsrc/core/foo.ts");
    expect(text).toContain("1 file changed, +1 -0");
    expect(text).not.toContain("Risky files");
  });

  it("flags a very large file by total churn", () => {
    const { text } = distillDiffStats("200\t150\tsrc/big.ts", "M\tsrc/big.ts");
    expect(text).toMatch(/src\/big\.ts — large change \(350 lines\)/);
  });

  it("detects binary files (numstat `-\\t-`) without counting content lines", () => {
    const { text, totals } = distillDiffStats("-\t-\tassets/logo.png\n1\t0\ta.ts", "M\tassets/logo.png\nM\ta.ts");
    expect(text).toContain("assets/logo.png  +0 -0  (binary)");
    expect(totals).toEqual({ files: 2, additions: 1, deletions: 0 });
  });

  it("returns an empty-diff message with zero totals for empty or whitespace input", () => {
    for (const s of ["", "   \n  "]) {
      const { text, totals } = distillDiffStats(s, s);
      expect(text).toMatch(/no changes/i);
      expect(totals).toEqual({ files: 0, additions: 0, deletions: 0 });
    }
  });

  it("tolerates listings that do not align (a stray line) without throwing or dropping files", () => {
    // Three numstat rows, two name-status rows: the paths come from numstat
    // and every file still counts.
    const { text, totals } = distillDiffStats("1\t0\ta.ts\n2\t0\tb.ts\n3\t0\tc.ts", "M\ta.ts\ngarbage\nM\tc.ts");
    expect(totals.files).toBe(3);
    expect(text).toContain("a.ts  +1 -0");
    expect(text).toContain("b.ts  +2 -0");
    expect(text).toContain("c.ts  +3 -0");
  });

  it("uses singular wording for a single-file diff", () => {
    const { text } = distillDiffStats("1\t0\tsrc/only.ts", "M\tsrc/only.ts");
    expect(text).toContain("1 file changed");
    expect(text).not.toContain("1 files changed");
  });

  it("flags a risky file renamed to a bland name (old-side risk)", () => {
    const { text } = distillDiffStats("1\t1\tsrc/{auth/x.ts => misc/y.ts}", "R095\tsrc/auth/x.ts\tsrc/misc/y.ts");
    expect(text).toContain("src/misc/y.ts  +1 -1  (renamed)");
    expect(text).toMatch(/src\/misc\/y\.ts — .*auth\/permission-sensitive/);
  });

  it("flags a secrets file relocated to a non-secret name (.env → config.json)", () => {
    const { text } = distillDiffStats("0\t0\t.env => config.json", "R100\t.env\tconfig.json");
    expect(text).toMatch(/config\.json — .*auth\/permission-sensitive/);
  });

  it("decodes git-quoted non-ASCII filenames", () => {
    const { text } = distillDiffStats('1\t0\t"docs/caf\\303\\251.md"', 'A\t"docs/caf\\303\\251.md"');
    expect(text).toContain("docs/café.md  +1 -0  (added)");
    expect(text).not.toContain("\\303");
  });

  it("flags infra/deploy/CI config files", () => {
    const { text } = distillDiffStats(
      "1\t0\t.github/workflows/ci.yml\n1\t0\tinfra/main.tf\n1\t0\tdeploy/Dockerfile\n1\t0\tdeploy/cloudflare/wrangler.jsonc",
      "M\t.github/workflows/ci.yml\nM\tinfra/main.tf\nM\tdeploy/Dockerfile\nM\tdeploy/cloudflare/wrangler.jsonc",
    );
    for (const p of [
      ".github/workflows/ci.yml",
      "infra/main.tf",
      "deploy/Dockerfile",
      "deploy/cloudflare/wrangler.jsonc",
    ]) {
      expect(text).toMatch(new RegExp(`${p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} — .*infra/deploy config`));
    }
  });
});

describe("parseDigestReport (a ledger row read back on resume)", () => {
  it("accepts both shapes and refuses anything malformed", () => {
    const complete = { complete: true, base: "origin/main", totals: { files: 3, additions: 10, deletions: 2 } };
    expect(parseDigestReport(complete)).toEqual(complete);
    const cut = { complete: false, base: "origin/main", reason: "output cut" };
    expect(parseDigestReport(cut)).toEqual(cut);
    for (const bad of [
      undefined,
      null,
      "x",
      { complete: true, base: "b" },
      { complete: true, base: "b", totals: { files: -1, additions: 0, deletions: 0 } },
      { complete: true, base: "b", totals: { files: 1.5, additions: 0, deletions: 0 } },
      { complete: false, base: "b" },
      { complete: true, totals: { files: 1, additions: 0, deletions: 0 } },
    ]) {
      expect(parseDigestReport(bad)).toBeUndefined();
    }
  });
});
