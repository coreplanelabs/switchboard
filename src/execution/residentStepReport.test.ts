import { describe, expect, it } from "vitest";
import { classifyRefreshFailure } from "./residentRefresh.js";
import {
  abandonedWaitStepResult,
  describeStepFailure,
  stepFailureLog,
  STEP_REPORT_PER_STREAM,
} from "./residentStepReport.js";

// Feature: features/resident-repos.md item 53 — a failed resident step names
// the failure. The fixtures below are REAL captures, not invented strings:
// `PNPM_WARN` is the byte-for-byte stderr of `pnpm install --frozen-lockfile`
// under the resident image's pnpm (11.x) on a pnpm workspace, and
// `PNPM_ERROR` the stdout of the same command when it genuinely fails. The
// failure mode this replaces: the resident reported
// `provision-failed at install: exit 1: [WARN] The "pnpm" field …` — the
// warning, which the SAME install prints on success, while the pnpm error that
// actually explained the exit sat on the discarded stdout.

const PNPM_WARN =
  '[WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.overrides". See https://pnpm.io/settings for the new home of each setting.\n';

const PNPM_ERROR =
  "? Verifying lockfile against supply-chain policies (2 entries)...\n" +
  "✓ Lockfile passes supply-chain policies (2 entries in 124ms)\n" +
  '[ERR_PNPM_LOCKFILE_CONFIG_MISMATCH] Cannot proceed with the frozen installation. The current "overrides" configuration doesn\'t match the value found in the lockfile\n\n' +
  'Update your lockfile using "pnpm install --no-frozen-lockfile"\n';

const ok = { exitCode: 0, timedOut: false } as const;
const failed = { exitCode: 1, timedOut: false } as const;

describe("describeStepFailure", () => {
  it("strips terminal control sequences and redacts credentials before keeping the tail (item 62)", () => {
    const r = {
      stdout: "",
      stderr: "\x1b[31mnpm ERR!\x1b[0m fetch failed GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      exitCode: 1,
      timedOut: false,
    };
    const text = describeStepFailure(r);
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("ghp_");
    expect(text).toContain("npm ERR!");
    expect(stepFailureLog("install", r)).not.toContain("ghp_");
  });

  it("keeps the diagnosis when the failing tool reports on stdout and stderr holds only a warning", () => {
    const reason = describeStepFailure({ stdout: PNPM_ERROR, stderr: PNPM_WARN, ...failed });
    expect(reason).toContain("ERR_PNPM_LOCKFILE_CONFIG_MISMATCH");
    expect(reason).toContain("exit 1");
    // The warning is context, not the headline: it stays, labelled as stderr.
    expect(reason).toContain("stderr:");
    expect(reason).toContain('The "pnpm" field in package.json is no longer read');
  });

  it("labels each stream so neither can be mistaken for the other", () => {
    expect(describeStepFailure({ stdout: "on-out", stderr: "on-err", ...failed })).toBe(
      "exit 1: stdout: on-out; stderr: on-err",
    );
  });

  it("omits the label of a stream that is empty", () => {
    expect(describeStepFailure({ stdout: "", stderr: "fatal: repository not found", ...failed })).toBe(
      "exit 1: stderr: fatal: repository not found",
    );
    expect(describeStepFailure({ stdout: "ENOSPC", stderr: "   \n", ...failed })).toBe("exit 1: stdout: ENOSPC");
  });

  it("says so when a step failed with no output at all, instead of an empty tail", () => {
    expect(describeStepFailure({ stdout: "", stderr: "", exitCode: 137, timedOut: false })).toBe("exit 137: no output");
  });

  it("names a timeout, which an exit code alone cannot express", () => {
    expect(describeStepFailure({ stdout: "", stderr: "", exitCode: -1, timedOut: true })).toBe(
      "exit -1 (timed out): no output",
    );
  });

  it("keeps the END of a long stream — a tool's error is its last output — and marks the cut", () => {
    const noise = "x".repeat(STEP_REPORT_PER_STREAM * 3);
    const reason = describeStepFailure({ stdout: `${noise}THE-ERROR`, stderr: "", ...failed });
    expect(reason).toContain("THE-ERROR");
    expect(reason).toContain("…");
    expect(reason.length).toBeLessThan(STEP_REPORT_PER_STREAM + 40);
  });

  it("bounds the whole reason even when both streams are huge", () => {
    const reason = describeStepFailure({
      stdout: "o".repeat(100_000),
      stderr: "e".repeat(100_000),
      ...failed,
    });
    expect(reason.length).toBeLessThan(2 * STEP_REPORT_PER_STREAM + 60);
  });

  it("refuses to describe a success — a caller must only reach it on failure", () => {
    expect(() => describeStepFailure({ stdout: "fine", stderr: "", ...ok })).toThrow(/not a failure/);
  });
});

describe("stepFailureLog", () => {
  it("carries far more of both streams than the stored reason, for the Worker log", () => {
    const line = stepFailureLog("install", { stdout: PNPM_ERROR, stderr: PNPM_WARN, ...failed });
    expect(line).toContain("step install failed");
    expect(line).toContain("ERR_PNPM_LOCKFILE_CONFIG_MISMATCH");
    expect(line).toContain("--- stdout ---");
    expect(line).toContain("--- stderr ---");
  });

  it("stays bounded so one runaway step cannot flood the log", () => {
    const line = stepFailureLog("test", { stdout: "o".repeat(200_000), stderr: "e".repeat(200_000), ...failed });
    expect(line.length).toBeLessThan(20_000);
  });
});

// An `npm install` that outlives its 5-min budget AND the SDK's 30 s output
// grace makes `output()` reject with `Process output did not complete within
// 330000ms`; if the cycle then records `refresh-failed: …` and moves on, npm
// is left running in the checkout. The next cycle's `git clean -fdx` races it
// (`Directory not empty` on exactly the packages being extracted) and the
// resident spirals: every cycle a timeout or a torn clean, `degraded` for as
// long as the default branch keeps moving.
describe("abandonedWaitStepResult (a wait that gives up on a live process is the step's own timeout)", () => {
  const sdkMessage = "Process output did not complete within 330000ms";

  it("is a timed-out failure of the STEP — described with `(timed out)`, so the classifier never calls it an interruption", () => {
    const r = abandonedWaitStepResult({ detail: sdkMessage, exitCode: 137 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(137);
    const described = describeStepFailure(r);
    expect(described).toMatch(/^exit 137 \(timed out\): /);
    expect(described).toContain(sdkMessage);
    const f = classifyRefreshFailure({ step: "install", message: described });
    expect(f).toMatchObject({ interrupted: false, diskFull: false });
    expect(f.reason).toMatch(/^install-failed: exit 137 \(timed out\)/);
  });

  it("says the process was killed — the operator must know nothing is left running in the checkout", () => {
    const r = abandonedWaitStepResult({ detail: sdkMessage, exitCode: 137 });
    expect(r.stderr).toMatch(/killed/);
  });

  it("no exit observed even after the kill → exit -1 and the report says so, never a made-up status", () => {
    const r = abandonedWaitStepResult({ detail: sdkMessage, exitCode: null });
    expect(r.exitCode).toBe(-1);
    expect(describeStepFailure(r)).toMatch(/^exit -1 \(timed out\): /);
    expect(r.stderr).toMatch(/no exit status/);
  });
});
