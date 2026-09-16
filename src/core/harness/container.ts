// The container seam (docs/reference/specs/harness.md item 9; harness-pi.md
// item 4): what any harness's process needs of the container the run's
// machine class provides — make the run's root, write a file, start the
// process detached behind a FIFO, feed its stdin, read its log from an offset,
// ask whether it lives, name the container, reach a server the process listens
// on over loopback, end the process, remove the run's directory. Three
// implementations: `ExecHarnessContainer` here, which turns each operation
// into one command over the run's own `Executor` (the resident's `/exec` as
// the thread's user, the sandbox's, the local host's); `BotHostHarnessContainer`
// (./botHostContainer.ts) for a run without a workspace, over `node:fs` and
// `node:child_process`; and the in-memory fake the tests drive
// (./testing/fakeContainer.ts). Nothing here names a harness: the binary, its
// arguments, the filter on its stdout and the layout of the run's directory
// are the start's inputs, and a loopback port is picked or passed for a
// process that serves one. The process's stdin is a FIFO the wrapper holds
// open for writing, so it never sees an end of file while the process lives;
// its stdout is a log the harness polls from the last byte it read, with the
// lines the harness names filtered at the source. A bearer reaches the process
// through the exec's env channel and is never part of a command.

import { ExecSandboxRestartedError, type Executor } from "../../execution/executor.js";
import { shellQuote } from "../../execution/shellQuote.js";
import { parseExitPrefix, redactAndCap } from "../runEvents.js";

/** The files a harness's process is driven through under the run's root, as
 *  the harness lays them out: the root and every directory the start makes
 *  at 700 (`dirs`, the root first), the FIFO its stdin is fed from, the log
 *  its stdout lands in, its error log, the pid file the wrapper records itself
 *  in, and where a command too long for one write lands before it is fed. A
 *  harness's own layout extends this with its own files (pi's `PiRunPaths`). */
export interface HarnessPaths {
  dir: string;
  dirs: readonly string[];
  fifo: string;
  log: string;
  errLog: string;
  pidFile: string;
  commandDir: string;
}

/** The one argument the start replaces with the port it picked or was given,
 *  so a process that must be told its port on the command line can be. */
export const PORT_ARG = "{port}";
/** The variable the started process finds its port under, when the start names one. */
export const HARNESS_PORT_ENV = "SWITCHBOARD_HARNESS_PORT";

export interface HarnessStart {
  paths: HarnessPaths;
  /** The program, a plain word on the container's PATH (`pi`, `opencode`); never a shell fragment. */
  command: string;
  /** Its arguments, quoted one by one; `PORT_ARG` among them is the port the start settled on. */
  args: string[];
  env: Record<string, string>;
  /** Lines of the process's stdout that never reach the log — pi's streaming
   *  deltas, filtered at the source because no reader wants a token at a time;
   *  absent, every line lands. */
  stdoutFilter?: { dropLinesContaining: string };
  /** A loopback port the process listens on: a number to hand it, or `free`
   *  to pick one in the container before the command runs. Either way the
   *  port replaces `PORT_ARG` in the arguments, rides the environment under
   *  `HARNESS_PORT_ENV`, and comes back as `HarnessStarted.port`, for the row. */
  port?: number | "free";
  /** Keep the log's bytes: the wrapper creates the log when it is missing and
   *  appends, instead of truncating it. For a process whose log is a file the
   *  harness reads by offset and may restart the writer of (OpenCode's tailer,
   *  whose stdout is the run's feed): a restart must not wipe what a recorded
   *  offset points into. Absent, the log starts empty, as pi's always has. */
  keepLog?: boolean;
}

/** What a start answers: the pid the wrapper recorded — the leader of the
 *  group the process runs in — and the port, when the start named one. */
export interface HarnessStarted {
  pid: number;
  port?: number;
}

/** One HTTP request into the container, to a server the run's process listens
 *  on over loopback (`http://127.0.0.1:<port><path>`): the method, the port and
 *  the path, the headers, and a body sent as it is. A header whose value is a
 *  secret — a server's per-run password as Basic auth — goes in
 *  `secretHeaders`: it reaches the command through the exec's env channel,
 *  never the command text the executors log, the road the bearer takes. */
export interface HarnessRequest {
  method: string;
  port: number;
  path: string;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, string>;
  body?: string;
}

/** The answer, whatever its status: a 5xx is an answer, not a failure; a
 *  request that reached no server is a `HarnessContainerError`. Header names
 *  are lowercased. */
export interface HarnessResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HarnessContainer {
  /** Where a fresh run's files go: the root the harness proposes (its
   *  predictable `/tmp/switchboard-<harness>-<runId>`), answered as the root
   *  the container makes. The exec container answers the proposal itself —
   *  its scripts make it at 700 as the thread's user (harness-pi item 4); the
   *  bot host makes a root of its own beside it, exclusively (item 12). The
   *  harness files nothing before it has the answer and records it on the row
   *  (item 8), so the way back never has to guess it. */
  makeRoot(wanted: string): Promise<string>;
  /** The directory the process runs in under `paths`: what a session file
   *  written for that root names as its working directory (harness-pi item 8),
   *  because pi refuses to resume a session whose stored directory does not
   *  exist where it runs. The exec container's process runs where the executor
   *  runs every command, the thread's checkout the harness names; the bot
   *  host's in the run's own root, the one it made and spawns the process in,
   *  a new name in each generation (item 12). Never a constant. */
  cwd(paths: HarnessPaths, checkout: string): string;
  /** Create `path` with `content`, mode 600, parents made. A container over a
   *  predictable root replaces what is there; one over a root it made itself
   *  finds nothing to replace and refuses a path already present. */
  writeFile(path: string, content: string): Promise<void>;
  /** Start the process detached in the run's directory; the pid is the wrapper's, the group the process runs in. */
  start(start: HarnessStart): Promise<HarnessStarted>;
  /** One protocol line into the process's stdin. */
  writeLine(paths: HarnessPaths, line: string): Promise<void>;
  /** Up to `maxBytes` of the log from `offset` — exact bytes, so the caller's offset arithmetic holds. */
  readLog(path: string, offset: number, maxBytes: number): Promise<Uint8Array>;
  alive(pid: number): Promise<boolean>;
  /** Which container this is (harness-pi item 8): a word that changes when the
   *  container is replaced and stays while it runs (the kernel's boot id for
   *  a container over an executor), recorded on the row's facts beside the
   *  pid, so the generation that comes back can tell "the process is
   *  elsewhere" from "the process is dead" before it probes a pid. Undefined
   *  when the container cannot name itself: then nothing is judged by it, and
   *  the pid decides as before. A container that is gone under the question —
   *  the executor's typed word for a replaced runtime — is thrown, never read
   *  as a container with no name. */
  identity(): Promise<string | undefined>;
  /** Reach a server the run's process listens on over loopback: the answer
   *  whatever its status; a container gone under the request is the typed
   *  error, like every other operation's. */
  request(paths: HarnessPaths, req: HarnessRequest): Promise<HarnessResponse>;
  /** End the process and everything in its group; idempotent. */
  kill(pid: number): Promise<void>;
  /** The last `bytes` of a file — the process's stderr for a diagnostic. */
  tail(path: string, bytes: number): Promise<string>;
  /** Take the run's directory down as one tree, once the process has ended; idempotent. */
  remove(paths: HarnessPaths): Promise<void>;
}

/** Thrown when a container command failed as a command (a nonzero exit, an
 *  executor error): the harness fails the run with it. */
export class HarnessContainerError extends Error {
  constructor(
    readonly operation: string,
    detail: string,
  ) {
    super(`harness container: ${operation} failed — ${redactAndCap(detail, 400)}`);
    this.name = "HarnessContainerError";
  }
}

/** The most content one write command carries: under the resident's command
 *  cap (64,000 chars) with room for the quoting and the path. */
export const WRITE_CHUNK_CHARS = 40_000;
/** The most a line fed straight to the FIFO, or a request body fed straight to curl, may be; longer ones go through a file. */
export const INLINE_LINE_CHARS = 40_000;
/** The most a log read asks for: the base64 of it stays under every executor's output cap. */
export const LOG_READ_BYTES = 48 * 1024;

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

/** A program name the start runs as given: a path or a word, nothing a shell would read twice. */
const COMMAND_WORD = /^[A-Za-z0-9_./-]+$/;

/** The port's placeholder among the arguments with no port named is a harness
 *  bug: refused by name, never handed to the program as the word `{port}`. */
export function checkPortArg(start: Pick<HarnessStart, "args" | "port">): void {
  if (start.port === undefined && start.args.includes(PORT_ARG))
    throw new HarnessContainerError("start", `the arguments carry ${PORT_ARG} but the start names no port`);
}

/** The stdout filter as the shell stage it is: every line carrying the mark dropped, line-buffered so a record lands as soon as it ends. */
export function logFilter(filter: NonNullable<HarnessStart["stdoutFilter"]>): string {
  return `grep --line-buffered -v ${shellQuote(filter.dropLinesContaining)}`;
}

/** Node picking a free loopback port and saying it: the one runtime both
 *  execution images carry (pi runs on it), so the pick needs no package. */
const FREE_PORT_JS =
  'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})';

/** The port the start settles on, exported for the wrapper's shell and the
 *  process's environment: picked in the container when `free`, else as given. */
function portLine(port: number | "free"): string {
  return port === "free"
    ? `export ${HARNESS_PORT_ENV}="$(node -e ${shellQuote(FREE_PORT_JS)})"`
    : `export ${HARNESS_PORT_ENV}=${port}`;
}

/** The wrapper that starts the process detached: the run's directories made at
 *  700 in a subshell (the umask stays out of the process's own environment),
 *  the FIFO opened read-write on a spare descriptor so it never runs out of
 *  writers, the wrapper's own pid recorded (it leads the group the process
 *  and the filter run in), the process's stdin the FIFO, its stdout through
 *  the filter — when the start names one — into the log, its stderr into its
 *  own file. The arguments are quoted one by one; the bearer is in none of
 *  them. A start that names a port exports it first and says it on the first
 *  line of the output; the pid is the last line either way. */
export function startScript(start: HarnessStart): string {
  const { paths, command, args, port, stdoutFilter, keepLog } = start;
  if (!COMMAND_WORD.test(command)) throw new HarnessContainerError("start", `not a program name: ${command}`);
  checkPortArg(start);
  const argv = args.map((a) => (a === PORT_ARG ? `"$${HARNESS_PORT_ENV}"` : shellQuote(a)));
  const filtered = stdoutFilter ? ` | ${logFilter(stdoutFilter)}` : "";
  const inner = [
    `exec 3<>${shellQuote(paths.fifo)}`,
    `echo $$ > ${shellQuote(paths.pidFile)}`,
    `${command} ${argv.join(" ")} <&3 2>>${shellQuote(paths.errLog)}${filtered} >> ${shellQuote(paths.log)}`,
  ].join("; ");
  return [
    ...(port === undefined ? [] : [portLine(port), `echo "$${HARNESS_PORT_ENV}"`]),
    `(umask 077 && mkdir -p ${paths.dirs.map(shellQuote).join(" ")})`,
    `rm -f ${shellQuote(paths.fifo)}`,
    `mkfifo -m 600 ${shellQuote(paths.fifo)}`,
    keepLog ? `: >> ${shellQuote(paths.log)}` : `: > ${shellQuote(paths.log)}`,
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

const METHOD_WORD = /^[A-Z]+$/;
const PATH_WORD = /^\/\S*$/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

/** The request's parts as the shell may see them: a method word, an
 *  in-range port, a path that starts at the root and carries no whitespace, a
 *  header name a shell and HTTP both read as one token. */
function checkRequest(req: HarnessRequest): void {
  if (!METHOD_WORD.test(req.method)) throw new HarnessContainerError("request", `not a method: ${req.method}`);
  if (!Number.isInteger(req.port) || req.port < 1 || req.port > 65535)
    throw new HarnessContainerError("request", `not a port: ${String(req.port)}`);
  if (!PATH_WORD.test(req.path)) throw new HarnessContainerError("request", `not a path: ${req.path}`);
  for (const name of [...Object.keys(req.headers ?? {}), ...Object.keys(req.secretHeaders ?? {})])
    if (!HEADER_NAME.test(name)) throw new HarnessContainerError("request", `not a header name: ${name}`);
}

/** How long one container command may take: the writes and reads are
 *  seconds; the start waits for the wrapper; the kill sleeps a second; a
 *  request to a server that answers late is bounded like the rest, on the
 *  bot host by the same figure. */
export const OP_TIMEOUT_MS = 60_000;
/** curl's own bound on a request, under the executor's: a slow server is then
 *  curl's named failure, and the executor's killed-command word stays the
 *  executor's — the caller can tell the two apart. */
export const CURL_MAX_TIME_S = 55;

/** The environment variable a secret header's value rides to curl under: `SWITCHBOARD_REQUEST_H<n>`, in the header's order. */
export const secretHeaderEnv = (n: number): string => `SWITCHBOARD_REQUEST_H${n}`;

/** The exec's env for a request: each secret header's value under its variable, so the command text carries the name alone. */
export function requestEnv(req: HarnessRequest): Record<string, string> {
  return Object.fromEntries(Object.values(req.secretHeaders ?? {}).map((value, i) => [secretHeaderEnv(i + 1), value]));
}

/** `curl` into the container's loopback: the answer with its status line and
 *  headers (`-i`), errors on stderr where the executor keeps them apart
 *  (`-sS`), its own bound under the executor's (`--max-time`), no
 *  `Expect: 100-continue` dance for a large body, a secret header's value
 *  read from the environment (`-H "name: $VAR"`, never the value in the text),
 *  the body from stdin (`printf` into `--data-binary @-`) or, past the inline
 *  size, from the file the caller wrote and the command removes. Never `-f`:
 *  a 4xx or 5xx is an answer to parse, not a failure. */
export function requestScript(req: HarnessRequest, bodyFile?: string): string {
  checkRequest(req);
  const headers = Object.entries(req.headers ?? {}).flatMap(([name, value]) => [
    "-H",
    shellQuote(`${name}: ${value.replace(/[\r\n]/g, " ")}`),
  ]);
  const secrets = Object.keys(req.secretHeaders ?? {}).flatMap((name, i) => [
    "-H",
    `"${name}: $${secretHeaderEnv(i + 1)}"`,
  ]);
  const curl = [
    "curl",
    "-sS",
    "-i",
    "--max-time",
    String(CURL_MAX_TIME_S),
    "-X",
    req.method,
    "-H",
    shellQuote("Expect:"),
    ...headers,
    ...secrets,
    ...(req.body === undefined ? [] : ["--data-binary", bodyFile ? shellQuote(`@${bodyFile}`) : "@-"]),
    shellQuote(`http://127.0.0.1:${req.port}${req.path}`),
  ].join(" ");
  if (req.body !== undefined && bodyFile === undefined) return `printf '%s' ${shellQuote(req.body)} | ${curl}`;
  if (bodyFile !== undefined) return `${curl}; s=$?; rm -f ${shellQuote(bodyFile)}; exit $s`;
  return curl;
}

/** The exec's answer to a request as the response: an HTTP answer is parsed as
 *  it is — the server's body is anyone's text, so the executors' runtime word
 *  is never looked for in it — and anything else goes through `stdoutOf`,
 *  where the runtime word is the typed container-gone failure, a failed curl
 *  (`exit N:`) is a named failure, and any other text is no HTTP answer. */
export function requestOutcome(out: string): HarnessResponse {
  const cut = out.indexOf(STDERR_MARK);
  const stdout = cut >= 0 ? out.slice(0, cut) : out;
  if (/^HTTP\//.test(stdout)) return parseHttpResponse(stdout);
  return parseHttpResponse(stdoutOf("request", out));
}

/** `curl -i`'s output as the answer: the status line, the headers (lowercased
 *  names; a repeated name keeps the last value) and the body after the blank
 *  line; an interim `1xx` block is skipped. Nothing that is not an HTTP answer
 *  is one: a named failure instead. */
export function parseHttpResponse(raw: string): HarnessResponse {
  let rest = raw;
  for (;;) {
    const statusLine = /^HTTP\/\S+ (\d{3})[^\r\n]*\r?\n/.exec(rest);
    if (!statusLine)
      throw new HarnessContainerError("request", `no HTTP answer came back (${raw.trim() ? raw : "empty"})`);
    const status = Number(statusLine[1]);
    const blank = /\r?\n\r?\n/.exec(rest);
    const headBlock = rest.slice(statusLine[0].length, blank ? blank.index : rest.length);
    const body = blank ? rest.slice(blank.index + blank[0].length) : "";
    if (status >= 100 && status < 200) {
      rest = body;
      continue;
    }
    const headers: Record<string, string> = {};
    for (const line of headBlock.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    return { status, headers, body };
  }
}

const STDERR_MARK = "\n--- stderr ---\n";

/** The executors' word for the runtime under a command being gone: the
 *  resident's `runtime-replaced` (an isolate swapped under the command,
 *  resident-repos item 43) and the sandbox's `runtime-unreachable` (a runtime
 *  nothing answered, execution item 9). The word counts wherever it sits: an
 *  executor puts its own words around it (`resident /exec: …`, `exit 127:` and
 *  a newline), and the seam's commands print a pid, a port, a boot id,
 *  `alive`/`dead`, base64, an HTTP answer or nothing — never the word — so a
 *  text carrying it is the executor's, not the command's. The harness reads it
 *  for a container replaced under the run (harness-pi item 16). */
export const RUNTIME_WORD = /\bruntime-(?:unreachable|replaced)\b/;

/** A container command answered with the executors' word for a replaced
 *  runtime in place of the command's output (`stdoutOf`): the command may
 *  never have run, and the harness reads the failure as the container replaced
 *  under the run (harness-pi item 16) — by this type, never by the words. */
export class HarnessContainerRuntimeReplacedError extends HarnessContainerError {
  constructor(operation: string, detail: string) {
    super(operation, detail);
    this.name = "HarnessContainerRuntimeReplacedError";
  }
}

/** Whether a container operation's failure says the container is gone under
 *  it: the executor's typed word (`ExecSandboxRestartedError`), or the seam's
 *  own for the word handed back as a command's text. What `identity` and
 *  `request` rethrow instead of answering. */
export function isContainerGone(err: unknown): boolean {
  return err instanceof ExecSandboxRestartedError || err instanceof HarnessContainerRuntimeReplacedError;
}

/** The stdout of an executor's answer: the executors' runtime word anywhere in
 *  it is the typed failure naming it, the `exit N:` prefix is a failure, the
 *  stderr the executors append is dropped, the empty marker is empty. */
export function stdoutOf(operation: string, out: string): string {
  if (RUNTIME_WORD.test(out)) throw new HarnessContainerRuntimeReplacedError(operation, out);
  if (parseExitPrefix(out).failed) throw new HarnessContainerError(operation, out);
  const cut = out.indexOf(STDERR_MARK);
  const stdout = cut >= 0 ? out.slice(0, cut) : out;
  return stdout === "(no output)" ? "" : stdout;
}

export class ExecHarnessContainer implements HarnessContainer {
  private commandNo = 0;

  constructor(private readonly executor: Executor) {}

  /** The root the harness proposes, directly under the sticky /tmp: no command
   *  runs here, the write and start scripts make it at 700 as the thread's user
   *  (harness-pi item 4). */
  async makeRoot(wanted: string): Promise<string> {
    return wanted;
  }

  /** The start script never changes directory, so the process runs where the
   *  executor runs every command: the thread's checkout, which the harness
   *  names (a resident's `/exec` runs in the thread's worktree). No command
   *  runs here. */
  cwd(_paths: HarnessPaths, checkout: string): string {
    return checkout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    for (const script of writeFileScripts(path, content)) stdoutOf("write", await this.exec(script));
  }

  async start(start: HarnessStart): Promise<HarnessStarted> {
    const out = stdoutOf("start", await this.exec(startScript(start), start.env)).trim();
    const lines = out.split("\n");
    const pid = Number(lines[lines.length - 1]);
    if (!Number.isInteger(pid) || pid <= 0)
      throw new HarnessContainerError("start", `no pid came back (${out || "empty"})`);
    if (start.port === undefined) return { pid };
    // The port is the first line and the pid the last: one line is a pid alone.
    const port = lines.length >= 2 ? Number(lines[0]) : NaN;
    if (!Number.isInteger(port) || port <= 0 || port > 65535)
      throw new HarnessContainerError("start", `no port came back (${out || "empty"})`);
    return { pid, port };
  }

  async writeLine(paths: HarnessPaths, line: string): Promise<void> {
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
   *  executor could not run is no identity — a judgement never rests on a
   *  guess — except the executor's typed word that the container is gone under
   *  the question, which is thrown as it is from every other operation. */
  async identity(): Promise<string | undefined> {
    try {
      const word = stdoutOf("identity", await this.exec(identityScript())).trim();
      return IDENTITY_WORD.test(word) ? word : undefined;
    } catch (err) {
      if (isContainerGone(err)) throw err;
      return undefined;
    }
  }

  /** `curl` over the executor: a body that fits an argument rides `printf`
   *  into curl's stdin; a longer one is written under the run's command
   *  directory first and removed by the request's own command; a secret
   *  header's value rides the exec's env channel. The answer is read as an
   *  HTTP answer first (`requestOutcome`), so the server's body is never
   *  mistaken for the executor's word. */
  async request(paths: HarnessPaths, req: HarnessRequest): Promise<HarnessResponse> {
    let bodyFile: string | undefined;
    if (req.body !== undefined && req.body.length > INLINE_LINE_CHARS) {
      bodyFile = `${paths.commandDir}/${++this.commandNo}.body`;
      await this.writeFile(bodyFile, req.body);
    }
    const env = requestEnv(req);
    return requestOutcome(await this.exec(requestScript(req, bodyFile), Object.keys(env).length > 0 ? env : undefined));
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

  async remove(paths: HarnessPaths): Promise<void> {
    stdoutOf("remove", await this.exec(removeScript(paths.dir)));
  }

  private exec(script: string, env?: Record<string, string>): Promise<string> {
    return this.executor.exec(script, { timeoutMs: OP_TIMEOUT_MS, ...(env ? { env } : {}) });
  }
}
