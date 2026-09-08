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
    if (innerRelease) this.release = (mode) => this.timed("exec.release", () => innerRelease(mode));
    const innerMoveTo = inner.moveTo?.bind(inner);
    if (innerMoveTo) this.moveTo = (sha) => this.timed("exec.move_to", () => innerMoveTo(sha));
  }

  private timed<T>(name: string, fn: () => Promise<T>, extra: { timeoutMs?: number } = {}): Promise<T> {
    return this.span.span(name, fn, {
      attrs: {
        ...(this.backend !== undefined ? { backend: this.backend } : {}),
        ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
      },
    });
  }

  exec(command: string, opts?: ExecOptions): Promise<string> {
    return this.timed("exec.exec", () => this.inner.exec(command, opts), { timeoutMs: opts?.timeoutMs });
  }

  readFile(path: string): Promise<string> {
    return this.timed("exec.read_file", () => this.inner.readFile(path));
  }

  writeFile(path: string, content: string): Promise<string> {
    return this.timed("exec.write_file", () => this.inner.writeFile(path, content));
  }
}
