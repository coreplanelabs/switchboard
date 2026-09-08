// Feature: docs/reference/specs/tracing.md; docs/reference/specs/execution.md — every executor operation a tool asks for is an `exec.*` span.
import { describe, expect, it } from "vitest";
import { createTracer } from "../core/trace/tracer.js";
import { recordingSink } from "../core/testing/recordingSink.js";
import type { Executor } from "./executor.js";
import { ExecInfraError } from "./executor.js";
import { TracingExecutor } from "./tracingExecutor.js";

function traced() {
  let t = 1_000;
  const log = recordingSink();
  const root = createTracer({ clock: () => (t += 10) }).start("request", { sinks: [log] });
  const call = root.start("tool.bash");
  return { log, call };
}

describe("TracingExecutor", () => {
  it("times exec / readFile / writeFile as exec.* spans under the tool's span, carrying the backend and the per-call budget, never the command, path or output", async () => {
    const seen: string[] = [];
    const spansSeen: Array<string | undefined> = [];
    const inner: Executor = {
      exec: async (command, opts) => {
        seen.push(`exec ${command}`);
        spansSeen.push(opts?.span?.name);
        return "the output";
      },
      readFile: async (path, opts) => {
        seen.push(`read ${path}`);
        spansSeen.push(opts?.span?.name);
        return "contents";
      },
      writeFile: async (path, content, opts) => {
        seen.push(`write ${path} ${content}`);
        spansSeen.push(opts?.span?.name);
        return "Wrote";
      },
    };
    const { log, call } = traced();
    const ex = new TracingExecutor(inner, call, "resident");
    expect(await ex.exec("echo secret", { timeoutMs: 20_000 })).toBe("the output");
    expect(await ex.readFile("src/a.ts")).toBe("contents");
    expect(await ex.writeFile("src/b.ts", "body")).toBe("Wrote");
    expect(seen).toEqual(["exec echo secret", "read src/a.ts", "write src/b.ts body"]);
    // Each op's own exec.* span is handed down, so the inner executor's HTTP
    // calls become its http.client children (docs/reference/specs/tracing.md item 21).
    expect(spansSeen).toEqual(["exec.exec", "exec.read_file", "exec.write_file"]);
    expect(log.ends.map((e) => e.name)).toEqual(["exec.exec", "exec.read_file", "exec.write_file"]);
    for (const e of log.ends) {
      expect(e.parentSpanId).toBe(call.id);
      expect(e.status).toBe("ok");
      expect(e.attrs.backend).toBe("resident");
      expect(JSON.stringify(e)).not.toMatch(/secret|src\/a\.ts|src\/b\.ts|the output|contents|body/);
    }
    expect(log.ended("exec.exec")!.attrs).toEqual({ backend: "resident", timeoutMs: 20_000 });
    expect(log.ended("exec.read_file")!.attrs).toEqual({ backend: "resident" });
    expect(ex.release).toBeUndefined(); // the inner has none, so neither does the wrapper
    expect(ex.moveTo).toBeUndefined();
  });

  it("wraps release and moveTo only when the inner executor has them; a throw ends the span `error` and propagates", async () => {
    const inner: Executor = {
      exec: async () => {
        throw new ExecInfraError("resident /exec HTTP 503");
      },
      readFile: async () => "x",
      writeFile: async () => "x",
      release: async (mode) => ({ released: true, mode }) as never,
      moveTo: async (sha) => ({ sha }),
    };
    const { log, call } = traced();
    const ex = new TracingExecutor(inner, call);
    expect(await ex.moveTo!("abc123")).toEqual({ sha: "abc123" });
    await ex.release!("always");
    await expect(ex.exec("boom")).rejects.toBeInstanceOf(ExecInfraError);
    expect(log.ends.map((e) => [e.name, e.status])).toEqual([
      ["exec.move_to", "ok"],
      ["exec.release", "ok"],
      ["exec.exec", "error"],
    ]);
    expect(log.ended("exec.exec")!.attrs).toEqual({}); // no backend given, none recorded
  });
});
