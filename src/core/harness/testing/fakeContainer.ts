// The in-memory container the harness tests drive (an implementation of the
// `HarnessContainer` seam): files as a map, the process as a script of lines
// the test feeds into the log, stdin as the lines the harness wrote, a server
// as a handler the test scripts. What a real process would say is the test's
// to decide, line by line, so every path — a settled run, a stop, a death, a
// dialog — is one recorded stream.

import { ExecInfraError } from "../../../execution/executor.js";
import {
  checkPortArg,
  HarnessContainerDownError,
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

/** The resident client's failure as the incident recorded it: the exec transport failed with the WebSocket's 1006 close, no word. */
export const TRANSPORT_LOST_TEXT =
  "resident /exec: Peer closed WebSocket: 1006 WebSocket disconnected without sending Close frame.";
/** What the one more command meets while the platform rebuilds the container: the binding's not-running refusal, no word. */
export const CONTAINER_DOWN_TEXT = "resident /exec: The container is not running, consider calling start()";
/** The resident client's failure as the plan owner's live run met it at a rollout's onset: the SDK's connection-lost sentence forwarded by the resident, typed `transport-lost` by the client. */
export const NETWORK_LOST_TEXT = "resident /exec: Network connection lost.";

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
  /** The furthest byte any `readLog` has reached (`drained`). */
  private readEnd = 0;
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
  /** Set to fail the next `writeLine` whose command `type` matches, ONCE — a
   *  control reset (or any error) on a specific send, for the write-resolution
   *  paths (harness-pi item 16). */
  failSendType: { type: string; error: Error } | undefined;
  /** Set to make a log read fail once the log is drained — after the records
   *  already written were read — as the container replaced under the run does
   *  (harness-pi item 16): the poll for the next output reaches the replacement
   *  and fails with the executor's word, with the last turn's call in flight.
   *  A replaced container has no live pid, so `alive` answers `false` while this
   *  is armed (the ask-2 probe finds the process gone). */
  failOnceDrained: Error | undefined;
  /** Set to make the NEXT drained read fail ONCE with the executor's word and
   *  then recover — the pid stays alive throughout (ask 2): the executor
   *  said replaced, but the row's process still answers, so the harness
   *  re-attaches in place and the run goes on rather than judging it replaced. */
  failReadOnceThenAlive: Error | undefined;
  /** Set to make EVERY drained read fail with a control reset — the resident's
   *  Durable Object resetting over an unchanged container again and again with
   *  no new record between the re-attaches (harness-pi item 16): the loop
   *  re-attaches until the runaway bound closes the run by name. Persistent
   *  (unlike `failReadOnceThenAlive`), so it drives the bound; the pid is
   *  irrelevant, since a control reset never probes `alive`. */
  resetOnDrain: Error | undefined;
  /** Pids a previous generation's process left running that this generation
   *  finds alive besides the one this container started — a row's OpenCode or
   *  pi still up in this container on a resume, for `alive`/`find`. */
  readonly alivePids = new Set<number>();
  /** Set to make every `writeLine` span a macrotask between its beginning and
   *  its landing, both recorded on `writeSpans` — the pipe's truth that a line
   *  is a separate exec and, over PIPE_BUF, several `write(2)`s, so a test can
   *  assert that no two writes to the FIFO are ever in flight at once
   *  (harness-pi item 16). Off, a write lands whole and at once. */
  slowWrites = false;
  /** Every slow write's beginning and landing, in order. */
  readonly writeSpans: Array<{ phase: "begin" | "end"; line: string }> = [];
  /** Runs after each stdin line the harness writes — a scripted process answering. */
  onStdin: ((line: string, container: FakeHarnessContainer) => void) | undefined;
  /** Answers a request into the container — a scripted server; unset, no server listens. */
  onRequest:
    ((req: HarnessRequest, container: FakeHarnessContainer) => HarnessResponse | Promise<HarnessResponse>) | undefined;
  /** Runs when a pid is killed — a scripted server whose in-flight request the kill cuts. */
  onKill: ((pid: number) => void) | undefined;

  /** The process wrote these records to its stdout, one line each: the harness reads them on its next poll. */
  emit(...events: unknown[]): void {
    this.emitRaw(events.map((e) => (typeof e === "string" ? e : JSON.stringify(e)) + "\n").join(""));
  }

  /** Bytes as the process's stdout would carry them — a record still being written has no newline yet. */
  emitRaw(text: string): void {
    this.log = Buffer.concat([this.log, Buffer.from(text, "utf8")]);
  }

  /** Every byte the process has written so far has been read: the harness's
   *  poll is caught up with the log. A scripted play that moves the run's
   *  clock waits on this rather than on a count of ticks — the transport hands
   *  a record it read to the bridge before the loop's next tick can run its
   *  checks, so a clock moved after this wait falls on what the play last
   *  wrote (a step's start), never on the tool settled before it, whatever the
   *  poll timer and the tick timer make of a starved worker. */
  get drained(): boolean {
    return this.readEnd >= this.log.length;
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
    this.thenOnProbe(then, renamedWord);
  }

  /** The platform's replacement as the incident met it: the container is
   *  killed under the process's command, so the next read fails on its
   *  transport — the executor's infra failure carrying the WebSocket's 1006
   *  close, no word — and, for `downForProbes` answers, the one more command
   *  finds the container not running (the restore window) before it finds
   *  `then`: the word, the renamed container, or the container as it was. */
  loseTransport(
    then: "word" | "renamed" | "same",
    renamedWord: string,
    downForProbes = 0,
    /** How the read fails; by default the resident's answer as its client throws it — the SDK's 1006 words forwarded, typed `answered`. */
    failure: Error = new ExecInfraError(TRANSPORT_LOST_TEXT, "answered"),
  ): void {
    this.failOnceDrained = failure;
    this.downForProbes = downForProbes;
    this.thenOnProbe(then, renamedWord);
  }

  private thenOnProbe(then: "word" | "renamed" | "same", renamedWord: string): void {
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

  /** How many `identity` probes still find the container down (not running) before it answers. */
  downForProbes = 0;
  /** How many times `identity` was asked. */
  identityAsked = 0;

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
    if (this.failSendType !== undefined) {
      const parsed = JSON.parse(line) as { type?: unknown };
      if (parsed.type === this.failSendType.type) {
        const err = this.failSendType.error;
        this.failSendType = undefined;
        throw err;
      }
    }
    if (this.fifoPath !== undefined && paths.fifo !== this.fifoPath)
      throw new HarnessContainerError("send", `sh: 1: cannot create ${paths.fifo}: Directory nonexistent`);
    if (this.slowWrites) {
      this.writeSpans.push({ phase: "begin", line });
      await new Promise<void>((r) => setImmediate(r));
    }
    this.stdin.push(line);
    if (this.slowWrites) this.writeSpans.push({ phase: "end", line });
    this.onStdin?.(line, this);
  }

  async readLog(path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    this.maybeFail("read");
    if (this.logPath !== undefined && path !== this.logPath)
      throw new HarnessContainerError("read", `tail: cannot open '${path}' for reading: No such file or directory`);
    const chunk = this.log.subarray(offset, Math.min(this.log.length, offset + maxBytes));
    this.readEnd = Math.max(this.readEnd, offset + chunk.length);
    // The resident's control plane keeps resetting over the unchanged container:
    // every drained read fails with a control reset, so the loop re-attaches
    // with no progress until the runaway bound closes the run by name.
    if (this.resetOnDrain !== undefined && chunk.length === 0) throw this.resetOnDrain;
    // The container was replaced under the run: the records already written are
    // read (the last turn's call among them), then the poll for the next output
    // reaches the replacement and fails with the executor's word.
    if (this.failOnceDrained !== undefined && chunk.length === 0) throw this.failOnceDrained;
    // The executor said replaced once, but the pid stays alive (ask 2):
    // one drained read fails with the word, then the harness re-attaches and the
    // reads recover, delivering the records the run went on to write.
    if (this.failReadOnceThenAlive !== undefined && chunk.length === 0) {
      const err = this.failReadOnceThenAlive;
      this.failReadOnceThenAlive = undefined;
      throw err;
    }
    return new Uint8Array(chunk);
  }

  async alive(pid: number): Promise<boolean> {
    // A container replaced under the run (`failOnceDrained` armed) has no
    // process at the row's pid: the ask-2 probe on the executor's word finds it
    // gone, so the verdict stands (harness-pi item 16). An alive pid is
    // only for a container still standing.
    if (this.failOnceDrained !== undefined) return false;
    return (this.live && pid === this.pid) || this.alivePids.has(pid);
  }

  /** The container's word — or, armed with `failNext` for `identity`, the
   *  failure the executor would report: the runtime-replaced word on the one
   *  more command a process found dead without it takes. */
  async identity(): Promise<string | undefined> {
    this.identityAsked++;
    if (this.downForProbes > 0) {
      this.downForProbes--;
      this.onDownProbe?.();
      throw new HarnessContainerDownError("identity", CONTAINER_DOWN_TEXT);
    }
    this.maybeFail("identity");
    return this.vm;
  }

  /** Runs each time `identity` finds the container down — a test's operator stopping the run while it waits. */
  onDownProbe: (() => void) | undefined;

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
    this.onKill?.(pid);
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
