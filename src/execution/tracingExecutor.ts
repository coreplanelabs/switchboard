import {
  emptyCredentialInspection,
  parseCredentialInspection,
  type CredentialInspection,
  type CredentialInspectionInput,
} from "./credentialInspection.js";
import type { Backend } from "../core/trace/attrs.js";
import type { Span } from "../core/trace/types.js";
import type {
  ExecOptions,
  ExecResult,
  Executor,
  MoveOptions,
  PublicationTransport,
  ReleaseMode,
  ReleaseResult,
} from "./executor.js";

// The executor as the run's spans see it (docs/reference/specs/tracing.md): every
// operation a tool asks of the workspace runs inside a log-only `exec.*` span
// under the tool call's own span — `exec.exec`, `exec.read_file`,
// `exec.write_file`, and `exec.release` / `exec.move_to` / `exec.read_bytes`
// when the wrapped executor has them — carrying the backend and the per-call budget, never the
// command, the path, or the output. A Decorator: the inner executor (the health
// tracker in the runner) does the work; this one only times it.

export class TracingExecutor implements Executor {
  inspectCredentials?: (input: CredentialInspectionInput) => Promise<CredentialInspection>;
  release?: (mode: ReleaseMode) => Promise<ReleaseResult>;
  moveTo?: (sha: string, opts?: MoveOptions) => Promise<{ sha: string }>;
  readBytes?: (path: string) => Promise<Uint8Array>;
  publishBranch?: (input: PublicationTransport) => Promise<string>;
  execResult?: (command: string, opts?: ExecOptions) => Promise<ExecResult>;
  publishBranchResult?: (input: PublicationTransport) => Promise<ExecResult>;

  constructor(
    private readonly inner: Executor,
    private readonly span: Span,
    private readonly backend?: Backend,
  ) {
    if (inner.inspectCredentials)
      this.inspectCredentials = async (input) => {
        try {
          return parseCredentialInspection(await inner.inspectCredentials!(input));
        } catch {
          return emptyCredentialInspection();
        }
      };
    const innerRelease = inner.release?.bind(inner);
    if (innerRelease) this.release = (mode) => this.timed("exec.release", (s) => innerRelease(mode, { span: s }));
    const innerMoveTo = inner.moveTo?.bind(inner);
    // The move's options ride through (the round's stop, `MoveOptions.signal`); only the span is this wrapper's.
    if (innerMoveTo)
      this.moveTo = (sha, opts) => this.timed("exec.move_to", (s) => innerMoveTo(sha, { ...opts, span: s }));
    const innerReadBytes = inner.readBytes?.bind(inner);
    if (innerReadBytes)
      this.readBytes = (path) => this.timed("exec.read_bytes", (s) => innerReadBytes(path, { span: s }));
    const innerPublishBranch = inner.publishBranch?.bind(inner);
    if (innerPublishBranch)
      this.publishBranch = (input) =>
        this.timed("exec.publish_branch", (s) => innerPublishBranch({ ...input, span: s }));
    const innerExecResult = inner.execResult?.bind(inner);
    if (innerExecResult)
      this.execResult = (command, opts) =>
        this.timed("exec.exec_result", (s) => innerExecResult(command, { ...opts, span: s }), {
          timeoutMs: opts?.timeoutMs,
        });
    const innerPublishBranchResult = inner.publishBranchResult?.bind(inner);
    if (innerPublishBranchResult)
      this.publishBranchResult = (input) =>
        this.timed("exec.publish_branch_result", (s) => innerPublishBranchResult({ ...input, span: s }));
  }

  /** Each op under its own `exec.*` span, handed to the inner executor as
   *  `opts.span` so its HTTP calls become `http.client` children (item 21). */
  private timed<T>(name: string, fn: (span: Span) => Promise<T>, extra: { timeoutMs?: number } = {}): Promise<T> {
    return this.span.span(name, (s) => fn(s), {
      attrs: {
        ...(this.backend !== undefined ? { backend: this.backend } : {}),
        ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
      },
    });
  }

  exec(command: string, opts?: ExecOptions): Promise<string> {
    return this.timed("exec.exec", (s) => this.inner.exec(command, { ...opts, span: s }), {
      timeoutMs: opts?.timeoutMs,
    });
  }

  readFile(path: string): Promise<string> {
    return this.timed("exec.read_file", (s) => this.inner.readFile(path, { span: s }));
  }

  writeFile(path: string, content: string): Promise<string> {
    return this.timed("exec.write_file", (s) => this.inner.writeFile(path, content, { span: s }));
  }
}
