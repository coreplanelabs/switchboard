import { describe, expect, it } from "vitest";
import { distillDiff } from "./diffDigest.js";

// Feature: features/validated-review.md (R14). distillDiff is the pure,
// I/O-free core the diff_digest tool renders: unified diff -> compact digest
// (per-file +adds/-dels, totals, risky-file flags). These tests pin the
// parse counts and the risky-flag heuristics.

const MULTI_FILE_DIFF = `diff --git a/src/core/foo.ts b/src/core/foo.ts
index 1111111..2222222 100644
--- a/src/core/foo.ts
+++ b/src/core/foo.ts
@@ -1,4 +1,6 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
+const d = 5;
 const e = 6;
diff --git a/db/migrations/001_init.sql b/db/migrations/001_init.sql
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/db/migrations/001_init.sql
@@ -0,0 +1,2 @@
+CREATE TABLE users (id int);
+CREATE INDEX idx_users ON users (id);
diff --git a/src/auth/login.ts b/src/auth/login.ts
index 4444444..5555555 100644
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -1,2 +1,2 @@
-const x = 1;
+const x = 2;
diff --git a/src/old/legacy.ts b/src/old/legacy.ts
deleted file mode 100644
index 6666666..0000000
--- a/src/old/legacy.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line1
-line2
-line3
diff --git a/package-lock.json b/package-lock.json
index 7777777..8888888 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,5 +1,8 @@
 {
-  "a": 1,
-  "b": 2,
+  "a": 2,
+  "b": 3,
+  "c": 4,
+  "d": 5,
+  "e": 6
 }
`;

describe("distillDiff", () => {
  it("computes correct per-file and total add/delete counts", () => {
    const out = distillDiff(MULTI_FILE_DIFF);
    // totals: adds 3+2+1+0+5 = 11, dels 1+0+1+3+2 = 7, across 5 files
    expect(out).toContain("5 files changed, +11 -7");
    // per-file lines
    expect(out).toContain("src/core/foo.ts  +3 -1");
    expect(out).toContain("db/migrations/001_init.sql  +2 -0");
    expect(out).toContain("src/auth/login.ts  +1 -1");
    expect(out).toContain("src/old/legacy.ts  +0 -3");
    expect(out).toContain("package-lock.json  +5 -2");
  });

  it("labels file status (added / deleted) and resolves deleted paths from the a/ side", () => {
    const out = distillDiff(MULTI_FILE_DIFF);
    expect(out).toContain("db/migrations/001_init.sql  +2 -0  (added)");
    expect(out).toContain("src/old/legacy.ts  +0 -3  (deleted)");
  });

  it("flags risky files: migration, auth, whole-file deletion, lockfile", () => {
    const out = distillDiff(MULTI_FILE_DIFF);
    expect(out).toMatch(/Risky files/i);
    expect(out).toMatch(/db\/migrations\/001_init\.sql — .*migration/i);
    expect(out).toMatch(/src\/auth\/login\.ts — .*auth/i);
    expect(out).toMatch(/src\/old\/legacy\.ts — .*whole-file deletion/i);
    expect(out).toMatch(/package-lock\.json — .*lockfile/i);
  });

  it("does not flag ordinary source files as risky", () => {
    const out = distillDiff(MULTI_FILE_DIFF);
    // foo.ts is a plain modified source file — it must not appear in the
    // risky section (only in the per-file listing).
    const riskyIdx = out.indexOf("Risky files");
    expect(riskyIdx).toBeGreaterThan(-1);
    expect(out.slice(riskyIdx)).not.toContain("src/core/foo.ts");
  });

  it("flags a very large file by total churn", () => {
    const body = Array.from({ length: 400 }, (_, i) => `+line ${i}`).join("\n");
    const diff = `diff --git a/src/huge.ts b/src/huge.ts
index aaa..bbb 100644
--- a/src/huge.ts
+++ b/src/huge.ts
@@ -0,0 +1,400 @@
${body}
`;
    const out = distillDiff(diff);
    expect(out).toContain("src/huge.ts  +400 -0");
    expect(out).toMatch(/src\/huge\.ts — .*large change \(400 lines\)/i);
  });

  it("detects binary files without counting content lines", () => {
    const diff = `diff --git a/assets/logo.png b/assets/logo.png
index aaa..bbb 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`;
    const out = distillDiff(diff);
    expect(out).toContain("assets/logo.png  +0 -0  (binary)");
  });

  it("returns an empty-diff message for empty or whitespace input", () => {
    expect(distillDiff("")).toMatch(/no changes/i);
    expect(distillDiff("   \n  ")).toMatch(/no changes/i);
  });

  it("tolerates a malformed hunk (missing @@ header) without throwing", () => {
    // No @@ header at all — still count the +/- content lines.
    const diff = `diff --git a/src/broken.ts b/src/broken.ts
index aaa..bbb 100644
--- a/src/broken.ts
+++ b/src/broken.ts
+added one
+added two
-removed one
`;
    let out = "";
    expect(() => {
      out = distillDiff(diff);
    }).not.toThrow();
    expect(out).toContain("src/broken.ts  +2 -1");
  });

  it("uses singular wording for a single-file diff", () => {
    const diff = `diff --git a/a.ts b/a.ts
index aaa..bbb 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-x
+y
`;
    expect(distillDiff(diff)).toContain("1 file changed, +1 -1");
  });
});
