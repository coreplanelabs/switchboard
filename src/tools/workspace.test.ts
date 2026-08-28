import { describe, expect, it } from "vitest";
import type { Executor } from "../execution/executor.js";
import { diffDigestTool, submitVerdictTool, TOOLSETS, type ToolContext } from "./workspace.js";

// Feature: features/validated-review.md (R14). The diff_digest tool is a thin
// wrapper: it runs `git diff <base>...HEAD` through the Executor seam and
// distills the raw output. These tests use a fake Executor so no repo/process
// is needed.

function ctxWith(exec: (cmd: string) => Promise<string>): ToolContext {
  const executor: Executor = {
    exec,
    readFile: async () => "",
    writeFile: async () => "Wrote",
  };
  return { executor };
}

const SAMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index aaa..bbb 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
 x
+y
`;

describe("diff_digest tool", () => {
  it("distills the diff the executor returns", async () => {
    const out = await diffDigestTool.run({}, ctxWith(async () => SAMPLE_DIFF));
    expect(out).toContain("1 file changed, +1 -0");
    expect(out).toContain("src/a.ts  +1 -0");
  });

  it("diffs against the provided base ref", async () => {
    let captured = "";
    await diffDigestTool.run(
      { base: "release-1.2" },
      ctxWith(async (cmd) => {
        captured = cmd;
        return SAMPLE_DIFF;
      }),
    );
    expect(captured).toContain("git diff");
    expect(captured).toContain("release-1.2");
    expect(captured).toContain("...HEAD");
  });

  it("defaults to the repo's default branch (origin/HEAD) when no base is given", async () => {
    let captured = "";
    await diffDigestTool.run(
      {},
      ctxWith(async (cmd) => {
        captured = cmd;
        return SAMPLE_DIFF;
      }),
    );
    expect(captured).toContain("origin/HEAD");
  });

  it("surfaces a git failure instead of reporting an empty diff", async () => {
    const out = await diffDigestTool.run(
      { base: "nope" },
      ctxWith(async () => "exit 128: fatal: bad revision 'nope...HEAD'"),
    );
    expect(out).toMatch(/could not compute/i);
    expect(out).toContain("fatal: bad revision");
    expect(out).not.toMatch(/no changes/i);
  });

  it("does not shell-inject through the base ref", async () => {
    let captured = "";
    await diffDigestTool.run(
      { base: "a'; rm -rf /; echo '" },
      ctxWith(async (cmd) => {
        captured = cmd;
        return SAMPLE_DIFF;
      }),
    );
    // the malicious ref must be a single quoted shell token, not runnable code:
    // the embedded quotes are escaped so the injected `;` stays inside the arg.
    expect(captured).toContain("git diff --end-of-options 'a'\\''; rm -rf /; echo '\\'''...HEAD");
  });

  // Review finding 2: git OPTION injection (distinct from shell injection). A
  // base starting with '-' would be parsed by git as an option (e.g.
  // --output=/path → arbitrary file write). It must be rejected before exec.
  it("rejects a base ref starting with '-' (git option injection) without running git", async () => {
    let called = false;
    const out = await diffDigestTool.run(
      { base: "--output=/tmp/pwn" },
      ctxWith(async () => {
        called = true;
        return SAMPLE_DIFF;
      }),
    );
    expect(out).toMatch(/may not start with '-'/);
    expect(called).toBe(false);
  });

  it("passes --end-of-options so a ref is never parsed as a git option", async () => {
    let captured = "";
    await diffDigestTool.run(
      { base: "main" },
      ctxWith(async (cmd) => {
        captured = cmd;
        return SAMPLE_DIFF;
      }),
    );
    expect(captured).toContain("--end-of-options");
  });
});

describe("diff_digest toolset wiring", () => {
  it("is in the coding (full) and review (readonly) toolsets, not web/none", () => {
    const names = (key: string) => (TOOLSETS[key] ?? []).map((t) => t.name);
    expect(names("full")).toContain("diff_digest");
    expect(names("readonly")).toContain("diff_digest");
    expect(names("web")).not.toContain("diff_digest");
    expect(names("none")).not.toContain("diff_digest");
  });
});

// Feature: features/agent-review.md — the structured verdict channel. The
// review agent states approve/request_changes through this tool; the
// dispatcher (not the model) writes the `LGTM:` line from it.
describe("submit_verdict tool", () => {
  const ctxWith = (onVerdict?: ToolContext["onVerdict"]): ToolContext =>
    ({ executor: {} as ToolContext["executor"], onVerdict }) as ToolContext;

  it("is in the review (readonly) toolset only — coding and research never emit verdicts", () => {
    const names = (key: string) => (TOOLSETS[key] ?? []).map((t) => t.name);
    expect(names("readonly")).toContain("submit_verdict");
    expect(names("full")).not.toContain("submit_verdict");
    expect(names("web")).not.toContain("submit_verdict");
  });

  it("forwards a valid verdict to the context and acknowledges it", async () => {
    const got: unknown[] = [];
    const out = await submitVerdictTool.run({ verdict: "approve", summary: "clean" }, ctxWith((v) => got.push(v)));
    expect(got).toEqual([{ verdict: "approve", summary: "clean" }]);
    expect(out).toBe("verdict recorded: approve");
  });

  it("rejects anything but the two verdict values without touching the context", async () => {
    const got: unknown[] = [];
    const out = await submitVerdictTool.run({ verdict: "LGTM", summary: "x" }, ctxWith((v) => got.push(v)));
    expect(got).toEqual([]);
    expect(String(out)).toMatch(/^error:/);
  });

  it("tolerates a context with no verdict sink", async () => {
    await expect(submitVerdictTool.run({ verdict: "request_changes", summary: "bug" }, ctxWith(undefined))).resolves.toBe(
      "verdict recorded: request_changes",
    );
  });
});
