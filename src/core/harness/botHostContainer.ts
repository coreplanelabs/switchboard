// The container seam on the bot host (docs/reference/specs/harness-pi.md item
// 12): the implementation of `HarnessContainer` for a run whose machine class
// is `none`, the general, research and conductor presets. Such a run has no
// execution container and no executor to exec through, so its harness process
// is a child process of the bot itself: the operations are `node:fs` and
// `node:child_process` on a root this container makes for the run, exclusive
// and 700 in one `mkdtemp` call (so no path a run's files land on exists
// before this container makes it, and none is predictable), its files created
// 600 and never replaced, the whole tree removed at the end. The process's
// stdin is a pipe from the bot (a bot death closes it, and the process exits
// on the end of file); its stdout goes through the filter the start names into
// the same log the transport polls; its stderr into its own file; a server it
// listens on over loopback is reached with `fetch`. The child's environment is
// PATH, HOME and what the start names, and never another variable of the
// bot's, whose process holds every secret the deployment has. Nothing in the
// run's toolset reaches the host: a `none` run has no shell or file tool
// (`piBuiltinToolsFor`), and the gate refuses one the process asks for all the
// same.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import type { Writable } from "node:stream";
import type { MachineClass } from "../../agents/registry.js";
import type { Executor } from "../../execution/executor.js";
import { publicEnv, type EnvRecord } from "../../secrets.js";
import {
  checkPortArg,
  ExecHarnessContainer,
  HARNESS_PORT_ENV,
  HarnessContainerError,
  OP_TIMEOUT_MS,
  PORT_ARG,
  type HarnessContainer,
  type HarnessPaths,
  type HarnessRequest,
  type HarnessResponse,
  type HarnessStart,
  type HarnessStarted,
} from "./container.js";
import { jsonlLines } from "./pi/protocol.js";

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface BotHostHarnessContainerDeps {
  /** The process spawner; a test runs Node in the harness process's place. */
  spawn?: SpawnFn;
  /** The host environment PATH and HOME are read from; the process's public
   *  variables by default (`publicEnv`: never a secret, though only those two
   *  names are read from it in any case). */
  env?: EnvRecord;
  /** Between the TERM and the KILL a kill sends; a second, like the exec script's `sleep 1`. */
  killGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Opens the file a run's filtered stdout is appended to; a test hands one that fails. */
  openLog?: (path: string) => Writable;
  /** Picks a free loopback port for a start that asks for one; the host's own `net` by default. */
  freePort?: () => Promise<number>;
  /** How long a request into a loopback server may take before it is a named failure; the seam's own bound by default. */
  requestTimeoutMs?: number;
}

interface Child {
  process: ChildProcess;
  pid: number;
  exited: boolean;
  /** Every stdout line has been filtered into the log and the streams are closed. */
  drained: Promise<void>;
}

/** A free loopback port from the host: bound once on 0 and released. */
async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      server.close(() => (port === undefined ? reject(new Error("no port was bound")) : resolve(port)));
    });
  });
}

export class BotHostHarnessContainer implements HarnessContainer {
  private readonly byDir = new Map<string, Child>();
  private readonly byPid = new Map<number, Child>();
  private readonly spawn: SpawnFn;
  private readonly env: EnvRecord;
  private readonly killGraceMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly openLog: (path: string) => Writable;
  private readonly freePort: () => Promise<number>;
  private readonly requestTimeoutMs: number;

  constructor(deps: BotHostHarnessContainerDeps = {}) {
    this.spawn = deps.spawn ?? (nodeSpawn as SpawnFn);
    this.env = deps.env ?? publicEnv();
    this.killGraceMs = deps.killGraceMs ?? 1000;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.openLog = deps.openLog ?? ((path) => createWriteStream(path, { flags: "a" }));
    this.freePort = deps.freePort ?? freeLoopbackPort;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? OP_TIMEOUT_MS;
  }

  /** A root of the run's own, made here and nowhere else: `mkdtemp` beside the
   *  root the harness proposed, on its name as the prefix, exclusive and 700
   *  in one call, with a suffix nobody can guess. The harness records it on
   *  the row (harness-pi item 8), so the next generation finds it there. */
  async makeRoot(wanted: string): Promise<string> {
    try {
      return await mkdtemp(`${wanted}-`);
    } catch (err) {
      throw new HarnessContainerError("root", message(err));
    }
  }

  /** The run's own root: `start` spawns the process in it, so that is the
   *  directory a session written for this root names, present on this host in
   *  this generation. The checkout the harness names is a container path this
   *  host does not have (a `none` run has no workspace), and the previous
   *  generation's root is gone with its process: neither is where it runs. */
  cwd(paths: HarnessPaths, _checkout: string): string {
    return paths.dir;
  }

  /** Parents at 700, the file at 600, exact bytes, created and never
   *  replaced: under a root this container made nothing is there before the
   *  harness writes it, so a path already present is a named failure, never
   *  followed or truncated. */
  async writeFile(path: string, content: string): Promise<void> {
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, content, { mode: 0o600, flag: "wx" });
    } catch (err) {
      throw new HarnessContainerError("write", message(err));
    }
  }

  /** The run's directories at 700, the two logs created empty, the command
   *  spawned in the run's directory as its own group leader with the start's
   *  env over PATH and HOME (and the port, when the start names one, picked
   *  here on the host and put in `PORT_ARG`'s place), its pid recorded; a
   *  spawn that fails is a named failure, and a process that was spawned but
   *  could not be tracked is ended before the failure. */
  async start(start: HarnessStart): Promise<HarnessStarted> {
    checkPortArg(start);
    const { paths } = start;
    try {
      for (const dir of paths.dirs) await mkdir(dir, { recursive: true, mode: 0o700 });
      // `keepLog`: create when missing, never truncate (the tailer's feed is read by offset and its writer may restart).
      await writeFile(paths.log, "", { mode: 0o600, flag: start.keepLog ? "a" : "wx" });
      await writeFile(paths.errLog, "", { mode: 0o600, flag: start.keepLog ? "a" : "wx" });
    } catch (err) {
      throw new HarnessContainerError("start", message(err));
    }
    const port = start.port === undefined ? undefined : start.port === "free" ? await this.freePort() : start.port;
    const args = port === undefined ? start.args : start.args.map((a) => (a === PORT_ARG ? String(port) : a));
    const env: Record<string, string> = {
      ...(this.env.PATH ? { PATH: this.env.PATH } : {}),
      ...(this.env.HOME ? { HOME: this.env.HOME } : {}),
      ...start.env,
      ...(port === undefined ? {} : { [HARNESS_PORT_ENV]: String(port) }),
    };
    const child = this.spawn(start.command, args, {
      cwd: paths.dir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch((err: unknown) => {
      throw new HarnessContainerError("start", message(err));
    });
    const pid = child.pid;
    if (pid === undefined || !child.stdout || !child.stderr || !child.stdin) {
      child.kill("SIGKILL");
      throw new HarnessContainerError("start", `${start.command} was spawned without a pid or piped stdio`);
    }
    // The two files the process's output lands in are the bot host's disk,
    // not the process's. A write that fails there (a full disk, a /tmp taken
    // away) is handled here, never left as an unhandled stream error in the
    // bot process: the run cannot go on without its log, so the process is
    // ended, the harness finds it dead and fails the run with the error log's
    // tail, and the reader loop below stops waiting for a drain that would
    // never come.
    const log = this.openLog(paths.log);
    const err = createWriteStream(paths.errLog, { flags: "a" });
    let logFailed = false;
    log.on("error", () => {
      logFailed = true;
      signal(pid, "SIGKILL");
    });
    err.on("error", () => {});
    child.stderr.pipe(err);
    const stdout = child.stdout;
    const dropped = start.stdoutFilter?.dropLinesContaining;
    const drained = (async () => {
      for await (const line of jsonlLines(stdout)) {
        if (logFailed) break;
        if (dropped !== undefined && line.includes(dropped)) continue;
        if (!log.write(line + "\n"))
          await new Promise<void>((r) => {
            log.once("drain", () => r());
            log.once("error", () => r());
          });
      }
      if (logFailed) log.destroy();
      else await new Promise<void>((r) => log.end(() => r()));
    })().catch(() => {});
    const entry: Child = { process: child, pid, exited: false, drained };
    child.once("exit", () => {
      entry.exited = true;
    });
    // A spawn error after the start is the process's death, read by `alive`; nothing to throw to.
    child.on("error", () => {
      entry.exited = true;
    });
    try {
      await writeFile(paths.pidFile, `${pid}\n`, { mode: 0o600, flag: "wx" });
    } catch (e) {
      // A process nothing would track is a process nobody could end: it goes with the failure.
      signal(pid, "SIGKILL");
      throw new HarnessContainerError("start", message(e));
    }
    this.byDir.set(paths.dir, entry);
    this.byPid.set(pid, entry);
    return port === undefined ? { pid } : { pid, port };
  }

  /** One protocol line into the process's stdin; a pipe has no line length to keep under. */
  async writeLine(paths: HarnessPaths, line: string): Promise<void> {
    const child = this.byDir.get(paths.dir);
    if (!child || child.exited || !child.process.stdin || child.process.stdin.destroyed)
      throw new HarnessContainerError("send", `no process is running for ${paths.dir} on this host`);
    const stdin = child.process.stdin;
    await new Promise<void>((resolve, reject) => {
      stdin.write(line + "\n", (err) => (err ? reject(new HarnessContainerError("send", message(err))) : resolve()));
    });
  }

  async readLog(path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    let handle;
    try {
      handle = await open(path, "r");
    } catch (err) {
      throw new HarnessContainerError("read", message(err));
    }
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, offset);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  /** Alive means a process THIS container started and has not seen exit. A
   *  pid from a previous bot generation is out of reach (its stdin was that
   *  process's pipe), so it is answered dead, and the harness restarts on the
   *  mirrored transcript, the path a container's process that died with its
   *  container takes. */
  async alive(pid: number): Promise<boolean> {
    const child = this.byPid.get(pid);
    return child !== undefined && !child.exited;
  }

  /** The bot host names no container: its process is a child of one bot
   *  generation and never outlives it, so a resume judges it by its pid alone
   *  (`alive` answers no for a pid this container did not start). */
  async identity(): Promise<string | undefined> {
    return undefined;
  }

  /** `fetch` to the loopback port the run's process listens on, bounded like
   *  the exec class's commands: the answer whatever its status; a server that
   *  does not answer, or not in time, is a named failure. A secret header is a
   *  header here — nothing is logged on this road. */
  async request(_paths: HarnessPaths, req: HarnessRequest): Promise<HarnessResponse> {
    if (!Number.isInteger(req.port) || req.port < 1 || req.port > 65535)
      throw new HarnessContainerError("request", `not a port: ${String(req.port)}`);
    if (!req.path.startsWith("/")) throw new HarnessContainerError("request", `not a path: ${req.path}`);
    try {
      const res = await fetch(`http://127.0.0.1:${req.port}${req.path}`, {
        method: req.method,
        headers: { ...req.headers, ...req.secretHeaders },
        ...(req.body !== undefined ? { body: req.body } : {}),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
    } catch (err) {
      throw new HarnessContainerError("request", message(err));
    }
  }

  /** The group first (the process leads it), then the process itself: TERM,
   *  the grace, KILL; a pid this container never started, or one already
   *  ended, is nothing to end. */
  async kill(pid: number): Promise<void> {
    const child = this.byPid.get(pid);
    if (!child || child.exited) return;
    signal(pid, "SIGTERM");
    const step = Math.min(20, this.killGraceMs);
    for (let waited = 0; !child.exited && waited < this.killGraceMs; waited += step) await this.sleep(step);
    // KILL only while the leader still stands: then the group id is certainly
    // this process's. Once the leader has gone, a group id could already name
    // a reused pid, so nothing is sent; the TERM reached every member of the
    // group while it existed, and a member that ignored it is left to the
    // container's own end.
    if (!child.exited) signal(pid, "SIGKILL");
    await new Promise<void>((resolve) => {
      if (child.exited) return resolve();
      child.process.once("exit", () => resolve());
    });
    child.process.stdin?.end();
  }

  async tail(path: string, bytes: number): Promise<string> {
    try {
      const text = await readFile(path);
      return text.subarray(Math.max(0, text.length - bytes)).toString("utf8");
    } catch {
      return "";
    }
  }

  /** The run's directory as one tree, once the process has ended (an ended
   *  process's last lines land in the log first; a live one is forgotten,
   *  never waited for); a directory already gone is not a failure. */
  async remove(paths: HarnessPaths): Promise<void> {
    const child = this.byDir.get(paths.dir);
    if (child) {
      this.byDir.delete(paths.dir);
      this.byPid.delete(child.pid);
      if (child.exited) await child.drained.catch(() => {});
    }
    try {
      await rm(paths.dir, { recursive: true, force: true });
    } catch (err) {
      throw new HarnessContainerError("remove", message(err));
    }
  }
}

/** TERM or KILL to the process group and to the leader, an already-gone target ignored. */
function signal(pid: number, sig: NodeJS.Signals): void {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, sig);
    } catch {
      // ESRCH: nothing there any more, which is what a kill wants.
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The container a run's harness process is driven through, by the run's
 *  machine class: a class with a workspace has an executor to exec through
 *  and the container is over it; `none` has no executor at all, so the
 *  process runs on the bot host. */
export function harnessContainerFor(executor: Executor, machine: MachineClass): HarnessContainer {
  return machine === "none" ? new BotHostHarnessContainer() : new ExecHarnessContainer(executor);
}
