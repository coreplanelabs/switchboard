// The in-memory container the harness tests drive (an implementation of the
// `HarnessContainer` seam): files as a map, the process as a script of lines
// the test feeds into the log, stdin as the lines the harness wrote, a server
// as a handler the test scripts. What a real process would say is the test's
// to decide, line by line, so every path — a settled run, a stop, a death, a
// dialog — is one recorded stream.

import {
  checkPortArg,
  HarnessContainerError,
  HarnessContainerRuntimeReplacedError,
  PORT_ARG,
  type HarnessContainer,
  type HarnessPaths,
  type HarnessRequest,
  type HarnessResponse,
  type HarnessStart,
  type HarnessStarted,
} from "../container.js";

export class FakeHarnessContainer implements HarnessContainer {
  readonly files = new Map<string, string>();
  readonly stdin: string[] = [];
  readonly starts: HarnessStart[] = [];
  readonly killed: number[] = [];
  /** The run directories the harness removed; `files` keeps its record of what was written. */
  readonly removed: string[] = [];
  /** Every request the harness made into the container, in order. */
  readonly requests: HarnessRequest[] = [];
  private log = Buffer.alloc(0);
  private live = false;
  /** Where the started process's log and FIFO are. A read or a write at
   *  another path fails as the real container's would (`tail` or `printf` on
   *  a file that is not there): a harness that looks for its process under a
   *  root other than the one it was started under finds nothing. Unset until
   *  a start, so a transport driven without one reads wherever it is told. */
  private logPath: string | undefined;
  private fifoPath: string | undefined;
  /** The pid every start answers; changed by a test that wants two processes told apart. */
  pid = 4242;
  /** The port a start that asks for a free one is given. */
  freePort = 41000;
  /** The identity every `identity()` answers; a test hands another container's
   *  word to a row's facts to make the process elsewhere, or none to make it unknowable. */
  vm: string | undefined = "vm-fake";
  /** Set to make the next operation fail as the executor would report it. */
  failNext: { operation: string; error: Error } | undefined;
  /** Set to make a log read fail once the log is drained — after the records
   *  already written were read — as the container replaced under the run does
   *  (harness-pi item 16): the poll for the next output reaches the replacement
   *  and fails with the executor's word, with the last turn's call in flight. */
  failOnceDrained: Error | undefined;
  /** Pids a previous generation's process left running that this generation
   *  finds alive besides the one this container started — a row's OpenCode or
   *  pi still up in this container on a resume, for `alive`/`find`. */
  readonly alivePids = new Set<number>();
  /** Runs after each stdin line the harness writes — a scripted process answering. */
  onStdin: ((line: string, container: FakeHarnessContainer) => void) | undefined;
  /** Answers a request into the container — a scripted server; unset, no server listens. */
  onRequest: ((req: HarnessRequest, container: FakeHarnessContainer) => HarnessResponse) | undefined;

  /** The process wrote these records to its stdout, one line each: the harness reads them on its next poll. */
  emit(...events: unknown[]): void {
    this.emitRaw(events.map((e) => (typeof e === "string" ? e : JSON.stringify(e)) + "\n").join(""));
  }

  /** Bytes as the process's stdout would carry them — a record still being written has no newline yet. */
  emitRaw(text: string): void {
    this.log = Buffer.concat([this.log, Buffer.from(text, "utf8")]);
  }

  /** The process exited: the log is what it is, `alive` answers no from here. */
  die(): void {
    this.live = false;
  }

  /** The platform's rollout as the fake plays it: the process is dead (`alive`
   *  answers no) and no command has failed with the executor's word — the
   *  container's processes were killed first while exec still answered. What
   *  the harness's one more command, `identity`, then finds is `then`: the
   *  executor's runtime-replaced word thrown, the container renamed to
   *  `renamedWord`, or the container as it was. */
  dieWithoutWord(then: "word" | "renamed" | "same", renamedWord: string): void {
    this.die();
    if (then === "word")
      this.failNext = {
        operation: "identity",
        error: new HarnessContainerRuntimeReplacedError(
          "identity",
          "runtime-replaced: the resident runtime was replaced (a deploy) while this command was starting; its output is lost",
        ),
      };
    else if (then === "renamed") this.vm = renamedWord;
  }

  private maybeFail(operation: string): void {
    const f = this.failNext;
    if (f && f.operation === operation) {
      this.failNext = undefined;
      throw f.error;
    }
  }

  /** The root the harness proposed, as the exec container answers; a test that wants a run filed elsewhere overrides this. */
  async makeRoot(wanted: string): Promise<string> {
    return wanted;
  }

  /** The checkout, as the exec container answers; a test whose process runs in the root itself (the bot host's shape) overrides this. */
  cwd(_paths: HarnessPaths, checkout: string): string {
    return checkout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.maybeFail("write");
    this.files.set(path, content);
  }

  async start(start: HarnessStart): Promise<HarnessStarted> {
    this.maybeFail("start");
    checkPortArg(start);
    this.starts.push(start);
    this.live = true;
    this.logPath = start.paths.log;
    this.fifoPath = start.paths.fifo;
    if (start.port === undefined) return { pid: this.pid };
    const port = start.port === "free" ? this.freePort : start.port;
    // As the real containers do: the port in `PORT_ARG`'s place, so a test reads what the process was told.
    this.starts[this.starts.length - 1] = {
      ...start,
      args: start.args.map((a) => (a === PORT_ARG ? String(port) : a)),
    };
    return { pid: this.pid, port };
  }

  async writeLine(paths: HarnessPaths, line: string): Promise<void> {
    this.maybeFail("send");
    if (this.fifoPath !== undefined && paths.fifo !== this.fifoPath)
      throw new HarnessContainerError("send", `sh: 1: cannot create ${paths.fifo}: Directory nonexistent`);
    this.stdin.push(line);
    this.onStdin?.(line, this);
  }

  async readLog(path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    this.maybeFail("read");
    if (this.logPath !== undefined && path !== this.logPath)
      throw new HarnessContainerError("read", `tail: cannot open '${path}' for reading: No such file or directory`);
    const chunk = this.log.subarray(offset, Math.min(this.log.length, offset + maxBytes));
    // The container was replaced under the run: the records already written are
    // read (the last turn's call among them), then the poll for the next output
    // reaches the replacement and fails with the executor's word.
    if (this.failOnceDrained !== undefined && chunk.length === 0) throw this.failOnceDrained;
    return new Uint8Array(chunk);
  }

  async alive(pid: number): Promise<boolean> {
    return (this.live && pid === this.pid) || this.alivePids.has(pid);
  }

  /** The container's word — or, armed with `failNext` for `identity`, the
   *  failure the executor would report: the runtime-replaced word on the one
   *  more command a process found dead without it takes. */
  async identity(): Promise<string | undefined> {
    this.maybeFail("identity");
    return this.vm;
  }

  async request(_paths: HarnessPaths, req: HarnessRequest): Promise<HarnessResponse> {
    this.maybeFail("request");
    this.requests.push(req);
    if (!this.onRequest)
      throw new HarnessContainerError("request", `curl: (7) Failed to connect to 127.0.0.1 port ${req.port}`);
    return this.onRequest(req, this);
  }

  async kill(pid: number): Promise<void> {
    this.killed.push(pid);
    this.live = false;
  }

  async remove(paths: HarnessPaths): Promise<void> {
    this.maybeFail("remove");
    this.removed.push(paths.dir);
  }

  async tail(path: string, bytes: number): Promise<string> {
    const text = this.files.get(path) ?? "";
    return text.slice(-bytes);
  }

  /** The RPC commands the harness sent, parsed. */
  commands(): Array<Record<string, unknown>> {
    return this.stdin.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}
