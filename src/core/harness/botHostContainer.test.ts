import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "../../execution/executor.js";
import { BotHostHarnessContainer, harnessContainerFor, type SpawnFn } from "./botHostContainer.js";
import { ExecHarnessContainer, HARNESS_PORT_ENV, HarnessContainerError, PORT_ARG } from "./container.js";
import { PI_STDOUT_FILTER, piRunPaths, piRunPathsAt } from "./pi/process.js";

// Feature: docs/reference/specs/harness-pi.md item 12: the container seam on
// the bot host. A run whose machine class is `none` has no executor to exec
// through, so its pi is a child process of the bot itself. The run's root is
// one this container makes with mkdtemp (exclusive, 700, a suffix nobody can
// guess); every operation is `node:fs` and `node:child_process` under it,
// files created 600 and never replaced, the tree removed at the end; the
// child's environment is PATH, HOME and what the start names, never the
// bot's secrets; the log is pi's stdout less the streaming deltas, read as
// exact bytes. pi itself is stood in for by Node running a small script,
// through the spawn seam.

/** A run id of this test's own, so the root under /tmp is a sibling of nothing else's. */
const runId = () => `bothost-${process.pid}-${randomUUID().slice(0, 8)}`;

/** A pi stand-in: echoes every stdin line as a response record (its length
 *  beside it), writes one streaming delta first so the filter is exercised,
 *  says hello on stderr, settles and exits on `abort`, and exits on EOF. */
const FAKE_PI = `
  const rl = require("node:readline").createInterface({ input: process.stdin });
  process.stdout.write(JSON.stringify({ type: "message_update", ignored: true }) + "\\n");
  process.stderr.write("fake pi started\\n");
  rl.on("line", (line) => {
    const cmd = JSON.parse(line);
    if (cmd.type === "abort") {
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true, length: line.length }) + "\\n");
  });
  rl.on("close", () => process.exit(0));
`;

/** A pi stand-in that ignores TERM, so only KILL ends it, and starts a child
 *  of its own in its group, whose pid it announces, so the group kill is provable. */
const STUBBORN_PI = `
  process.on("SIGTERM", () => {});
  const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  process.stdout.write(JSON.stringify({ type: "child", pid: child.pid }) + "\\n");
  setInterval(() => {}, 1000);
`;

/** The spawn seam: what the container asked for, the child it got, and Node running `script` in pi's place. */
function scripted(script: string) {
  const calls: Array<{ command: string; args: string[]; options: Parameters<SpawnFn>[2]; child: ChildProcess }> = [];
  const spawn: SpawnFn = (command, args, options) => {
    const child = nodeSpawn(process.execPath, ["-e", script], options);
    calls.push({ command, args, options, child });
    return child;
  };
  return { spawn, calls };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const roots: string[] = [];
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});
/** The run's root as the container makes it from the one pi proposes, laid out as pi's, remembered for the clean-up. */
async function rootOf(container: BotHostHarnessContainer, id = runId()) {
  const paths = piRunPathsAt(await container.makeRoot(piRunPaths(id).dir));
  roots.push(paths.dir);
  return paths;
}

describe("BotHostHarnessContainer: pi as a child of the bot", () => {
  it("makes the run's root beside the predictable one with a suffix nobody can guess, exclusive and 700, laid out like every run's; two calls give two roots", async () => {
    const container = new BotHostHarnessContainer();
    const id = runId();
    const a = await rootOf(container, id);
    const b = await rootOf(container, id);
    const predictable = piRunPaths(id).dir;
    for (const p of [a, b]) {
      expect(p.dir.startsWith(`${predictable}-`)).toBe(true);
      expect(p.dir.slice(predictable.length + 1).length).toBeGreaterThanOrEqual(6);
      expect(p.dir.split("/").slice(0, -1).join("/")).toBe("/var/tmp");
      expect(statSync(p.dir).mode & 0o777).toBe(0o700);
      expect(p).toEqual(piRunPathsAt(p.dir));
    }
    expect(a.dir).not.toBe(b.dir);
  });

  it("writes a file under the run's root: parents made at 700, the file at 600, exact bytes with no newline added; a path already present is refused by name, never replaced", async () => {
    const container = new BotHostHarnessContainer();
    const paths = await rootOf(container);
    await container.writeFile(`${paths.agentDir}/SYSTEM.md`, "hello 'quoted'\nline two");
    expect(readFileSync(`${paths.agentDir}/SYSTEM.md`, "utf8")).toBe("hello 'quoted'\nline two");
    expect(statSync(paths.agentDir).mode & 0o777).toBe(0o700);
    expect(statSync(`${paths.agentDir}/SYSTEM.md`).mode & 0o777).toBe(0o600);
    await expect(container.writeFile(`${paths.agentDir}/SYSTEM.md`, "")).rejects.toThrow(
      /harness container: write failed/,
    );
    expect(readFileSync(`${paths.agentDir}/SYSTEM.md`, "utf8")).toBe("hello 'quoted'\nline two");
  });

  it("starts pi in the run's directory with the arguments as given, PATH and HOME from the host and the start's env (never another host variable), the run's directories at 700, the two logs created empty, the pid recorded; it is alive until it is ended", async () => {
    const { spawn, calls } = scripted(FAKE_PI);
    const container = new BotHostHarnessContainer({
      spawn,
      env: { PATH: process.env.PATH!, HOME: "/home/switchboard", SLACK_BOT_TOKEN: "xoxb-host-secret", PORT: "8080" },
    });
    const paths = await rootOf(container);
    const args = ["--mode", "rpc", "-e", paths.extension, "--tools", "web_fetch,update_status"];
    const { pid } = await container.start({
      paths,
      command: "pi",
      stdoutFilter: PI_STDOUT_FILTER,
      args,
      env: { SWITCHBOARD_RUN_BEARER: "sbr_run.s3cret", X: "1" },
    });
    try {
      expect(pid).toBeGreaterThan(0);
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe("pi");
      expect(calls[0].args).toEqual(args);
      expect(calls[0].options?.cwd).toBe(paths.dir);
      expect(calls[0].options?.env).toEqual({
        PATH: process.env.PATH,
        HOME: "/home/switchboard",
        SWITCHBOARD_RUN_BEARER: "sbr_run.s3cret",
        X: "1",
      });
      for (const dir of [paths.dir, paths.sessionDir, paths.commandDir])
        expect(statSync(dir).mode & 0o777, dir).toBe(0o700);
      expect(readFileSync(paths.pidFile, "utf8").trim()).toBe(String(pid));
      expect(statSync(paths.log).mode & 0o777).toBe(0o600);
      expect(statSync(paths.errLog).mode & 0o777).toBe(0o600);
      expect(await container.alive(pid)).toBe(true);
      expect(alive(pid)).toBe(true);
    } finally {
      await container.kill(pid);
    }
    expect(await container.alive(pid)).toBe(false);
  });

  it("cwd answers the run's root, whatever checkout the harness names: the directory start spawns pi in, present on this host, so a session written for that root names a directory pi finds when it resumes", async () => {
    const { spawn, calls } = scripted(FAKE_PI);
    const container = new BotHostHarnessContainer({ spawn });
    const paths = await rootOf(container);
    expect(container.cwd(paths, "/workspace")).toBe(paths.dir);
    expect(container.cwd(paths, "/workspace/threads/t/main")).toBe(paths.dir);
    expect(existsSync(container.cwd(paths, "/workspace"))).toBe(true);
    const { pid } = await container.start({ paths, command: "pi", stdoutFilter: PI_STDOUT_FILTER, args: [], env: {} });
    try {
      expect(calls[0].options?.cwd).toBe(container.cwd(paths, "/workspace"));
    } finally {
      await container.kill(pid);
    }
    // A second generation's root is another directory, and the answer follows it.
    const next = await rootOf(container);
    expect(next.dir).not.toBe(paths.dir);
    expect(container.cwd(next, "/workspace")).toBe(next.dir);
  });

  it("feeds a line to pi's stdin and reads pi's answers from the log as exact bytes from an offset: the streaming deltas never land, a long line goes through whole, and stderr is what tail reads", async () => {
    const container = new BotHostHarnessContainer({ spawn: scripted(FAKE_PI).spawn });
    const paths = await rootOf(container);
    const { pid } = await container.start({ paths, command: "pi", stdoutFilter: PI_STDOUT_FILTER, args: [], env: {} });
    try {
      await container.writeLine(paths, JSON.stringify({ id: "s", type: "get_state" }));
      const long = JSON.stringify({ id: "p", type: "prompt", message: "x".repeat(100_000) });
      await container.writeLine(paths, long);
      const expected =
        JSON.stringify({ id: "s", type: "response", command: "get_state", success: true, length: 29 }) +
        "\n" +
        JSON.stringify({ id: "p", type: "response", command: "prompt", success: true, length: long.length }) +
        "\n";
      await vi.waitFor(async () => {
        const all = await container.readLog(paths.log, 0, 64 * 1024);
        expect(Buffer.from(all).toString("utf8")).toBe(expected);
      });
      // Exact bytes from an offset, capped: the transport's offset arithmetic holds.
      const slice = await container.readLog(paths.log, 5, 10);
      expect(Buffer.from(slice).toString("utf8")).toBe(expected.slice(5, 15));
      expect((await container.readLog(paths.log, expected.length, 10)).length).toBe(0);
      await vi.waitFor(async () => expect(await container.tail(paths.errLog, 2000)).toBe("fake pi started\n"));
      expect(await container.tail(paths.errLog, 8)).toBe("started\n");
      expect(await container.tail(`${paths.dir}/missing`, 100)).toBe("");
    } finally {
      await container.kill(pid);
    }
  });

  it("a settled pi that exits is found dead, and its last records are still in the log", async () => {
    const container = new BotHostHarnessContainer({ spawn: scripted(FAKE_PI).spawn });
    const paths = await rootOf(container);
    const { pid } = await container.start({ paths, command: "pi", stdoutFilter: PI_STDOUT_FILTER, args: [], env: {} });
    await container.writeLine(paths, JSON.stringify({ type: "abort" }));
    await vi.waitFor(async () => expect(await container.alive(pid)).toBe(false));
    const log = Buffer.from(await container.readLog(paths.log, 0, 4096)).toString("utf8");
    expect(log).toBe(JSON.stringify({ type: "agent_settled" }) + "\n");
    await expect(container.writeLine(paths, "{}")).rejects.toBeInstanceOf(HarnessContainerError);
  });

  it("kill ends pi and everything in its group (TERM, then KILL for a pi that ignores TERM) and is idempotent, for an ended pid and for one this container never started", async () => {
    const container = new BotHostHarnessContainer({ spawn: scripted(STUBBORN_PI).spawn, killGraceMs: 100 });
    const paths = await rootOf(container);
    const { pid } = await container.start({ paths, command: "pi", stdoutFilter: PI_STDOUT_FILTER, args: [], env: {} });
    let grandchild = 0;
    await vi.waitFor(async () => {
      const log = Buffer.from(await container.readLog(paths.log, 0, 4096)).toString("utf8");
      grandchild = (JSON.parse(log.trim()) as { pid: number }).pid;
      expect(grandchild).toBeGreaterThan(0);
    });
    expect(alive(grandchild)).toBe(true);
    await container.kill(pid);
    expect(await container.alive(pid)).toBe(false);
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false));
    await container.kill(pid);
    await container.kill(999_999_999);
  });

  it("names no container: a bot-host pi never outlives the bot, so a resume judges it by its pid alone", async () => {
    expect(await new BotHostHarnessContainer().identity()).toBeUndefined();
  });

  it("alive answers no for a pid this container did not start: a previous bot generation's pi is out of reach, so a resume restarts pi on the mirrored transcript", async () => {
    const container = new BotHostHarnessContainer();
    expect(await container.alive(process.pid)).toBe(false);
  });

  it("remove takes the run's root down as one tree once pi has ended, and a root already gone is not a failure", async () => {
    const container = new BotHostHarnessContainer({ spawn: scripted(FAKE_PI).spawn });
    const paths = await rootOf(container);
    await container.writeFile(`${paths.agentDir}/models.json`, "{}");
    const { pid } = await container.start({ paths, command: "pi", stdoutFilter: PI_STDOUT_FILTER, args: [], env: {} });
    await container.kill(pid);
    await container.remove(paths);
    expect(existsSync(paths.dir)).toBe(false);
    await container.remove(paths);
  });

  it("a log the host cannot write ends pi rather than the bot: no unhandled stream error, pi found dead, the error log still readable, the root removable", async () => {
    const failing = () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback(new Error("ENOSPC: no space left on device, write"));
        },
      });
    const container = new BotHostHarnessContainer({ spawn: scripted(FAKE_PI).spawn, openLog: failing });
    const paths = await rootOf(container);
    const { pid } = await container.start({ paths, command: "pi", stdoutFilter: PI_STDOUT_FILTER, args: [], env: {} });
    await container.writeLine(paths, JSON.stringify({ id: "s", type: "get_state" }));
    await vi.waitFor(async () => expect(await container.alive(pid)).toBe(false));
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
    expect((await container.readLog(paths.log, 0, 4096)).length).toBe(0);
    await vi.waitFor(async () => expect(await container.tail(paths.errLog, 2000)).toBe("fake pi started\n"));
    await container.remove(paths);
    expect(existsSync(paths.dir)).toBe(false);
  });

  it("a pi that was spawned but could not be tracked is ended before start fails by name", async () => {
    const { spawn, calls } = scripted(FAKE_PI);
    const container = new BotHostHarnessContainer({ spawn });
    const paths = await rootOf(container);
    // The pid file's path is a directory, so recording the pid fails after the spawn.
    await mkdir(paths.pidFile, { recursive: true, mode: 0o700 });
    await expect(
      container.start({ paths, command: "pi", stdoutFilter: PI_STDOUT_FILTER, args: [], env: {} }),
    ).rejects.toThrow(/harness container: start failed/);
    expect(calls).toHaveLength(1);
    const child = calls[0].child;
    await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true));
    expect(await container.alive(child.pid!)).toBe(false);
  });

  it("a pi that cannot be started is a named start failure, never a hang", async () => {
    const container = new BotHostHarnessContainer({
      spawn: (_command, args, options) => nodeSpawn(`${options.cwd as string}/no-such-pi`, args, options),
    });
    const paths = await rootOf(container);
    await expect(
      container.start({ paths, command: "pi", stdoutFilter: PI_STDOUT_FILTER, args: [], env: {} }),
    ).rejects.toThrow(/harness container: start failed/);
  });

  it("a line for a run with no pi on this host is a named send failure", async () => {
    const container = new BotHostHarnessContainer();
    await expect(container.writeLine(piRunPaths("run-none"), "{}")).rejects.toThrow(/harness container: send failed/);
  });
});

describe("BotHostHarnessContainer: the seam is harness-neutral in fact", () => {
  it("makes the root beside whatever root the harness proposes — another harness's prefix included — exclusive and 700", async () => {
    const container = new BotHostHarnessContainer();
    const wanted = `/tmp/switchboard-oc-${runId()}`;
    const root = await container.makeRoot(wanted);
    roots.push(root);
    expect(root.startsWith(`${wanted}-`)).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it("starts the command it is given, not pi, with the arguments as given and no filter when the start names none: every stdout line lands", async () => {
    const { spawn, calls } = scripted(FAKE_PI);
    const container = new BotHostHarnessContainer({ spawn, env: { PATH: process.env.PATH! } });
    const paths = await rootOf(container);
    const { pid } = await container.start({ paths, command: "opencode", args: ["serve"], env: {} });
    try {
      expect(calls[0].command).toBe("opencode");
      expect(calls[0].args).toEqual(["serve"]);
      // The fake's first line is a streaming delta: with no filter it is in the log.
      await vi.waitFor(async () => {
        const log = Buffer.from(await container.readLog(paths.log, 0, 4096)).toString("utf8");
        expect(log).toBe(JSON.stringify({ type: "message_update", ignored: true }) + "\n");
      });
    } finally {
      await container.kill(pid);
    }
  });

  it("keepLog: a start over a log that already has bytes appends after them instead of refusing or truncating — the tailer's feed survives a restart of its writer", async () => {
    const { spawn } = scripted(FAKE_PI);
    const container = new BotHostHarnessContainer({ spawn, env: { PATH: process.env.PATH! } });
    const paths = await rootOf(container);
    writeFileSync(paths.log, "kept\n");
    writeFileSync(paths.errLog, "earlier\n");
    const { pid } = await container.start({ paths, command: "opencode", args: ["serve"], env: {}, keepLog: true });
    try {
      await vi.waitFor(async () => {
        const log = Buffer.from(await container.readLog(paths.log, 0, 4096)).toString("utf8");
        expect(log).toBe("kept\n" + JSON.stringify({ type: "message_update", ignored: true }) + "\n");
      });
    } finally {
      await container.kill(pid);
    }
  });

  it("a start that asks for a free port is given one from the host: the port replaces its placeholder among the arguments, rides the environment, and comes back with the pid; a given port is passed through", async () => {
    const { spawn, calls } = scripted(FAKE_PI);
    const container = new BotHostHarnessContainer({
      spawn,
      env: { PATH: process.env.PATH! },
      freePort: async () => 41777,
    });
    const paths = await rootOf(container);
    const started = await container.start({
      paths,
      command: "opencode",
      args: ["serve", "--port", PORT_ARG],
      env: {},
      port: "free",
    });
    try {
      expect(started.port).toBe(41777);
      expect(calls[0].args).toEqual(["serve", "--port", "41777"]);
      expect(calls[0].options?.env).toMatchObject({ [HARNESS_PORT_ENV]: "41777" });
    } finally {
      await container.kill(started.pid);
    }
    const given = await rootOf(container);
    const again = await container.start({ paths: given, command: "opencode", args: [PORT_ARG], env: {}, port: 41888 });
    try {
      expect(again.port).toBe(41888);
      expect(calls[1].args).toEqual(["41888"]);
    } finally {
      await container.kill(again.pid);
    }
    // The placeholder with no port named is refused by name before anything is spawned.
    const plain = await rootOf(container);
    await expect(container.start({ paths: plain, command: "opencode", args: [PORT_ARG], env: {} })).rejects.toThrow(
      /harness container: start failed — the arguments carry \{port\} but the start names no port/,
    );
    expect(calls).toHaveLength(2);
    // No port asked and no placeholder: none picked, nothing in the environment.
    const none = await container.start({ paths: plain, command: "opencode", args: ["serve"], env: {} });
    try {
      expect(none).toEqual({ pid: none.pid });
      expect(calls[2].args).toEqual(["serve"]);
      expect(calls[2].options?.env).not.toHaveProperty(HARNESS_PORT_ENV);
    } finally {
      await container.kill(none.pid);
    }
  });

  it("request reaches a server on the host's loopback with the method, path, headers — a secret header among them — and body, and answers the status, the headers and the body whatever the status; a server that does not answer in time, or a port nothing listens on, is a named failure", async () => {
    const seen: Array<{
      method: string | undefined;
      url: string | undefined;
      headers: Record<string, unknown>;
      body: string;
    }> = [];
    const server = createServer((req, res) => {
      if (req.url === "/hang") return; // never answers
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.statusCode = req.url === "/fail" ? 503 : 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ echoed: body }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const container = new BotHostHarnessContainer();
      const paths = piRunPaths("run-none");
      const ok = await container.request(paths, {
        method: "POST",
        port,
        path: "/api/session/ses_1/prompt",
        headers: { "content-type": "text/plain" },
        secretHeaders: { authorization: "Basic abc" },
        body: "hello",
      });
      expect(ok).toMatchObject({
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"echoed":"hello"}',
      });
      expect(seen[0]).toMatchObject({
        method: "POST",
        url: "/api/session/ses_1/prompt",
        headers: { "content-type": "text/plain", authorization: "Basic abc" },
        body: "hello",
      });
      const failed = await container.request(paths, { method: "GET", port, path: "/fail" });
      expect(failed.status).toBe(503);
      expect(failed.body).toBe('{"echoed":""}');
      // Bounded like the exec class's commands: a server that holds the request open is a named failure, not a hung run.
      const bounded = new BotHostHarnessContainer({ requestTimeoutMs: 50 });
      await expect(bounded.request(paths, { method: "GET", port, path: "/hang" })).rejects.toThrow(
        /harness container: request failed/,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
    await expect(
      new BotHostHarnessContainer().request(piRunPaths("run-none"), { method: "GET", port, path: "/" }),
    ).rejects.toThrow(/harness container: request failed/);
    await expect(
      new BotHostHarnessContainer().request(piRunPaths("run-none"), { method: "GET", port: 0, path: "/" }),
    ).rejects.toThrow(/not a port/);
  });
});

describe("harnessContainerFor: the container follows the run's machine class", () => {
  const executor: Executor = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
  it("a class with a workspace gets the container over the run's executor; `none` gets the bot host", () => {
    expect(harnessContainerFor(executor, "repo-resident")).toBeInstanceOf(ExecHarnessContainer);
    expect(harnessContainerFor(executor, "repo-cold")).toBeInstanceOf(ExecHarnessContainer);
    expect(harnessContainerFor(executor, "blank")).toBeInstanceOf(ExecHarnessContainer);
    expect(harnessContainerFor(executor, "none")).toBeInstanceOf(BotHostHarnessContainer);
  });
});
