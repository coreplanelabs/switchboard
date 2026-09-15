import { describe, expect, it } from "vitest";
import { LocalExecutor, type Executor } from "../execution/executor.js";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DigestReport } from "../core/diffDigest.js";
import { TOOLSETS } from "./toolsets.js";
import { diffDigestTool } from "./diffDigest.js";
import type { ToolContext } from "./runnableTool.js";

// Feature: docs/reference/specs/distilled-diffs.md. The diff_digest tool is a thin
// wrapper: it runs `git diff --numstat` + `--name-status` over `<base>...HEAD`
// through the Executor seam and distills the listing. Most tests use a fake
// Executor; the last one runs the real LocalExecutor on a real repository.

function ctxWith(exec: (cmd: string) => Promise<string>): ToolContext {
  const executor: Executor = {
    exec,
    readFile: async () => "",
    writeFile: async () => "Wrote",
  };
  return { executor };
}

/** What the tool's one listing command answers: numstat, the marker, name-status. */
const LISTING = (numstat: string, nameStatus: string) => `${numstat}\n@@diff_digest:name-status@@\n${nameStatus}\n`;
const ONE_FILE = LISTING("1\t0\tsrc/a.ts", "M\tsrc/a.ts");

/** A fake executor that answers each command from a script, recording them. */
function scripted(answers: Array<(cmd: string) => string>) {
  const commands: string[] = [];
  const ctx = ctxWith(async (cmd) => {
    commands.push(cmd);
    const next = answers.shift();
    if (!next) throw new Error(`unexpected command: ${cmd}`);
    return next(cmd);
  });
  return { ctx, commands };
}

describe("diff_digest tool", () => {
  it("distills the file listing the executor returns and reports its totals through onDigest", async () => {
    const reports: DigestReport[] = [];
    const ctx = ctxWith(async () => ONE_FILE);
    ctx.onDigest = (r) => reports.push(r);
    const out = await diffDigestTool.run({}, ctx);
    expect(out).toContain("1 file changed, +1 -0");
    expect(out).toContain("src/a.ts  +1 -0");
    expect(reports).toEqual([
      { complete: true, base: "origin/HEAD", totals: { files: 1, additions: 1, deletions: 0 } },
    ]);
  });

  it("runs the merge-base range as stats — `--numstat` and `--name-status` over `<base>...HEAD` — never the unified diff", async () => {
    const { ctx, commands } = scripted([() => ONE_FILE]);
    await diffDigestTool.run({ base: "release-1.2" }, ctx);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("git diff --numstat --end-of-options 'release-1.2'...HEAD");
    expect(commands[0]).toContain("git diff --name-status --end-of-options 'release-1.2'...HEAD");
    expect(commands[0]).not.toMatch(/git diff --end-of-options/);
    expect(commands[0]).not.toMatch(/HEAD~/);
  });

  it("defaults to the repo's default branch (origin/HEAD) when no base is given", async () => {
    const { ctx, commands } = scripted([() => ONE_FILE]);
    await diffDigestTool.run({}, ctx);
    expect(commands[0]).toContain("origin/HEAD");
  });

  it("surfaces a git failure instead of reporting an empty diff, and reports no digest", async () => {
    const reports: DigestReport[] = [];
    const { ctx } = scripted([
      () => "exit 128: fatal: bad revision 'nope...HEAD'",
      () => "false", // not a shallow clone → no fetch, the failure stands
    ]);
    ctx.onDigest = (r) => reports.push(r);
    const out = await diffDigestTool.run({ base: "nope" }, ctx);
    expect(out).toMatch(/could not compute/i);
    expect(out).toContain("fatal: bad revision");
    expect(out).not.toMatch(/no changes/i);
    expect(reports).toEqual([]);
  });

  it("a shallow clone with no merge base is deepened once (every branch), then the listing is retried", async () => {
    const { ctx, commands } = scripted([
      () => "exit 128: fatal: origin/main...HEAD: no merge base",
      () => "true\n",
      () => "",
      () => ONE_FILE,
    ]);
    const out = await diffDigestTool.run({}, ctx);
    expect(commands[1]).toBe("git rev-parse --is-shallow-repository");
    expect(commands[2]).toContain("git fetch --unshallow");
    expect(commands[2]).toContain("+refs/heads/*:refs/remotes/origin/*");
    expect(commands[3]).toBe(commands[0]);
    expect(out).toContain("1 file changed, +1 -0");
  });

  it("a full clone is never fetched: the failure is reported as is", async () => {
    const { ctx, commands } = scripted([() => "exit 128: fatal: origin/main...HEAD: no merge base", () => "false"]);
    const out = await diffDigestTool.run({}, ctx);
    expect(commands).toHaveLength(2);
    expect(commands.some((c) => c.includes("git fetch"))).toBe(false);
    expect(out).toMatch(/could not compute/i);
  });

  it("a listing cut by the executor's output cap is reported as incomplete — never rendered as a smaller change", async () => {
    const reports: DigestReport[] = [];
    const cut = `${"1\t0\tsrc/a.ts\n".repeat(3)}@@diff_digest:name-status@@\nM\tsrc/a.ts\n...[truncated 9000 chars]`;
    const ctx = ctxWith(async () => cut);
    ctx.onDigest = (r) => reports.push(r);
    const out = await diffDigestTool.run({}, ctx);
    expect(out).toMatch(/cannot state totals/);
    expect(out).not.toMatch(/files changed/);
    expect(reports).toEqual([{ complete: false, base: "origin/HEAD", reason: expect.stringMatching(/output cap/) }]);
  });

  it("a listing cut BEFORE the marker is still incomplete — never 'could not compute', and no shallow probe or fetch", async () => {
    const reports: DigestReport[] = [];
    const cut = `${"1\t0\tsrc/a.ts\n".repeat(3)}...[truncated 9000 chars]`;
    const { ctx, commands } = scripted([() => cut]);
    ctx.onDigest = (r) => reports.push(r);
    const out = await diffDigestTool.run({}, ctx);
    expect(out).toMatch(/cannot state totals/);
    expect(out).not.toMatch(/could not compute/);
    expect(commands).toHaveLength(1);
    expect(reports).toEqual([{ complete: false, base: "origin/HEAD", reason: expect.stringMatching(/output cap/) }]);
  });

  it("a path that contains the marker text does not corrupt the split — the marker is a whole line, never a substring", async () => {
    const weird = "docs/@@diff_digest:name-status@@.md";
    const listing = LISTING(`1\t0\tsrc/a.ts\n2\t0\t${weird}`, `M\tsrc/a.ts\nA\t${weird}`);
    const out = await diffDigestTool.run(
      {},
      ctxWith(async () => listing),
    );
    expect(out).toContain("2 files changed, +3 -0");
    expect(out).toContain(`${weird}  +2 -0  (added)`);
  });

  it("does not shell-inject through the base ref", async () => {
    const { ctx, commands } = scripted([() => ONE_FILE]);
    await diffDigestTool.run({ base: "a'; rm -rf /; echo '" }, ctx);
    // the malicious ref must be a single quoted shell token, not runnable code:
    // the embedded quotes are escaped so the injected `;` stays inside the arg.
    expect(commands[0]).toContain("git diff --numstat --end-of-options 'a'\\''; rm -rf /; echo '\\'''...HEAD");
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
        return ONE_FILE;
      }),
    );
    expect(out).toMatch(/may not start with '-'/);
    expect(called).toBe(false);
  });

  it("passes --end-of-options so a ref is never parsed as a git option", async () => {
    const { ctx, commands } = scripted([() => ONE_FILE]);
    await diffDigestTool.run({ base: "main" }, ctx);
    expect(commands[0]).toContain("--end-of-options");
  });
});

// The failure that motivated the stat listing, on a real repository through
// the real LocalExecutor (which caps output at 120k chars like every
// executor): a branch of several commits, one of them larger than the cap.
// The old tool distilled `git diff` and, on a change this size, counted only
// the first files of the alphabetical diff.
describe("diff_digest tool on a real multi-commit branch (LocalExecutor)", () => {
  const sh = (cwd: string, cmd: string) =>
    execSync(cmd, {
      cwd,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).toString();

  it("covers every commit's files and states exact totals even when the unified diff exceeds the output cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "digest-"));
    sh(dir, "git init -q -b main upstream");
    const up = join(dir, "upstream");
    writeFileSync(join(up, "README.md"), "hello\n");
    sh(up, "git add . && git commit -qm base");
    sh(up, "git checkout -qb feature");
    // commit 1: a file sorted FIRST alphabetically, bigger than the 120k cap on its own
    writeFileSync(
      join(up, "a-huge.txt"),
      Array.from({ length: 6000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n") + "\n",
    );
    sh(up, "git add . && git commit -qm huge");
    // commit 2 + 3: files sorted AFTER it — the ones a cut diff loses
    mkdirSync(join(up, "src"), { recursive: true });
    writeFileSync(join(up, "src/late.ts"), "export const a = 1;\nexport const b = 2;\n");
    sh(up, "git add . && git commit -qm late");
    writeFileSync(join(up, "zz-last.md"), "tail\n");
    writeFileSync(join(up, "README.md"), "hello\nworld\n");
    sh(up, "git add . && git commit -qm last");
    sh(up, "git checkout -q main"); // the upstream's HEAD is its default branch, as GitHub's is
    // the clone the tool runs in, with origin/HEAD → main as a real clone has
    sh(dir, "git clone -q --branch feature upstream wt");
    const wt = join(dir, "wt");

    const reports: DigestReport[] = [];
    const ctx: ToolContext = { executor: new LocalExecutor(wt), onDigest: (r) => reports.push(r) };
    const out = await diffDigestTool.run({}, ctx);
    expect(out).toContain("4 files changed, +6004 -0");
    for (const f of ["a-huge.txt", "src/late.ts", "zz-last.md", "README.md"]) expect(out).toContain(f);
    expect(reports).toEqual([
      { complete: true, base: "origin/HEAD", totals: { files: 4, additions: 6004, deletions: 0 } },
    ]);
    rmSync(dir, { recursive: true, force: true });
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

// Feature: docs/reference/specs/agent-review.md — the structured verdict channel. The
// review agent states approve/request_changes through this tool; the
// dispatcher (not the model) writes the `LGTM:` line from it.
