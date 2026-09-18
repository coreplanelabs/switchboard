import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SUPERVISOR = resolve(ROOT, "deploy/cloudflare-sandbox/runtime-supervisor.sh");
const DOCKERFILE = resolve(ROOT, "deploy/cloudflare-sandbox/Dockerfile");

// Feature: docs/reference/specs/execution.md item 21 — the cold sandbox's
// container outlives its runtime. The SDK's container server exits on any
// uncaught exception and used to be tini's one child, so one such error
// ended the container: workspace gone, every later command a failure. tini
// now runs this supervisor, which starts the server again when it exits.
// Static checks read the script and the Dockerfile; the behavioural ones
// drive the script with a fake runtime, since the real one only runs in the
// image.

const supervisor = readFileSync(SUPERVISOR, "utf8");
const dockerfile = readFileSync(DOCKERFILE, "utf8");

/** The instruction lines of a Dockerfile, continuations joined, comments dropped. */
function instructions(text: string): string[] {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** The script's code lines: comments and blank lines dropped. */
const code = supervisor
  .split("\n")
  .filter((l) => l.trim() && !l.trim().startsWith("#"))
  .join("\n");

describe("the sandbox image's PID 1", () => {
  it("is tini running the supervisor, installed at mode 755, named by the image's one ENTRYPOINT", () => {
    const lines = instructions(dockerfile);
    expect(lines).toContain("COPY --chmod=0755 runtime-supervisor.sh /usr/local/bin/sandbox-runtime-supervisor");
    const entrypoints = lines.filter((l) => l.startsWith("ENTRYPOINT"));
    expect(entrypoints).toEqual(['ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sandbox-runtime-supervisor"]']);
    // The base image's CMD is empty and stays so: the server takes no user command.
    expect(lines.some((l) => l.startsWith("CMD"))).toBe(false);
  });
});

describe("the runtime supervisor", () => {
  it("is plain sh that parses", () => {
    expect(supervisor.startsWith("#!/bin/sh\n")).toBe(true);
    expect(() => execFileSync("sh", ["-n", SUPERVISOR], { stdio: "pipe" })).not.toThrow();
  });

  it("runs the SDK's server by default, forwards TERM and INT as TERM, waits a second between starts, and gives up after five quick exits", () => {
    expect(code).toMatch(/^RUNTIME=\$\{SANDBOX_RUNTIME:-\/container-server\/sandbox\}$/m);
    expect(code).toMatch(/^trap on_signal TERM INT$/m);
    // Always TERM: a child started with `&` by a non-interactive shell ignores INT (POSIX).
    expect(code).toMatch(/kill -TERM "\$pid"/);
    expect(code).not.toMatch(/kill -INT|kill -s/);
    expect(code).toMatch(/^\s*sleep 1$/m);
    // A stop is checked after the pause too, so one landing there starts nothing again.
    expect(code).toMatch(/sleep 1\n\s*(#.*\n\s*)*if \[ -n "\$stopping" \]; then exit "\$code"; fi/);
    expect(code).toMatch(/^QUICK_EXIT_SECS=10$/m);
    expect(code).toMatch(/^QUICK_EXIT_LIMIT=5$/m);
    // Never `exec`: the script must stay PID 1 to start the server again.
    expect(code).not.toMatch(/^\s*exec /m);
  });
});

/** A fake runtime under a state directory: counts its starts, records its
 *  arguments, follows a per-start exit plan (`exit:<code>` or `live`), and
 *  when live ends on TERM with 143 or on INT with 130, noting which. */
function fakeRuntime(dir: string, plan: string[]): string {
  const path = join(dir, "runtime.sh");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `STATE=${JSON.stringify(dir)}`,
      'count=$(cat "$STATE/count" 2>/dev/null || echo 0)',
      "count=$((count + 1))",
      'echo "$count" > "$STATE/count"',
      'echo "start $count args=$*" >> "$STATE/log"',
      `plan=$(sed -n "\${count}p" "$STATE/plan")`,
      'case "$plan" in',
      '  exit:*) exit "${plan#exit:}" ;;',
      "esac",
      "trap 'echo term >> \"$STATE/log\"; exit 143' TERM",
      "trap 'echo int >> \"$STATE/log\"; exit 130' INT",
      "while :; do sleep 0.05; done",
    ].join("\n") + "\n",
  );
  chmodSync(path, 0o755);
  writeFileSync(join(dir, "plan"), plan.join("\n") + "\n");
  return path;
}

const dirs: string[] = [];
/** Every supervisor a test started, so the teardown can end the ones a test
 *  left running — and their runtimes with them. */
const started: Array<{ child: ChildProcess; dir: string }> = [];

/** The fake runtimes of `dir` still alive: `pgrep -f` over the script's path,
 *  which only this test's processes carry. `pgrep` exits 1 for no match; a
 *  host without it (exit code ENOENT) answers nothing, the assertion waived. */
function survivingRuntimes(dir: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", join(dir, "runtime.sh")], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch (err) {
    const e = err as { status?: number; code?: string };
    if (e.status === 1 || e.code === "ENOENT") return [];
    throw err;
  }
}

/** End the supervisor's whole process group — the runtime it started shares
 *  it — and wait for the supervisor itself to be gone. A SIGKILL on the
 *  supervisor alone orphans the runtime: nothing forwards a KILL. */
async function killGroup(s: { child: ChildProcess; exited: Promise<number | null> }): Promise<void> {
  // The group outlives the supervisor: a runtime orphaned by a KILL keeps the
  // group id, so the group is signalled whether or not the supervisor is gone.
  if (s.child.pid !== undefined) {
    try {
      process.kill(-s.child.pid, "SIGKILL");
    } catch {
      // the group is gone already
    }
  }
  await s.exited;
}

afterEach(async () => {
  for (const s of started.splice(0)) {
    const exited = new Promise<number | null>((r) => {
      if (s.child.exitCode !== null || s.child.signalCode !== null) r(s.child.exitCode);
      else s.child.on("exit", (c) => r(c));
    });
    await killGroup({ child: s.child, exited });
  }
  // The point of the group kill: a test run leaves no fake runtime
  // behind, whatever signal ended its supervisor.
  for (const d of dirs) {
    const alive = survivingRuntimes(d);
    for (const pid of alive) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone between the listing and the kill
      }
    }
    expect(alive, `runtime shells of ${d} still alive after the test`).toEqual([]);
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function startSupervisor(dir: string, runtime: string, args: string[] = []) {
  // Its own process group: the fake runtime the supervisor starts with `&`
  // joins it, so ending the group ends both — the supervisor forwards TERM
  // and INT itself, but nothing forwards a KILL.
  const child = spawn("sh", [SUPERVISOR, ...args], {
    env: { ...process.env, SANDBOX_RUNTIME: runtime },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  started.push({ child, dir });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  const starts = () => Number(readFileSync(join(dir, "count"), "utf8").trim() || 0);
  const log = () => readFileSync(join(dir, "log"), "utf8");
  const s = { child, exited, stderr: () => stderr, starts, log, stop: () => killGroup({ child, exited }) };
  return s;
}

async function until(cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const safeRead = (fn: () => number) => {
  try {
    return fn();
  } catch {
    return 0;
  }
};

describe("the runtime supervisor, driven", () => {
  it("starts the runtime again when it exits, with the same arguments, and says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-supervisor-"));
    dirs.push(dir);
    const s = startSupervisor(dir, fakeRuntime(dir, ["exit:1", "live"]), ["--flag", "value"]);
    try {
      // The fixture writes its counter before its log. Observe the restart's
      // log itself rather than racing that second write after the counter.
      await expect.poll(s.log, { timeout: 5_000 }).toContain("start 2 args=--flag value");
      expect(s.log()).toContain("start 1 args=--flag value");
      expect(s.log()).toContain("start 2 args=--flag value");
      expect(s.stderr()).toContain("sandbox-runtime-supervisor: the runtime exited with status 1; starting it again");
    } finally {
      await s.stop();
    }
  });

  it("a supervisor ended by SIGKILL takes its runtime with it when the group is ended, and leaves none behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-supervisor-"));
    dirs.push(dir);
    const s = startSupervisor(dir, fakeRuntime(dir, ["live"]), ["--flag", "value"]);
    await until(() => safeRead(s.starts) >= 1, 5_000);
    expect(survivingRuntimes(dir)).toHaveLength(1);
    // The supervisor alone: a KILL is not forwarded, so the runtime would live on…
    s.child.kill("SIGKILL");
    await s.exited;
    expect(survivingRuntimes(dir)).toHaveLength(1);
    // …until the group is ended, which is what every teardown here does.
    await s.stop();
    await until(() => survivingRuntimes(dir).length === 0, 5_000);
    expect(survivingRuntimes(dir)).toEqual([]);
  });

  it("forwards SIGTERM to the live runtime and exits with the runtime's own status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-supervisor-"));
    dirs.push(dir);
    const s = startSupervisor(dir, fakeRuntime(dir, ["live"]));
    await until(() => safeRead(s.starts) >= 1, 5_000);
    // Let the fake install its trap before the signal lands.
    await new Promise((r) => setTimeout(r, 200));
    s.child.kill("SIGTERM");
    expect(await s.exited).toBe(143);
    expect(s.log()).toContain("term");
    expect(s.starts()).toBe(1);
    expect(s.stderr()).not.toContain("starting it again");
  });

  it("forwards SIGINT as TERM — the background child ignores INT — and exits with the runtime's status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-supervisor-"));
    dirs.push(dir);
    const s = startSupervisor(dir, fakeRuntime(dir, ["live"]));
    await until(() => safeRead(s.starts) >= 1, 5_000);
    await new Promise((r) => setTimeout(r, 200));
    s.child.kill("SIGINT");
    expect(await s.exited).toBe(143);
    expect(s.log()).toContain("term");
    expect(s.log()).not.toContain("int");
  });

  it("a stop that lands during the pause between two starts ends it with the runtime's last status and starts nothing again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-supervisor-"));
    dirs.push(dir);
    const s = startSupervisor(dir, fakeRuntime(dir, ["exit:3", "live"]));
    // The restart line is printed right before the one-second pause.
    await until(() => s.stderr().includes("starting it again"), 5_000);
    s.child.kill("SIGTERM");
    expect(await s.exited).toBe(3);
    expect(s.starts()).toBe(1);
  });

  it("gives up after five exits in a row inside ten seconds of starting, with the last status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-supervisor-"));
    dirs.push(dir);
    const s = startSupervisor(dir, fakeRuntime(dir, ["exit:1", "exit:1", "exit:1", "exit:1", "exit:7"]));
    expect(await s.exited).toBe(7);
    expect(s.starts()).toBe(5);
    expect(s.stderr()).toContain("5 times in a row within 10s of starting; giving up");
  }, 15_000);
});
