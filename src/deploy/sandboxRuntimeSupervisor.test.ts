import { spawn, execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SUPERVISOR = resolve(ROOT, "deploy/cloudflare-sandbox/runtime-supervisor.sh");
const DOCKERFILE = resolve(ROOT, "deploy/cloudflare-sandbox/Dockerfile");

// Feature: docs/reference/specs/execution.md item 21 — the cold sandbox's
// container outlives its runtime. The SDK's container server exits on any
// uncaught exception and used to be PID 1, so one such error ended the
// container: workspace gone, every later command a 500. The image's PID 1 is
// now this supervisor, which starts the server again when it exits. Static
// checks read the script and the Dockerfile; the behavioural ones drive the
// script with a fake runtime, since the real one only runs in the image.

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
  it("is the supervisor, installed at mode 755 and named by the image's one ENTRYPOINT", () => {
    const lines = instructions(dockerfile);
    expect(lines).toContain("COPY --chmod=0755 runtime-supervisor.sh /usr/local/bin/sandbox-runtime-supervisor");
    const entrypoints = lines.filter((l) => l.startsWith("ENTRYPOINT"));
    expect(entrypoints).toEqual(['ENTRYPOINT ["/usr/local/bin/sandbox-runtime-supervisor"]']);
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
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function startSupervisor(dir: string, runtime: string, args: string[] = []) {
  const child = spawn("sh", [SUPERVISOR, ...args], {
    env: { ...process.env, SANDBOX_RUNTIME: runtime },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  const starts = () => Number(readFileSync(join(dir, "count"), "utf8").trim() || 0);
  const log = () => readFileSync(join(dir, "log"), "utf8");
  return { child, exited, stderr: () => stderr, starts, log };
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
      await until(() => safeRead(s.starts) >= 2, 5_000);
      expect(s.log()).toContain("start 1 args=--flag value");
      expect(s.log()).toContain("start 2 args=--flag value");
      expect(s.stderr()).toContain("sandbox-runtime-supervisor: the runtime exited with status 1; starting it again");
    } finally {
      s.child.kill("SIGKILL");
      await s.exited;
    }
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
