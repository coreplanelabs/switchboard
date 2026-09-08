import { describe, expect, it } from "vitest";
import { RUN_DEADLINE_RESERVE_MS } from "../execution/bashTimeout.js";
import { LocalExecutor, type ExecOptions, type Executor } from "../execution/executor.js";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DigestReport } from "../core/diffDigest.js";
import type { PrDescription } from "../core/prDescription.js";
import {
  bashTool,
  diffDigestTool,
  submitPrDescriptionTool,
  submitVerdictTool,
  TOOLSETS,
  type ToolContext,
} from "./workspace.js";

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
    const out = await submitVerdictTool.run(
      { verdict: "approve", summary: "clean" },
      ctxWith((v) => got.push(v)),
    );
    expect(got).toEqual([{ verdict: "approve", summary: "clean" }]);
    expect(out).toBe("verdict recorded: approve");
  });

  it("forwards the reported head (the commit the agent reviewed) alongside the verdict", async () => {
    const got: unknown[] = [];
    await submitVerdictTool.run(
      { verdict: "approve", summary: "clean", head: "e8e43f480a09b76989b85ebe6a2a254d99a4d2a3" },
      ctxWith((v) => got.push(v)),
    );
    expect(got).toEqual([{ verdict: "approve", summary: "clean", head: "e8e43f480a09b76989b85ebe6a2a254d99a4d2a3" }]);
    expect(submitVerdictTool.inputSchema.required).toContain("head");
  });

  it("rejects anything but the two verdict values without touching the context", async () => {
    const got: unknown[] = [];
    const out = await submitVerdictTool.run(
      { verdict: "LGTM", summary: "x" },
      ctxWith((v) => got.push(v)),
    );
    expect(got).toEqual([]);
    expect(String(out)).toMatch(/^error:/);
  });

  it("tolerates a context with no verdict sink", async () => {
    await expect(
      submitVerdictTool.run({ verdict: "request_changes", summary: "bug" }, ctxWith(undefined)),
    ).resolves.toBe("verdict recorded: request_changes");
  });

  // Feature: docs/reference/specs/agent-ship.md item 6 — the verdict enumerates findings
  // as typed entries with stable ids; the tool text is where the review agent
  // learns the id and severity contract.
  describe("findings (agent-ship item 6)", () => {
    it("declares `findings` in the input schema — optional, with the finding field shapes and the severity vocabulary", () => {
      const props = submitVerdictTool.inputSchema.properties as Record<string, any>;
      expect(props.findings?.type).toBe("array");
      const item = props.findings.items;
      expect(item.required).toEqual(expect.arrayContaining(["id", "severity", "file", "title"]));
      expect(item.required).not.toContain("line");
      expect(item.properties.severity.enum).toEqual(["blocking", "major", "minor", "nit"]);
      expect(item.properties.line.type).toBe("integer");
      expect(submitVerdictTool.inputSchema.required).not.toContain("findings");
    });

    it("the description instructs stable ids (F1, F2, …) and names the severity vocabulary once", () => {
      expect(submitVerdictTool.description).toMatch(/stable/i);
      expect(submitVerdictTool.description).toContain("F1");
      expect(submitVerdictTool.description).toContain("blocking|major|minor|nit");
    });

    it("forwards parsed findings to the verdict sink and reports the count", async () => {
      const got: unknown[] = [];
      const out = await submitVerdictTool.run(
        {
          verdict: "request_changes",
          summary: "one bug",
          findings: [{ id: "F1", severity: "major", file: "src/a.ts", line: 3, title: "off by one" }],
        },
        ctxWith((v) => got.push(v)),
      );
      expect(got).toEqual([
        {
          verdict: "request_changes",
          summary: "one bug",
          findings: [{ id: "F1", severity: "major", file: "src/a.ts", line: 3, title: "off by one" }],
        },
      ]);
      expect(String(out)).toContain("1 finding");
    });

    it("surfaces dropped findings in the ack so the model can resubmit", async () => {
      const out = await submitVerdictTool.run(
        {
          verdict: "request_changes",
          summary: "s",
          findings: [
            { id: "F1", severity: "major", file: "a.ts", title: "ok" },
            { id: "F2", severity: "meh", file: "b.ts", title: "bad" },
          ],
        },
        ctxWith(() => {}),
      );
      expect(String(out)).toContain("F2");
      expect(String(out)).toMatch(/dropped/i);
    });
  });
});

// Feature: docs/reference/specs/agent-ship.md item 6 — fix rounds record one disposition
// per review finding through this tool; the ship orchestrator injects
// the round's known finding ids and consumes the last valid call.
describe("submit_dispositions tool", () => {
  const ctxWith = (onDispositions?: ToolContext["onDispositions"], knownFindingIds?: string[]): ToolContext =>
    ({ executor: {} as ToolContext["executor"], onDispositions, knownFindingIds }) as ToolContext;

  const valid = () => ({
    dispositions: [
      { findingId: "F1", disposition: "fixed", note: "guarded the null path" },
      { findingId: "F2", disposition: "declined", note: "by design" },
    ],
  });

  // Looked up through the toolset so every test exercises the wired instance.
  const tool = () => TOOLSETS.full.find((t) => t.name === "submit_dispositions")!;

  it("is in the coding (full) toolset only — review/web/none never record dispositions", () => {
    const names = (key: string) => (TOOLSETS[key] ?? []).map((t) => t.name);
    expect(names("full")).toContain("submit_dispositions");
    expect(names("readonly")).not.toContain("submit_dispositions");
    expect(names("web")).not.toContain("submit_dispositions");
    expect(names("none")).not.toContain("submit_dispositions");
  });

  it("mutates run state, so it is never side-effect-free (must run strictly in order)", () => {
    expect(tool().sideEffectFree).toBeUndefined();
  });

  it("forwards a valid set to the context and acknowledges the count", async () => {
    const got: unknown[] = [];
    const out = await tool().run(
      valid(),
      ctxWith((d) => got.push(d)),
    );
    expect(got).toEqual([
      [
        { findingId: "F1", disposition: "fixed", note: "guarded the null path" },
        { findingId: "F2", disposition: "declined", note: "by design" },
      ],
    ]);
    expect(String(out)).toContain("2");
    expect(String(out)).toContain("dispositions recorded"); // the real ack, only where a ship fix round listens
    expect(String(out)).not.toMatch(/^error:/);
  });

  it("an unknown findingId (with knownFindingIds provided) is a string error naming it — context untouched", async () => {
    const got: unknown[] = [];
    const out = await tool().run(
      {
        dispositions: [
          { findingId: "F1", disposition: "fixed", note: "n" },
          { findingId: "F9", disposition: "declined", note: "n" },
        ],
      },
      ctxWith((d) => got.push(d), ["F1", "F2"]),
    );
    expect(got).toEqual([]);
    expect(String(out)).toMatch(/^error:/);
    expect(String(out)).toContain("F9");
  });

  it("without knownFindingIds the id-existence check is skipped (the ship orchestrator supplies it)", async () => {
    const got: unknown[] = [];
    const out = await tool().run(
      { dispositions: [{ findingId: "F9", disposition: "fixed", note: "n" }] },
      ctxWith((d) => got.push(d)),
    );
    expect(got).toHaveLength(1);
    expect(String(out)).not.toMatch(/^error:/);
  });

  it("last valid call wins at the sink", async () => {
    let latest: unknown;
    const ctx = ctxWith((d) => (latest = d));
    await tool().run(valid(), ctx);
    await tool().run({ dispositions: [{ findingId: "F1", disposition: "declined", note: "changed my mind" }] }, ctx);
    expect(latest).toEqual([{ findingId: "F1", disposition: "declined", note: "changed my mind" }]);
  });

  it("a non-array input is a string error — context untouched", async () => {
    const got: unknown[] = [];
    const out = await tool().run(
      { dispositions: "all fixed" },
      ctxWith((d) => got.push(d)),
    );
    expect(got).toEqual([]);
    expect(String(out)).toMatch(/^error:/);
  });

  it("a malformed entry is dropped with the drop surfaced in the ack; the rest are recorded", async () => {
    const got: unknown[][] = [];
    const out = await tool().run(
      {
        dispositions: [
          { findingId: "F1", disposition: "fixed", note: "done" },
          { findingId: "F2", disposition: "wontfix", note: "nope" },
        ],
      },
      ctxWith((d) => got.push(d as unknown[])),
    );
    expect(got).toEqual([[{ findingId: "F1", disposition: "fixed", note: "done" }]]);
    expect(String(out)).toMatch(/dropped/i);
    expect(String(out)).toContain("F2");
  });

  it("no dispositions sink (a plain coding run — no ship fix round) → an honest no-op, never a false 'recorded' ack", async () => {
    const out = await tool().run(valid(), ctxWith(undefined));
    expect(String(out)).toContain("no ship fix round");
    expect(String(out)).toContain("were not recorded");
    expect(String(out)).not.toContain("dispositions recorded");
    expect(String(out)).not.toMatch(/^error:/);
  });
});

// Feature: docs/reference/specs/pr-description.md — the coding agent's PR deliverable is a
// typed PrDescription submitted through this tool; the dispatcher (not the
// model) renders the GitHub body from it at the pushed head and opens/edits
// the PR. Validation mirrors submit_verdict: a bad object comes back as a
// readable string error (never a throw) so the model can fix it and retry.
describe("submit_pr_description tool", () => {
  const ctxWith = (onPrDescription?: ToolContext["onPrDescription"]): ToolContext =>
    ({ executor: {} as ToolContext["executor"], onPrDescription }) as ToolContext;

  function validInput(): Record<string, unknown> {
    return {
      title: "Fix the widget gate",
      tldr: "Two sentences.",
      whatWhy: "Because.",
      tour: [{ title: "The thing", description: "What it does.", anchor: { path: "src/a.ts", from: 3, to: 9 } }],
      remaining: [],
      decisions: [{ title: "Chose X", rationale: "Y was worse." }],
      risks: "None.",
      validation: { criteria: [{ criterion: "It renders", proof: "`[unit]` this test" }] },
    };
  }

  it("is in the coding (full) toolset only — review/web/none never submit descriptions", () => {
    const names = (key: string) => (TOOLSETS[key] ?? []).map((t) => t.name);
    expect(names("full")).toContain("submit_pr_description");
    expect(names("readonly")).not.toContain("submit_pr_description");
    expect(names("web")).not.toContain("submit_pr_description");
    expect(names("none")).not.toContain("submit_pr_description");
  });

  it("mutates run state, so it is never side-effect-free (must run strictly in order)", () => {
    expect(submitPrDescriptionTool.sideEffectFree).toBeUndefined();
  });

  it("forwards a valid description to the context, parsed and normalized, and acknowledges it", async () => {
    const got: PrDescription[] = [];
    const out = await submitPrDescriptionTool.run(
      { ...validInput(), title: "  Fix the widget gate  " },
      ctxWith((d) => got.push(d)),
    );
    expect(got).toHaveLength(1);
    expect(got[0].title).toBe("Fix the widget gate"); // trimmed by the schema, not passed through raw
    expect(got[0].tour[0].anchor).toEqual({ path: "src/a.ts", from: 3, to: 9 });
    expect(String(out)).toMatch(/PR description recorded/);
  });

  it("a missing section is a string error naming the zod path — no throw, context untouched", async () => {
    const got: PrDescription[] = [];
    const { risks: _r, ...noRisks } = validInput();
    const out = await submitPrDescriptionTool.run(
      noRisks,
      ctxWith((d) => got.push(d)),
    );
    expect(got).toEqual([]);
    expect(String(out)).toMatch(/^error:/);
    expect(String(out)).toContain("risks");
  });

  it("a blank title is a string error naming `title`", async () => {
    const got: PrDescription[] = [];
    const out = await submitPrDescriptionTool.run(
      { ...validInput(), title: "   " },
      ctxWith((d) => got.push(d)),
    );
    expect(got).toEqual([]);
    expect(String(out)).toMatch(/^error:/);
    expect(String(out)).toContain("title");
  });

  it("a bad anchor is a string error naming the full path into the tour", async () => {
    const input = validInput();
    input.tour = [{ title: "t", description: "d", anchor: { path: "/etc/passwd", from: 1, to: 2 } }];
    const out = await submitPrDescriptionTool.run(
      input,
      ctxWith(() => {}),
    );
    expect(String(out)).toMatch(/^error:/);
    expect(String(out)).toContain("tour.0.anchor.path");
  });

  it("last valid call wins: a second submission replaces the first at the sink", async () => {
    let latest: PrDescription | undefined;
    const ctx = ctxWith((d) => (latest = d));
    await submitPrDescriptionTool.run(validInput(), ctx);
    await submitPrDescriptionTool.run({ ...validInput(), title: "Second title" }, ctx);
    expect(latest?.title).toBe("Second title");
  });

  it("an invalid call after a valid one leaves the valid one standing", async () => {
    let latest: PrDescription | undefined;
    const ctx = ctxWith((d) => (latest = d));
    await submitPrDescriptionTool.run(validInput(), ctx);
    await submitPrDescriptionTool.run({ ...validInput(), tldr: "" }, ctx);
    expect(latest?.title).toBe("Fix the widget gate");
  });

  it("tolerates a context with no description sink", async () => {
    await expect(submitPrDescriptionTool.run(validInput(), ctxWith(undefined))).resolves.toMatch(
      /PR description recorded/,
    );
  });

  it("declares every schema section in the tool input schema (the model's contract)", () => {
    const required = submitPrDescriptionTool.inputSchema.required as string[];
    for (const field of ["title", "tldr", "whatWhy", "tour", "remaining", "decisions", "risks", "validation"]) {
      expect(required).toContain(field);
    }
  });
});

// Feature: docs/reference/specs/execution.md item 11 — the bash tool's per-call timeoutMs:
// default 5 min, model-requestable up to the 20-min ceiling, clamped at the
// tool layer before any executor sees it. No timeoutMs → exactly the old call
// shape, so every executor behaves as before.
describe("bash tool timeoutMs", () => {
  function capturing() {
    const seen: Array<{ cmd: string; opts?: ExecOptions }> = [];
    const executor: Executor = {
      exec: async (cmd, opts) => {
        seen.push({ cmd, opts });
        return "ok";
      },
      readFile: async () => "",
      writeFile: async () => "Wrote",
    };
    return { seen, ctx: { executor } as ToolContext };
  }

  it("declares timeoutMs in the input schema and documents the default and the max in the description", () => {
    const props = bashTool.inputSchema.properties as Record<string, { type?: string; description?: string }>;
    expect(props.timeoutMs?.type).toBe("integer");
    // the model learns the knob from the tool text: default and ceiling must be named
    const doc = bashTool.description + (props.timeoutMs?.description ?? "");
    expect(doc).toContain("timeoutMs");
    expect(doc).toContain("300000");
    expect(doc).toContain("1200000");
    expect(bashTool.inputSchema.required).toEqual(["command"]); // optional — back-compat
  });

  it("passes a requested timeoutMs through to the executor, clamped to the 20-min ceiling", async () => {
    const { seen, ctx } = capturing();
    await bashTool.run({ command: "npm test", timeoutMs: 25 * 60_000 }, ctx);
    expect(seen[0].opts?.timeoutMs).toBe(20 * 60_000);
  });

  it("passes an in-range timeoutMs through unchanged", async () => {
    const { seen, ctx } = capturing();
    await bashTool.run({ command: "npm test", timeoutMs: 600_000 }, ctx);
    expect(seen[0].opts?.timeoutMs).toBe(600_000);
  });

  it("no timeoutMs → the executor sees the exact pre-feature call (no timeoutMs key at all)", async () => {
    const { seen, ctx } = capturing();
    await bashTool.run({ command: "ls" }, ctx);
    expect(seen[0].opts?.timeoutMs).toBeUndefined();
  });

  it("a non-numeric timeoutMs is ignored (default applies) rather than crashing the call", async () => {
    const { seen, ctx } = capturing();
    await bashTool.run({ command: "ls", timeoutMs: "forever" }, ctx);
    expect(seen[0].opts?.timeoutMs).toBeUndefined();
    await bashTool.run({ command: "ls", timeoutMs: Number.NaN }, ctx);
    expect(seen[1].opts?.timeoutMs).toBeUndefined();
  });

  // Feature: docs/reference/specs/execution.md item 12 — a command's budget is clipped to
  // the run's remaining wall clock minus a reserve for the write-up. Without
  // the clip one long command can consume most of a review budget, leaving
  // the model minutes to recover and none to review.
  describe("clipped to the run's remaining wall clock", () => {
    it("plenty of run left changes nothing: the request passes through and no request stays no request", async () => {
      const { seen, ctx } = capturing();
      const far = { ...ctx, remainingMs: () => 30 * 60_000 };
      await bashTool.run({ command: "npm test", timeoutMs: 600_000 }, far);
      expect(seen[0].opts?.timeoutMs).toBe(600_000);
      await bashTool.run({ command: "ls" }, far);
      expect(seen[1].opts?.timeoutMs).toBeUndefined();
    });

    it("little run left clips a requested budget to what is left minus the reserve, and says so", async () => {
      const { seen, ctx } = capturing();
      const near = { ...ctx, remainingMs: () => 90_000 };
      const out = await bashTool.run({ command: "npm test", timeoutMs: 600_000 }, near);
      expect(seen[0].opts?.timeoutMs).toBe(90_000 - RUN_DEADLINE_RESERVE_MS);
      expect(String(out)).toContain("clipped");
    });

    it("little run left also clips the 5-minute default, which the executor would otherwise apply", async () => {
      const { seen, ctx } = capturing();
      const near = { ...ctx, remainingMs: () => 90_000 };
      await bashTool.run({ command: "ls" }, near);
      expect(seen[0].opts?.timeoutMs).toBe(90_000 - RUN_DEADLINE_RESERVE_MS);
    });

    it("inside the reserve nothing runs: the tool refuses legibly instead of starting a command that cannot finish", async () => {
      const { seen, ctx } = capturing();
      const spent = { ...ctx, remainingMs: () => RUN_DEADLINE_RESERVE_MS + 500 };
      const out = await bashTool.run({ command: "npm test" }, spent);
      expect(seen).toHaveLength(0);
      expect(String(out)).toMatch(/^exit 124:/);
      expect(String(out)).toContain("run budget");
    });
  });

  it("still forwards the hard-stop signal alongside timeoutMs", async () => {
    const { seen, ctx } = capturing();
    const ctl = new AbortController();
    await bashTool.run({ command: "ls", timeoutMs: 60_000 }, { ...ctx, signal: ctl.signal });
    expect(seen[0].opts?.signal).toBe(ctl.signal);
    expect(seen[0].opts?.timeoutMs).toBe(60_000);
  });
});
