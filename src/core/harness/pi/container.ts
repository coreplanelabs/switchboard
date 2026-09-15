// The container as the pi harness needs it (docs/reference/specs/harness-pi.md
// item 4): a seam of operations — make the run's root, write a file, start pi
// detached, feed its stdin, read its log from an offset, ask whether it lives,
// end it, remove the run's directory — with
// two implementations: `ExecPiContainer`, which turns each into one command
// over the run's own `Executor` (the resident's `/exec` as the thread's user,
// the sandbox's, the local host's), and the in-memory fake the tests drive.
// pi's stdin is a FIFO the wrapper holds open for writing, so it never sees an
// end of file while pi lives; its stdout is a log the harness polls from the
// last byte it read, `message_update` deltas filtered at the source because no
// consumer wants a token at a time. The bearer reaches pi through the exec's
// env channel and is never part of a command.

import { parseExitPrefix, redactAndCap } from "../../runEvents.js";
import { shellQuote } from "../../../execution/shellQuote.js";
import type { Executor } from "../../../execution/executor.js";
import { piRunPaths, type PiRunPaths } from "./process.js";

export interface PiStart {
  paths: PiRunPaths;
  args: string[];
  env: Record<string, string>;
}

export interface PiContainer {
  /** Where a fresh run's files go: the run's root, laid out by `piRunPathsAt`.
   *  The exec container answers the predictable `/tmp/switchboard-pi-<runId>`
   *  its scripts make at 700 (harness-pi item 4); the bot host makes a root of
   *  its own, exclusively (item 12). The harness files nothing before it has
   *  the answer and records it on the row (item 8), so the way back never has
   *  to guess it. */
  makeRoot(runId: string): Promise<PiRunPaths>;
  /** The directory pi runs in under `paths`: what a session file written for
   *  that root names as its working directory (harness-pi item 8), because pi
   *  refuses to resume a session whose stored directory does not exist where
   *  it runs. The exec container's pi runs where the executor runs every
   *  command, the thread's checkout the harness names; the bot host's in the
   *  run's own root, the one it made and spawns pi in, a new name in each
   *  generation (item 12). Never a constant. */
  cwd(paths: PiRunPaths, checkout: string): string;
  /** Create `path` with `content`, mode 600, parents made. A container over a
   *  predictable root replaces what is there; one over a root it made itself
   *  finds nothing to replace and refuses a path already present. */
  writeFile(path: string, content: string): Promise<void>;
  /** Start pi detached in the run's directory; the pid is the wrapper's, the group pi runs in. */
  start(start: PiStart): Promise<{ pid: number }>;
  /** One protocol line into pi's stdin. */
  writeLine(paths: PiRunPaths, line: string): Promise<void>;
  /** Up to `maxBytes` of the log from `offset` — exact bytes, so the caller's offset arithmetic holds. */
  readLog(path: string, offset: number, maxBytes: number): Promise<Uint8Array>;
  alive(pid: number): Promise<boolean>;
  /** Which container this is (harness-pi item 8): a word that changes when the
   *  container is replaced and stays while it runs (the kernel's boot id for
   *  a container over an executor), recorded on the row's facts beside the
   *  pid, so the generation that comes back can tell "pi is elsewhere" from
   *  "pi is dead" before it probes a pid. Undefined when the container cannot
   *  name itself: then nothing is judged by it, and the pid decides as before. */
  identity(): Promise<string | undefined>;
  /** End pi and everything in its group; idempotent. */
  kill(pid: number): Promise<void>;
  /** The last `bytes` of a file — pi's stderr for a diagnostic. */
  tail(path: string, bytes: number): Promise<string>;
  /** Take the run's directory down as one tree, once pi has ended; idempotent. */
  remove(paths: PiRunPaths): Promise<void>;
}

/** Thrown when a container command failed as a command (a nonzero exit, an
 *  executor error): the harness fails the run with it. */
export class PiContainerError extends Error {
  constructor(
    readonly operation: string,
    detail: string,
  ) {
    super(`pi container: ${operation} failed — ${redactAndCap(detail, 400)}`);
    this.name = "PiContainerError";
  }
}

/** The most content one write command carries: under the resident's command
 *  cap (64,000 chars) with room for the quoting and the path. */
export const WRITE_CHUNK_CHARS = 40_000;
/** The most a line fed straight to the FIFO may be; longer lines go through a file. */
export const INLINE_LINE_CHARS = 40_000;
/** The most a log read asks for: the base64 of it stays under every executor's output cap. */
export const LOG_READ_BYTES = 48 * 1024;
/** What marks a streaming delta in pi's stdout: a line carrying it never reaches the log, on any container. */
export const MESSAGE_UPDATE_MARK = '"type":"message_update"';
/** The log filter: pi's streaming deltas never reach the log. */
const LOG_FILTER = `grep --line-buffered -v ${shellQuote(MESSAGE_UPDATE_MARK)}`;

/** `content` in chunks a shell argument can carry, each `printf '%s'`-ed, the
 *  first creating the file and its directories: exact bytes, no newline added,
 *  whatever the content. The umask comes before the mkdir, so every directory
 *  it creates — the run's root under `/tmp` among them — is the caller's alone
 *  at 700 (the `mkdtemp` shape), and the file is 600. */
export function writeFileScripts(path: string, content: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < Math.max(1, content.length); i += WRITE_CHUNK_CHARS)
    chunks.push(content.slice(i, i + WRITE_CHUNK_CHARS));
  const dir = path.slice(0, path.lastIndexOf("/")) || ".";
  return chunks.map((chunk, i) =>
    i === 0
      ? `umask 077 && mkdir -p ${shellQuote(dir)} && printf '%s' ${shellQuote(chunk)} > ${shellQuote(path)}`
      : `printf '%s' ${shellQuote(chunk)} >> ${shellQuote(path)}`,
  );
}

/** The wrapper that starts pi detached: the run's directories made at 700 in
 *  a subshell (the umask stays out of pi's own environment), the FIFO opened
 *  read-write on a spare descriptor so it never runs out of writers, the
 *  wrapper's own pid recorded (it leads the group pi and the filter run in),
 *  pi's stdin the FIFO, its stdout through the filter into the log, its
 *  stderr into its own file. The arguments are quoted one by one; the bearer
 *  is in none of them. */
export function startScript(start: PiStart): string {
  const { paths, args } = start;
  const inner = [
    `exec 3<>${shellQuote(paths.fifo)}`,
    `echo $$ > ${shellQuote(paths.pidFile)}`,
    `pi ${args.map(shellQuote).join(" ")} <&3 2>>${shellQuote(paths.errLog)} | ${LOG_FILTER} >> ${shellQuote(paths.log)}`,
  ].join("; ");
  return [
    `(umask 077 && mkdir -p ${shellQuote(paths.dir)} ${shellQuote(paths.sessionDir)} ${shellQuote(paths.commandDir)})`,
    `rm -f ${shellQuote(paths.fifo)}`,
    `mkfifo -m 600 ${shellQuote(paths.fifo)}`,
    `: > ${shellQuote(paths.log)}`,
    `: > ${shellQuote(paths.errLog)}`,
    `setsid -f sh -c ${shellQuote(inner)}`,
    `sleep 0.3`,
    `cat ${shellQuote(paths.pidFile)}`,
  ].join(" && ");
}

export function writeLineScript(fifo: string, line: string): string {
  return `printf '%s\\n' ${shellQuote(line)} >> ${shellQuote(fifo)}`;
}

/** A line too long for one argument: fed from the file it was written to. */
export function feedFileScript(fifo: string, file: string): string {
  return `cat ${shellQuote(file)} >> ${shellQuote(fifo)} && printf '\\n' >> ${shellQuote(fifo)} && rm -f ${shellQuote(file)}`;
}

/** `maxBytes` of the log from `offset` (0-based), base64 on one line so the
 *  bytes survive the executor's text channel exactly. */
export function readLogScript(path: string, offset: number, maxBytes: number): string {
  return `tail -c +${offset + 1} ${shellQuote(path)} | head -c ${maxBytes} | base64 | tr -d '\\n'`;
}

export function aliveScript(pid: number): string {
  return `kill -0 ${pid} 2>/dev/null && echo alive || echo dead`;
}

/** The container's identity: the kernel's boot id, one per VM boot and
 *  world-readable, so a run's pool user and the resident's root read the same
 *  word; a kernel without it answers nothing, never a failure. */
export function identityScript(): string {
  return "cat /proc/sys/kernel/random/boot_id 2>/dev/null || true";
}

/** What an identity may look like: one word of the boot id's alphabet. */
const IDENTITY_WORD = /^[A-Za-z0-9-]{1,64}$/;

/** The group first (the wrapper leads it), then the pid itself; TERM, a second, KILL; never a failure. */
export function killScript(pid: number): string {
  return `kill -TERM -- -${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null; sleep 1; kill -KILL -- -${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null; true`;
}

export function tailScript(path: string, bytes: number): string {
  return `tail -c ${bytes} ${shellQuote(path)} 2>/dev/null || true`;
}

/** The run's directory as one tree; a directory already gone is not a failure. */
export function removeScript(dir: string): string {
  return `rm -rf ${shellQuote(dir)}`;
}

const STDERR_MARK = "\n--- stderr ---\n";

/** The executors' word in place of a command's output: the resident answers
 *  an isolate swapped under a command with `runtime-replaced: …` as the
 *  command's text (resident-repos item 43), and the sandbox names a runtime
 *  nothing answered `runtime-unreachable: …` (execution item 9). Neither is
 *  what the command printed — it may never have run — so neither is an
 *  answer to `alive`, `read` or `send`; the harness reads the word for a
 *  container replaced under the run (harness-pi item 16). */
const RUNTIME_WORD = /^(?:runtime-unreachable:|runtime-replaced)/;

/** The stdout of an executor's answer: the `exit N:` prefix is a failure, the
 *  executors' runtime word is a failure naming it, the stderr the executors
 *  append is dropped, the empty marker is empty. */
export function stdoutOf(operation: string, out: string): string {
  const exit = parseExitPrefix(out);
  if (exit.failed || RUNTIME_WORD.test(out)) throw new PiContainerError(operation, out);
  const cut = out.indexOf(STDERR_MARK);
  const stdout = cut >= 0 ? out.slice(0, cut) : out;
  return stdout === "(no output)" ? "" : stdout;
}

/** How long one container command may take: the writes and reads are
 *  seconds; the start waits for the wrapper; the kill sleeps a second. */
const OP_TIMEOUT_MS = 60_000;

export class ExecPiContainer implements PiContainer {
  private commandNo = 0;

  constructor(private readonly executor: Executor) {}

  /** The predictable root under the sticky /tmp: no command runs here, the
   *  write and start scripts make it at 700 as the thread's user (item 4). */
  async makeRoot(runId: string): Promise<PiRunPaths> {
    return piRunPaths(runId);
  }

  /** The start script never changes directory, so pi runs where the executor
   *  runs every command: the thread's checkout, which the harness names (a
   *  resident's `/exec` runs in the thread's worktree). No command runs here. */
  cwd(_paths: PiRunPaths, checkout: string): string {
    return checkout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    for (const script of writeFileScripts(path, content)) stdoutOf("write", await this.exec(script));
  }

  async start(start: PiStart): Promise<{ pid: number }> {
    const out = stdoutOf("start", await this.exec(startScript(start), start.env)).trim();
    const pid = Number(out.split("\n").pop());
    if (!Number.isInteger(pid) || pid <= 0) throw new PiContainerError("start", `no pid came back (${out || "empty"})`);
    return { pid };
  }

  async writeLine(paths: PiRunPaths, line: string): Promise<void> {
    if (line.length <= INLINE_LINE_CHARS) {
      stdoutOf("send", await this.exec(writeLineScript(paths.fifo, line)));
      return;
    }
    const file = `${paths.commandDir}/${++this.commandNo}.json`;
    await this.writeFile(file, line);
    stdoutOf("send", await this.exec(feedFileScript(paths.fifo, file)));
  }

  async readLog(path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    const b64 = stdoutOf("read", await this.exec(readLogScript(path, offset, maxBytes))).trim();
    return b64 ? new Uint8Array(Buffer.from(b64, "base64")) : new Uint8Array(0);
  }

  async alive(pid: number): Promise<boolean> {
    return stdoutOf("alive", await this.exec(aliveScript(pid))).trim() === "alive";
  }

  /** One word or nothing: an empty answer, a malformed one or a command the
   *  executor could not run is no identity: a judgement never rests on a guess. */
  async identity(): Promise<string | undefined> {
    try {
      const word = stdoutOf("identity", await this.exec(identityScript())).trim();
      return IDENTITY_WORD.test(word) ? word : undefined;
    } catch {
      return undefined;
    }
  }

  async kill(pid: number): Promise<void> {
    stdoutOf("kill", await this.exec(killScript(pid)));
  }

  async tail(path: string, bytes: number): Promise<string> {
    try {
      return stdoutOf("tail", await this.exec(tailScript(path, bytes)));
    } catch {
      return "";
    }
  }

  async remove(paths: PiRunPaths): Promise<void> {
    stdoutOf("remove", await this.exec(removeScript(paths.dir)));
  }

  private exec(script: string, env?: Record<string, string>): Promise<string> {
    return this.executor.exec(script, { timeoutMs: OP_TIMEOUT_MS, ...(env ? { env } : {}) });
  }
}
