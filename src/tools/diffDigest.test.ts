import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalExecutor, type Executor, type ExecResult } from "../execution/executor.js";
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

function ctxWith(answer: (cmd: string) => Promise<string | ExecResult>): ToolContext {
  const result = async (command: string): Promise<ExecResult> => {
    const value = await answer(command);
    return typeof value === "string" ? { stdout: value, stderr: "", exitCode: 0, truncated: false } : value;
  };
  const executor: Executor = {
    exec: async (command) => {
      const value = await result(command);
      return value.exitCode === 0 ? value.stdout : `exit ${value.exitCode}: ${value.stderr}`;
    },
    execResult: result,
    readFile: async () => "",
    writeFile: async () => "Wrote",
  };
  return { executor };
}

/** What the tool's one listing command answers: numstat, the marker, name-status. */
const LISTING = (numstat: string, nameStatus: string) => `${numstat}\n@@diff_digest:name-status@@\n${nameStatus}\n`;
const ONE_FILE = LISTING("1\t0\tsrc/a.ts", "M\tsrc/a.ts");

/** A fake executor that answers each command from a script, recording them. */
function scripted(answers: Array<(cmd: string) => string | ExecResult>) {
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
  it("logs a coding refusal with bounded reason and base context", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = ctxWith(async () => ({ stdout: "", stderr: "PRIVATE_FAILURE", exitCode: 1, truncated: false }));
    ctx.agentName = "coding";
    ctx.repo = "acme/api";
    try {
      expect(await diffDigestTool.run({}, ctx)).toContain("could not compute");
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        {
          event: "review_digest_refused",
          repo: "acme/api",
          agent: "coding",
          base: "origin/HEAD",
          reason: "command_failed",
        },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("records a bounded refusal without logging the caller's base expression", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = ctxWith(
      async () => `@@diff_digest:range@@\n${"a".repeat(40)}\n${"b".repeat(40)}\n${"a".repeat(40)}\n${ONE_FILE}`,
    );
    ctx.repo = "acme/api";
    ctx.reviewHistory = { target: { repo: "acme/api", number: 42 } };
    ctx.reviewReadTarget = () => ({
      repo: "acme/api",
      pr: 42,
      baseRef: "main",
      head: "c".repeat(40),
      base: "a".repeat(40),
    });
    try {
      expect(await diffDigestTool.run({}, ctx)).toBe(
        "diff_digest: the digest did not confirm the pinned review head and base.",
      );
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        {
          event: "review_digest_refused",
          repo: "acme/api",
          base: "canonical",
          pr: 42,
          head: "c".repeat(40),
          baseRef: "main",
          reason: "range_unconfirmed",
        },
      ]);
    } finally {
      log.mockRestore();
    }
  });

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

  it("refuses a Resident-truncated listing even when display output has no cut marker", async () => {
    const reports: DigestReport[] = [];
    const paths = Array.from({ length: 4000 }, (_, i) => `src/file-${String(i).padStart(4, "0")}.ts`);
    const listing = LISTING(
      paths.map((path) => `0\t1\t${path}`).join("\n"),
      paths.map((path) => `D\t${path}`).join("\n"),
    );
    const stdout = listing.slice(0, 100_000);
    const stderr = "output truncated to 100000 chars per stream";
    const ctx = ctxWith(async () => `${stdout}\n--- stderr ---\n${stderr}`);
    ctx.executor.execResult = async () => ({ stdout, stderr, exitCode: 0, truncated: true });
    ctx.onDigest = (report) => reports.push(report);
    const out = await diffDigestTool.run({}, ctx);
    expect(out).toContain("cannot state totals");
    expect(reports).toEqual([
      { complete: false, base: "origin/HEAD", reason: "the file listing exceeded the executor's output cap" },
    ]);
  });

  it("refuses failed listings and shallow observations before accepting their text", async () => {
    for (const stage of ["listing", "probe failed", "probe truncated", "fetch failed", "fetch truncated"] as const) {
      const reports: DigestReport[] = [];
      const ctx = ctxWith(async () => ONE_FILE);
      ctx.onDigest = (report) => reports.push(report);
      ctx.executor.execResult = async (command): Promise<ExecResult> => {
        if (command.includes("--is-shallow-repository"))
          return {
            stdout: "true\n",
            stderr: "",
            exitCode: stage === "probe failed" ? 1 : 0,
            truncated: stage === "probe truncated",
          };
        if (command.includes("fetch --unshallow"))
          return {
            stdout: "",
            stderr: "fetch failed",
            exitCode: stage === "fetch failed" ? 1 : 0,
            truncated: stage === "fetch truncated",
          };
        return stage === "listing"
          ? { stdout: ONE_FILE, stderr: "listing failed", exitCode: 1, truncated: false }
          : { stdout: "", stderr: "no merge base", exitCode: 128, truncated: false };
      };
      const out = await diffDigestTool.run({}, ctx);
      expect(out).toContain("could not compute the diff");
      expect(reports).toEqual([
        { complete: false, base: "origin/HEAD", reason: "the Git command did not complete successfully" },
      ]);
    }
  });

  it("refuses executors without structured outcomes before interpreting display text", async () => {
    const reports: DigestReport[] = [];
    const ctx = ctxWith(async () => ONE_FILE);
    delete ctx.executor.execResult;
    ctx.onDigest = (report) => reports.push(report);
    expect(await diffDigestTool.run({}, ctx)).toContain("structured command outcomes are unavailable");
    expect(reports).toEqual([
      { complete: false, base: "origin/HEAD", reason: "the Git command did not complete successfully" },
    ]);
  });

  it("preserves an unknown fetch outcome without retrying the fetch or listing", async () => {
    const commands: string[] = [];
    const lost = new Error("fetch response lost");
    const ctx = ctxWith(async () => ONE_FILE);
    ctx.executor.execResult = async (command) => {
      commands.push(command);
      if (command.includes("fetch --unshallow")) throw lost;
      return command.includes("--is-shallow-repository")
        ? { stdout: "true\n", stderr: "", exitCode: 0, truncated: false }
        : { stdout: "", stderr: "no merge base", exitCode: 128, truncated: false };
    };
    await expect(diffDigestTool.run({}, ctx)).rejects.toBe(lost);
    expect(commands.filter((command) => command.includes("fetch --unshallow"))).toEqual([
      'git fetch --unshallow --quiet origin "+refs/heads/*:refs/remotes/origin/*"',
    ]);
    expect(commands.filter((command) => command.includes("--numstat"))).toHaveLength(1);
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

  it("surfaces a git failure instead of reporting an empty diff, and reports incomplete coverage", async () => {
    const reports: DigestReport[] = [];
    const { ctx } = scripted([
      () => ({ stdout: "", stderr: "fatal: bad revision 'nope...HEAD'", exitCode: 128, truncated: false }),
      () => "false", // not a shallow clone → no fetch, the failure stands
    ]);
    ctx.onDigest = (r) => reports.push(r);
    const out = await diffDigestTool.run({ base: "nope" }, ctx);
    expect(out).toMatch(/could not compute/i);
    expect(out).toContain("fatal: bad revision");
    expect(out).not.toMatch(/no changes/i);
    expect(reports).toEqual([
      { complete: false, base: "nope", reason: "the Git command did not complete successfully" },
    ]);
  });

  it("a shallow clone with no merge base is deepened once (every branch), then the listing is retried", async () => {
    const { ctx, commands } = scripted([
      () => ({ stdout: "", stderr: "fatal: origin/main...HEAD: no merge base", exitCode: 128, truncated: false }),
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
    const { ctx, commands } = scripted([
      () => ({ stdout: "", stderr: "fatal: origin/main...HEAD: no merge base", exitCode: 128, truncated: false }),
      () => "false",
    ]);
    const out = await diffDigestTool.run({}, ctx);
    expect(commands).toHaveLength(2);
    expect(commands.some((c) => c.includes("git fetch"))).toBe(false);
    expect(out).toMatch(/could not compute/i);
  });

  it("a listing cut by the executor's output cap is reported as incomplete — never rendered as a smaller change", async () => {
    const reports: DigestReport[] = [];
    const cut = `${"1\t0\tsrc/a.ts\n".repeat(3)}@@diff_digest:name-status@@\nM\tsrc/a.ts\n...[truncated 9000 chars]`;
    const ctx = ctxWith(async () => ({ stdout: cut, stderr: "", exitCode: 0, truncated: true }));
    ctx.onDigest = (r) => reports.push(r);
    const out = await diffDigestTool.run({}, ctx);
    expect(out).toMatch(/cannot state totals/);
    expect(out).not.toMatch(/files changed/);
    expect(reports).toEqual([{ complete: false, base: "origin/HEAD", reason: expect.stringMatching(/output cap/) }]);
  });

  it("a listing cut BEFORE the marker is still incomplete — never 'could not compute', and no shallow probe or fetch", async () => {
    const reports: DigestReport[] = [];
    const cut = `${"1\t0\tsrc/a.ts\n".repeat(3)}...[truncated 9000 chars]`;
    const { ctx, commands } = scripted([() => ({ stdout: cut, stderr: "", exitCode: 0, truncated: true })]);
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

  // The fixture is built ONCE per file: real git under a loaded CI runner is
  // the expensive part, so the setup batches every git command into three
  // shells, skips the clone (origin/HEAD is set directly, as a real clone
  // would leave it), and sizes the big file to just clear the 120k executor
  // output cap. The bound below is the fixture's, proportional to its ~10 git
  // subprocesses — the test itself runs one `git diff` and stays at the
  // default bound.
  let dir: string;
  let wt: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "digest-"));
    wt = join(dir, "wt");
    sh(dir, "git init -q -b main wt");
    writeFileSync(join(wt, "README.md"), "hello\n");
    sh(wt, "git add . && git commit -qm base && git checkout -qb feature");
    // commit 1: a file sorted FIRST alphabetically whose unified diff alone
    // exceeds the 120k output cap (4200 lines × ~31 chars ≈ 130k)
    writeFileSync(
      join(wt, "a-huge.txt"),
      Array.from({ length: 4200 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n") + "\n",
    );
    sh(wt, "git add . && git commit -qm huge");
    // commit 2 + 3: files sorted AFTER it — the ones a cut diff loses
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src/late.ts"), "export const a = 1;\nexport const b = 2;\n");
    writeFileSync(join(wt, "zz-last.md"), "tail\n");
    writeFileSync(join(wt, "README.md"), "hello\nworld\n");
    sh(
      wt,
      "git add src/late.ts && git commit -qm late && git add . && git commit -qm last" +
        // origin/HEAD → main and origin/main at the base, as a real clone has,
        // without paying for a second repository and a clone
        " && git update-ref refs/remotes/origin/main main" +
        " && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main",
    );
  }, 20_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("covers every commit's files and states exact totals even when the unified diff exceeds the output cap", async () => {
    const reports: DigestReport[] = [];
    const ctx: ToolContext = { executor: new LocalExecutor(wt), onDigest: (r) => reports.push(r) };
    const out = await diffDigestTool.run({}, ctx);
    expect(out).toContain("4 files changed, +4204 -0");
    for (const f of ["a-huge.txt", "src/late.ts", "zz-last.md", "README.md"]) expect(out).toContain(f);
    expect(reports).toEqual([
      { complete: true, base: "origin/HEAD", totals: { files: 4, additions: 4204, deletions: 0 } },
    ]);
  });

  it("keeps the PR digest pinned when an alternate comparison is requested", async () => {
    const reports: DigestReport[] = [];
    const head = sh(wt, "git rev-parse HEAD").trim();
    const base = sh(wt, "git rev-parse main").trim();
    const ctx: ToolContext = {
      executor: new LocalExecutor(wt),
      onDigest: (report) => reports.push(report),
      reviewReadTarget: () => ({ repo: "example/project", pr: 7, baseRef: "main", head, base }),
    };
    expect(await diffDigestTool.run({}, ctx)).toContain("4 files changed, +4204 -0");
    expect(await diffDigestTool.run({ base: "HEAD~1" }, ctx)).toBe(
      "diff_digest: a PR review uses its pinned base; use git diff to inspect other ranges.",
    );
    expect(reports).toEqual([
      {
        complete: true,
        base,
        range: { base, head, baseSha: base, baseRef: "main" },
        totals: { files: 4, additions: 4204, deletions: 0 },
      },
    ]);
  });

  it("uses the bound checkout when the executor starts outside the repository", async () => {
    const reports: DigestReport[] = [];
    const ctx: ToolContext = {
      executor: new LocalExecutor(dir),
      checkout: () => wt,
      onDigest: (report) => reports.push(report),
    };
    const out = await diffDigestTool.run({}, ctx);
    expect(out).toContain("4 files changed, +4204 -0");
    expect(reports).toEqual([
      { complete: true, base: "origin/HEAD", totals: { files: 4, additions: 4204, deletions: 0 } },
    ]);
  });

  it("deepens the bound shallow checkout when the executor starts outside it", async () => {
    const shallow = join(dir, "shallow");
    sh(dir, `git clone -q --depth 1 --branch feature file://${wt} ${shallow}`);
    const ctx: ToolContext = { executor: new LocalExecutor(dir), checkout: () => shallow };
    const out = await diffDigestTool.run({ base: "origin/main" }, ctx);
    expect(out).toContain("4 files changed, +4204 -0");
    expect(sh(shallow, "git rev-parse --is-shallow-repository").trim()).toBe("false");
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
