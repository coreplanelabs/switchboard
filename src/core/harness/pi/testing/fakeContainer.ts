// The in-memory container the harness tests drive (the second implementation
// of the `PiContainer` seam): files as a map, pi as a script of lines the test
// feeds into the log, stdin as the lines the harness wrote. What a real pi
// would say is the test's to decide, line by line, so every path — a settled
// run, a stop, a death, a dialog — is one recorded stream.

import type { PiContainer, PiStart } from "../container.js";
import type { PiRunPaths } from "../process.js";

export class FakePiContainer implements PiContainer {
  readonly files = new Map<string, string>();
  readonly stdin: string[] = [];
  readonly starts: PiStart[] = [];
  readonly killed: number[] = [];
  private log = Buffer.alloc(0);
  private live = false;
  /** The pid every start answers; changed by a test that wants two processes told apart. */
  pid = 4242;
  /** Set to make the next operation fail as the executor would report it. */
  failNext: { operation: string; error: Error } | undefined;
  /** Runs after each stdin line the harness writes — a scripted pi answering. */
  onStdin: ((line: string, container: FakePiContainer) => void) | undefined;

  /** pi wrote these records to its stdout, one line each: the harness reads them on its next poll. */
  emit(...events: unknown[]): void {
    this.emitRaw(events.map((e) => (typeof e === "string" ? e : JSON.stringify(e)) + "\n").join(""));
  }

  /** Bytes as pi's stdout would carry them — a record still being written has no newline yet. */
  emitRaw(text: string): void {
    this.log = Buffer.concat([this.log, Buffer.from(text, "utf8")]);
  }

  /** pi exited: the log is what it is, `alive` answers no from here. */
  die(): void {
    this.live = false;
  }

  private maybeFail(operation: string): void {
    const f = this.failNext;
    if (f && f.operation === operation) {
      this.failNext = undefined;
      throw f.error;
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.maybeFail("write");
    this.files.set(path, content);
  }

  async start(start: PiStart): Promise<{ pid: number }> {
    this.maybeFail("start");
    this.starts.push(start);
    this.live = true;
    return { pid: this.pid };
  }

  async writeLine(_paths: PiRunPaths, line: string): Promise<void> {
    this.maybeFail("send");
    this.stdin.push(line);
    this.onStdin?.(line, this);
  }

  async readLog(_path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    this.maybeFail("read");
    return new Uint8Array(this.log.subarray(offset, Math.min(this.log.length, offset + maxBytes)));
  }

  async alive(pid: number): Promise<boolean> {
    return this.live && pid === this.pid;
  }

  async kill(pid: number): Promise<void> {
    this.killed.push(pid);
    this.live = false;
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
