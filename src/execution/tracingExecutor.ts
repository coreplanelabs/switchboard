import type { Backend } from "../core/trace/attrs.js";
import type { Span } from "../core/trace/types.js";
import type { ExecOptions, Executor, ReleaseMode, ReleaseResult } from "./executor.js";

// The executor as the run's spans see it (features/tracing.md): every
// operation a tool asks of the workspace runs inside a log-only `exec.*` span
// under the tool call's own span — `exec.exec`, `exec.read_file`,
// `exec.write_file`, and `exec.release` / `exec.move_to` when the wrapped
// executor has them — carrying the backend and the per-call budget, never the
// command, the path, or the output. A Decorator: the inner executor (the health
// tracker in the runner) does the work; this one only times it.

export class TracingExecutor implements Executor {
  release?: (mode: ReleaseMode) => Promise<ReleaseResult>;
  moveTo?: (sha: string) => Promise<{ sha: string }>;

  constructor(
    private readonly inner: Executor,
    private readonly span: Span,
    private readonly backend?: Backend,
  ) {
    const innerRelease = inner.release?.bind(inner);
    if (innerRelease) this.release = (mode) => this.timed("exec.release", (s) => innerRelease(mode, { span: s }));
    const innerMoveTo = inner.moveTo?.bind(inner);
    if (innerMoveTo) this.moveTo = (sha) => this.timed("exec.move_to", (s) => innerMoveTo(sha, { span: s }));
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
