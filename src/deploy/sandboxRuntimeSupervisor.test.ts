import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME,
  endCode,
  QUICK_EXIT_LIMIT,
  QUICK_EXIT_SECS,
  RESTART_PAUSE_MS,
  supervise,
  type SupervisedChild,
} from "../../deploy/cloudflare-sandbox/runtime-supervisor.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const SUPERVISOR = resolve(ROOT, "deploy/cloudflare-sandbox/runtime-supervisor.mjs");
const DOCKERFILE = resolve(ROOT, "deploy/cloudflare-sandbox/Dockerfile");

// Feature: docs/reference/specs/execution.md item 21 — the cold sandbox's
// container outlives its runtime. The SDK's container server exits on any
// uncaught exception and used to be tini's one child, so one such error
// ended the container: workspace gone, every later command a failure. tini
// now runs this supervisor, which starts the server again when it exits.
// Static checks read the source and the Dockerfile; the behavioural ones
// drive `supervise` with an injected process factory, clock, sleep and
// signal source — no real process, no shell, no wall-clock wait anywhere.

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

describe("the sandbox image's PID 1", () => {
  it("is tini running the supervisor, installed at mode 755, named by the image's one ENTRYPOINT", () => {
    const lines = instructions(dockerfile);
    expect(lines).toContain("COPY --chmod=0755 runtime-supervisor.mjs /usr/local/bin/sandbox-runtime-supervisor.mjs");
    const entrypoints = lines.filter((l) => l.startsWith("ENTRYPOINT"));
    expect(entrypoints).toEqual([
      'ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sandbox-runtime-supervisor.mjs"]',
    ]);
    // The base image's CMD is empty and stays so: the server takes no user command.
    expect(lines.some((l) => l.startsWith("CMD"))).toBe(false);
  });
});

describe("the runtime supervisor", () => {
  it("is dependency-free Node that runs the SDK's server by default, with the stated pause and give-up bounds", () => {
    // `#!/usr/bin/env node` finds the Node the image copies in; importing the
    // module above already proved the file parses.
    expect(supervisor.startsWith("#!/usr/bin/env node\n")).toBe(true);
    // Dependency-free: the image copies the one file, so only node: builtins.
    for (const m of supervisor.matchAll(/from "([^"]+)"/g)) {
      expect(m[1], `import of ${m[1]}`).toMatch(/^node:/);
    }
    expect(DEFAULT_RUNTIME).toBe("/container-server/sandbox");
    expect(RESTART_PAUSE_MS).toBe(1_000);
    expect(QUICK_EXIT_SECS).toBe(10);
    expect(QUICK_EXIT_LIMIT).toBe(5);
  });

  it("maps a child's end to the shell convention: its code, 128 + the signal's number, 127 for a start that failed", () => {
    expect(endCode(0, null)).toBe(0);
    expect(endCode(7, null)).toBe(7);
    expect(endCode(null, "SIGTERM")).toBe(143);
    expect(endCode(null, "SIGKILL")).toBe(137);
    expect(endCode(null, null)).toBe(127);
  });
});

/** A fake child under the test's control: records the signals it was sent,
 *  ends when the test says so. */
class FakeChild extends EventEmitter implements SupervisedChild {
  kills: string[] = [];
  kill(signal: "SIGTERM"): boolean {
    this.kills.push(signal);
    return true;
  }
  end(code: number | null, signal: string | null = null): void {
    this.emit("exit", code, signal);
  }
}

/** `supervise` over injected fakes: the test spawns no process, reads no
 *  clock and waits on nothing — it ends each fake child and advances the
 *  fake clock itself, then lets the loop's microtasks run with `settle`. */
function driver(args: string[] = [], opts: { holdSleep?: boolean } = {}) {
  const spawned: Array<{ runtime: string; args: string[]; child: FakeChild }> = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const signals = new EventEmitter();
  const clock = { at: 0 };
  let release: () => void = () => {};
  const done = supervise({
    runtime: "/container-server/sandbox",
    args,
    spawn: (runtime, args) => {
      const child = new FakeChild();
      spawned.push({ runtime, args: [...args], child });
      return child;
    },
    now: () => clock.at,
    sleep: (ms) => {
      sleeps.push(ms);
      // Held open when the test wants to land a signal inside the pause;
      // otherwise the pause is over as soon as the loop looks.
      return new Promise<void>((r) => (opts.holdSleep ? (release = r) : r()));
    },
    log: (line) => logs.push(line),
    signals,
  });
  // Let the loop consume an exit it was handed: its awaits are all immediate
  // under the fake sleep, so draining the microtask queue settles it.
  const settle = () => new Promise((r) => setImmediate(r));
  return { spawned, sleeps, logs, signals, clock, done, settle, release: () => release() };
}

describe("the runtime supervisor, driven", () => {
  it("starts the runtime again when it exits, with the same arguments, and says so", async () => {
    const d = driver(["--flag", "value"]);
    expect(d.spawned).toHaveLength(1);
    d.spawned[0].child.end(1);
    await d.settle();
    expect(d.spawned).toHaveLength(2);
    expect(d.spawned.map((s) => s.args)).toEqual([
      ["--flag", "value"],
      ["--flag", "value"],
    ]);
    expect(d.sleeps).toEqual([RESTART_PAUSE_MS]);
    expect(d.logs).toEqual(["sandbox-runtime-supervisor: the runtime exited with status 1; starting it again"]);
    d.signals.emit("SIGTERM");
    d.spawned[1].child.end(null, "SIGTERM");
    expect(await d.done).toBe(143);
  });

  it("forwards SIGTERM to the live runtime and exits with the runtime's own status", async () => {
    const d = driver();
    d.signals.emit("SIGTERM");
    expect(d.spawned[0].child.kills).toEqual(["SIGTERM"]);
    d.spawned[0].child.end(null, "SIGTERM");
    expect(await d.done).toBe(143);
    expect(d.spawned).toHaveLength(1);
    expect(d.logs).toEqual([]);
  });

  it("forwards SIGINT as TERM — the server has one shutdown path — and exits with the runtime's status", async () => {
    const d = driver();
    d.signals.emit("SIGINT");
    expect(d.spawned[0].child.kills).toEqual(["SIGTERM"]);
    d.spawned[0].child.end(null, "SIGTERM");
    expect(await d.done).toBe(143);
    expect(d.spawned).toHaveLength(1);
  });

  it("a stop that lands during the pause between two starts ends it with the runtime's last status and starts nothing again", async () => {
    const d = driver([], { holdSleep: true });
    d.spawned[0].child.end(3);
    await d.settle();
    // The stop lands while the loop sits in its pause: the restart line is
    // already out, but nothing starts again.
    expect(d.sleeps).toEqual([RESTART_PAUSE_MS]);
    d.signals.emit("SIGTERM");
    d.release();
    expect(await d.done).toBe(3);
    expect(d.spawned).toHaveLength(1);
    expect(d.logs).toEqual(["sandbox-runtime-supervisor: the runtime exited with status 3; starting it again"]);
  });

  it("gives up after five exits in a row inside ten seconds of starting, with the last status", async () => {
    const d = driver();
    for (const code of [1, 1, 1, 1]) {
      d.spawned[d.spawned.length - 1].child.end(code);
      await d.settle();
    }
    expect(d.spawned).toHaveLength(5);
    d.spawned[4].child.end(7);
    expect(await d.done).toBe(7);
    expect(d.spawned).toHaveLength(5);
    expect(d.logs[4]).toBe(
      "sandbox-runtime-supervisor: the runtime exited with status 7, 5 times in a row within 10s of starting; giving up",
    );
  });

  it("an exit ten seconds or more after its start resets the quick-exit count, so the runtime keeps being started", async () => {
    const d = driver();
    for (let i = 0; i < 4; i++) {
      d.spawned[d.spawned.length - 1].child.end(1);
      await d.settle();
    }
    expect(d.spawned).toHaveLength(5);
    // The fifth run lives past the quick-exit window before it dies…
    d.clock.at += QUICK_EXIT_SECS * 1000;
    d.spawned[4].child.end(1);
    await d.settle();
    // …so the count starts over and a sixth start happens.
    expect(d.spawned).toHaveLength(6);
    d.signals.emit("SIGTERM");
    d.spawned[5].child.end(null, "SIGTERM");
    expect(await d.done).toBe(143);
  });

  it("a runtime that cannot start counts as a quick exit with status 127, and the limit ends the loop", async () => {
    const d = driver();
    for (let i = 0; i < QUICK_EXIT_LIMIT - 1; i++) {
      d.spawned[d.spawned.length - 1].child.emit("error", new Error("ENOENT"));
      await d.settle();
    }
    expect(d.spawned).toHaveLength(QUICK_EXIT_LIMIT);
    d.spawned[QUICK_EXIT_LIMIT - 1].child.emit("error", new Error("ENOENT"));
    expect(await d.done).toBe(127);
    expect(d.logs.at(-1)).toContain("status 127, 5 times in a row within 10s of starting; giving up");
  });

  it("a stop that lands before the first start is known still reaches the child it missed", async () => {
    // The signal fires from inside the factory, before `supervise` holds the
    // child: the loop forwards TERM right after the spawn returns.
    const spawned: FakeChild[] = [];
    const signals = new EventEmitter();
    let first = true;
    const done = supervise({
      runtime: "/container-server/sandbox",
      args: [],
      spawn: () => {
        const child = new FakeChild();
        spawned.push(child);
        if (first) {
          first = false;
          signals.emit("SIGTERM");
        }
        return child;
      },
      now: () => 0,
      sleep: async () => {},
      log: () => {},
      signals,
    });
    expect(spawned[0].kills).toEqual(["SIGTERM"]);
    spawned[0].end(null, "SIGTERM");
    expect(await done).toBe(143);
    expect(spawned).toHaveLength(1);
  });
});
