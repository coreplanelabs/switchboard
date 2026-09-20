// The bash tool's timeout ends the command whatever it does with its pipes
// (docs/reference/specs/harness-pi.md item 15). pi kills the command's process
// group at the deadline, but its post-exit wait re-arms on every output chunk,
// so a descendant outside the group that kept the tool's pipe open and kept
// writing held a call open far past its bound. The harness's shell command
// prefix routes every command's output through one in-group forwarder, so the
// group kill closes the tool's pipes whatever survives it and the call returns
// pi's own timeout result with the output captured. These tests drive pi's
// real bash tool — the one the run's pi assembles from the same settings key —
// with scripted processes.
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { PI_SHELL_COMMAND_PREFIX } from "./process.js";

/** A word only these tests' background processes carry, so the cleanup kills
 *  exactly them and nothing of the suite around it. */
const MARKER = "switchboard-shell-prefix-test";

/** The two escape-shaped tests need `setsid` (util-linux) to put the writer
 *  outside the tool's process group — the shape that held a call open. macOS
 *  ships no setsid, so they skip there; Linux CI keeps the real proof. */
const hasSetsid = (() => {
  try {
    execSync("command -v setsid", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** One bash call through pi's tool with the harness's prefix, as pi runs it
 *  when settings.json names `shellCommandPrefix` (process.ts). */
async function run(command: string, timeout: number): Promise<{ ok: boolean; text: string; elapsedMs: number }> {
  const tool = createBashToolDefinition(tmpdir(), { commandPrefix: PI_SHELL_COMMAND_PREFIX });
  const started = Date.now();
  try {
    const result = await tool.execute(
      "call-1",
      { command, timeout },
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const first = (result.content as Array<{ type: string; text?: string }>)[0];
    return { ok: true, text: first?.text ?? "", elapsedMs: Date.now() - started };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - started };
  }
}

afterAll(() => {
  // Best-effort: a scripted survivor dies on its next write to the broken
  // pipe, but a quiet one is reaped here rather than left to its sleep.
  try {
    execSync(`pkill -f ${MARKER}`, { stdio: "ignore" });
  } catch {
    // Nothing of ours left running.
  }
});

describe("the bash tool's timeout ends the command whatever it does with its pipes (harness-pi.md item 15)", () => {
  it.skipIf(!hasSetsid)(
    "a child that keeps stdout open past the deadline is ended and the timeout result returned",
    async () => {
      // The holder outlives the deadline with the tool's pipe inherited; the
      // command itself never exits inside the bound.
      const r = await run(`setsid sleep 5 & echo held-${MARKER}; sleep 30`, 1);
      expect(r.ok).toBe(false);
      expect(r.text).toContain("Command timed out after 1 seconds");
      expect(r.text).toContain(`held-${MARKER}`);
      expect(r.elapsedMs).toBeLessThan(8_000);
    },
    20_000,
  );

  it.skipIf(!hasSetsid)(
    "a backgrounded subprocess holding the pipe does not extend the call",
    async () => {
      // The writer leaves the process group (`setsid`), survives the deadline's
      // group kill, and keeps producing — the shape that re-armed pi's post-exit
      // wait forever and held a call open for tens of minutes.
      const r = await run(`setsid sh -c 'while true; do echo ${MARKER}; sleep 0.05; done' & sleep 30`, 1);
      expect(r.ok).toBe(false);
      expect(r.text).toContain("Command timed out after 1 seconds");
      expect(r.text).toContain(MARKER);
      expect(r.elapsedMs).toBeLessThan(8_000);
    },
    20_000,
  );

  it("a command that exits in time is unchanged — its output, and a nonzero exit code", async () => {
    const inTime = await run("echo hello; echo two >&2", 5);
    expect(inTime.ok).toBe(true);
    expect(inTime.text).toContain("hello");
    expect(inTime.text).toContain("two");
    const failing = await run("echo oops >&2; exit 3", 5);
    expect(failing.ok).toBe(false);
    expect(failing.text).toContain("oops");
    expect(failing.text).toContain("Command exited with code 3");
  }, 20_000);
});
