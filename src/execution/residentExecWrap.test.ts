import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { capBytesFor, capWrappedCommand, recoverCapturedOutput } from "./residentExecWrap.js";

const run = promisify(execFile);

// Feature: features/resident-repos.md item 21 — /exec (and /op) output is
// bounded INSIDE the container; only the capped head of each stream crosses
// the RPC into the DO isolate. These tests run the generated script under a
// real bash, so the exit-code/stream/cap contract is proven, not asserted.

async function bash(script: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const r = await run("bash", ["-c", script], { maxBuffer: 64 * 1024 * 1024 });
    return { stdout: r.stdout, stderr: r.stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? -1 };
  }
}

const cwd = mkdtempSync(join(tmpdir(), "execwrap-"));

/** Resolves once `text` has been written to `file` — the command under test is
 *  still running (it sleeps after its echos), so this is the moment to kill it. */
const landed = (file: string, text: string) =>
  vi.waitFor(
    () => {
      let content = "";
      try {
        content = readFileSync(file, "utf8");
      } catch {
        // not created yet
      }
      expect(content).toContain(text);
    },
    { interval: 5 },
  );

describe("capWrappedCommand (run under real bash)", () => {
  it("passes stdout and stderr through separately and preserves exit 0", async () => {
    const r = await bash(capWrappedCommand(cwd, `echo out-line && echo err-line >&2`, 1000));
    expect(r).toEqual({ stdout: "out-line\n", stderr: "err-line\n", code: 0 });
  });

  it("preserves a non-zero exit code with the streams intact", async () => {
    const r = await bash(capWrappedCommand(cwd, `echo partial && echo oops >&2 && exit 7`, 1000));
    expect(r.code).toBe(7);
    expect(r.stdout).toBe("partial\n");
    expect(r.stderr).toBe("oops\n");
  });

  it("caps each stream at capBytes — a huge stdout crosses as exactly the first capBytes", async () => {
    // ~5 MB of stdout, 1 KB cap: only 1024 bytes come back, exit stays 0.
    const r = await bash(capWrappedCommand(cwd, `yes 0123456789abcde | head -c 5000000; echo BIGERR >&2`, 1024));
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(1024);
    expect(r.stdout.startsWith("0123456789abcde\n")).toBe(true);
    expect(r.stderr).toBe("BIGERR\n"); // the small stream is untouched
  });

  it("caps stderr independently of stdout", async () => {
    const r = await bash(capWrappedCommand(cwd, `yes E | head -c 100000 >&2; echo small`, 64));
    expect(r.stdout).toBe("small\n");
    expect(r.stderr.length).toBe(64);
  });

  it("a cd failure surfaces as before: message on stderr, non-zero exit, no stdout", async () => {
    const r = await bash(capWrappedCommand("/nonexistent-dir-xyz", `echo never`, 1000));
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("nonexistent-dir-xyz");
  });

  it("arbitrary command text — quotes, &&, subshells, trailing comment — behaves as the bare command would", async () => {
    const cmd = `VAL="a b"; (echo "q:$VAL" && printf '%s\\n' 'single # not a comment') && echo done # trailing comment`;
    const r = await bash(capWrappedCommand(cwd, cmd, 10_000));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("q:a b\nsingle # not a comment\ndone\n");
  });

  it("cleans up BOTH temp files on normal exit (EXIT trap)", async () => {
    const marker = `execwrap-probe-${Date.now()}`;
    // Rename every mktemp (stdout AND stderr file) so the cleanup of each is proven.
    const script = capWrappedCommand(cwd, `echo hi`, 100).replaceAll("$(mktemp)", `$(mktemp -t ${marker}.XXXXXX)`);
    expect(script.split(marker).length - 1).toBe(2);
    const r = await bash(script + `\n`);
    expect(r.code).toBe(0);
    const leftovers = await bash(`ls \${TMPDIR:-/tmp}/${marker}.* 2>/dev/null | wc -l`);
    expect(leftovers.stdout.trim()).toBe("0");
  });

  it("fixed-file mode + recovery: a SIGKILL mid-command leaves the files, and the recovery script salvages the capped heads then removes them", async () => {
    const files = { out: join(cwd, `probe.out`), err: join(cwd, `probe.err`) };
    // Emit some output, then hang; SIGKILL the wrapper (the SDK timeout's
    // effect) so its own head/cleanup lines never run.
    const wrapper = capWrappedCommand(cwd, `echo early-clue && echo early-err >&2 && sleep 30`, 1024, files);
    const child = spawn("bash", ["-c", wrapper], { stdio: "ignore" });
    await landed(files.out, "early-clue");
    await landed(files.err, "early-err");
    child.kill("SIGKILL");
    await new Promise((r) => child.once("close", r));
    // The kill skipped the trap: files survive with the pre-kill output.
    const rec = await bash(recoverCapturedOutput(files, 1024));
    expect(rec.code).toBe(0);
    expect(rec.stdout).toBe("early-clue\n");
    expect(rec.stderr).toBe("early-err\n");
    const leftovers = await bash(`ls ${cwd}/probe.* 2>/dev/null | wc -l`);
    expect(leftovers.stdout.trim()).toBe("0"); // recovery removed them
  });

  it("SIGTERM mid-command (the SDK's actual kill) also leaves the files for recovery — no EXIT trap may delete them", async () => {
    // The sandbox SDK's timeout kill is TERM-based; with a recoverable-mode
    // EXIT trap bash would run it and delete the files before the recovery leg
    // could read them — salvage returns empty while the SIGKILL-based test
    // above stays green.
    const files = { out: join(cwd, `term.out`), err: join(cwd, `term.err`) };
    const wrapper = capWrappedCommand(cwd, `echo term-clue && sleep 30`, 1024, files);
    const child = spawn("bash", ["-c", wrapper], { stdio: "ignore", detached: true });
    await landed(files.out, "term-clue");
    process.kill(-child.pid!, "SIGTERM"); // the whole process group, like a supervisor kill
    await new Promise((r) => child.once("close", r));
    const rec = await bash(recoverCapturedOutput(files, 1024));
    expect(rec.code).toBe(0);
    expect(rec.stdout).toBe("term-clue\n");
  });

  it("fixed-file mode cleans up after itself on NORMAL completion (explicit rm, not a trap)", async () => {
    const files = { out: join(cwd, `norm.out`), err: join(cwd, `norm.err`) };
    const r = await bash(capWrappedCommand(cwd, `echo fine`, 1024, files));
    expect(r).toEqual({ stdout: "fine\n", stderr: "", code: 0 });
    const left = await bash(`ls ${cwd}/norm.* 2>/dev/null | wc -l`);
    expect(left.stdout.trim()).toBe("0");
  });

  it("recovery over missing files is a clean no-op (exit 0, empty streams)", async () => {
    const rec = await bash(recoverCapturedOutput({ out: join(cwd, "gone.out"), err: join(cwd, "gone.err") }, 1024));
    expect(rec).toEqual({ stdout: "", stderr: "", code: 0 });
  });

  it("capBytesFor guarantees the DO-side char slice + truncated flag stay exact", () => {
    expect(capBytesFor(100_000)).toBe(400_004);
    // any output of > charCap chars occupies > charCap bytes in UTF-8, and
    // 4×charCap+4 bytes always decode to ≥ charCap+1 chars of it — so the
    // DO's `length > CAP` test sees truncation whenever there was one.
    expect(() => capWrappedCommand(cwd, "true", 0)).toThrow(/positive integer/);
  });
});
