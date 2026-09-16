import { describe, expect, it } from "vitest";
import { LOG_READ_BYTES } from "../container.js";
import { piRunPaths } from "./process.js";
import { FakeHarnessContainer } from "../testing/fakeContainer.js";
import { PiRpcTransport } from "./transport.js";

// Feature: docs/reference/specs/harness-pi.md item 4 — the RPC transport over
// the container: commands land in the FIFO in order, the log is polled from
// the last byte read and split into whole records however the bytes fall, the
// stream ends when pi is found dead with nothing more to read, and a write
// that fails ends the stream with its error.

const paths = piRunPaths("run-7");

/** The sleep yields a macrotask, so a test's own writes get their turn between polls. */
function transport(container: FakeHarnessContainer, extra: { alivePolls?: number; offset?: number } = {}) {
  const sleeps: number[] = [];
  const t = new PiRpcTransport({
    container,
    paths,
    pid: container.pid,
    pollMs: 250,
    sleep: (ms) => {
      if (sleeps.length < 100) sleeps.push(ms);
      return new Promise((r) => setImmediate(r));
    },
    ...extra,
  });
  return { t, sleeps };
}

async function collect(t: PiRpcTransport, max: number): Promise<string[]> {
  const out: string[] = [];
  for await (const line of t.lines) {
    out.push(line);
    if (out.length >= max) t.close();
  }
  return out;
}

describe("PiRpcTransport", () => {
  it("sends commands to the FIFO in order, one JSON line each", async () => {
    const c = new FakeHarnessContainer();
    await c.start({ paths, command: "pi", args: [], env: {} });
    const { t } = transport(c);
    t.send({ id: "s", type: "get_state" });
    t.send({ type: "prompt", message: "go" });
    await t.flushed();
    expect(c.stdin).toEqual(['{"id":"s","type":"get_state"}', '{"type":"prompt","message":"go"}']);
  });

  it("reads whole records however the log's bytes fall across reads, advancing its offset by exact bytes", async () => {
    const c = new FakeHarnessContainer();
    await c.start({ paths, command: "pi", args: [], env: {} });
    const { t } = transport(c);
    // A record longer than one read (a big tool result), split across polls; a
    // multibyte character on the boundary survives because bytes, not text, are buffered.
    const big = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "c",
      result: { content: [{ type: "text", text: "é".repeat(LOG_READ_BYTES) }] },
    });
    c.emit({ type: "agent_start" }, big, { type: "agent_settled" });
    const lines = await collect(t, 3);
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
      "agent_start",
      "tool_execution_end",
      "agent_settled",
    ]);
    expect(JSON.parse(lines[1])).toEqual(JSON.parse(big));
    expect(t.offset).toBe(Buffer.byteLength(`{"type":"agent_start"}\n${big}\n{"type":"agent_settled"}\n`));
  });

  it("sleeps between empty polls and continues from its offset when more arrives; a partial record waits", async () => {
    const c = new FakeHarnessContainer();
    await c.start({ paths, command: "pi", args: [], env: {} });
    const { t, sleeps } = transport(c);
    const out: string[] = [];
    const reading = (async () => {
      for await (const line of t.lines) {
        out.push(line);
        if (out.length === 2) t.close();
      }
    })();
    c.emit('{"type":"agent_start"}');
    // A record still being written: nothing is yielded until its newline lands.
    c.emitRaw('{"type":"turn_st');
    await new Promise((r) => setTimeout(r, 5));
    c.emitRaw('art"}\n');
    await reading;
    expect(out).toEqual(['{"type":"agent_start"}', '{"type":"turn_start"}']);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(new Set(sleeps)).toEqual(new Set([250]));
  });

  it("ends the stream when pi is found dead, after one last read of what it wrote on the way out", async () => {
    const c = new FakeHarnessContainer();
    await c.start({ paths, command: "pi", args: [], env: {} });
    const { t } = transport(c, { alivePolls: 2 });
    const out: string[] = [];
    const reading = (async () => {
      for await (const line of t.lines) out.push(line);
    })();
    c.emit({ type: "agent_start" });
    await new Promise((r) => setTimeout(r, 5));
    c.die();
    c.emit({ type: "extension_error", error: "boom" });
    await reading;
    expect(out.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(["agent_start", "extension_error"]);
    expect(t.exited).toBe(true);
  });

  // harness-pi item 16: the executor's word that the runtime under pi was
  // replaced arrives as a throw from the probe or the read; the stream ends
  // with that error for the harness to judge, never as pi found dead.
  it("a probe or a read that throws ends the stream with that error, and pi is not read as dead", async () => {
    const c = new FakeHarnessContainer();
    await c.start({ paths, command: "pi", args: [], env: {} });
    const { t } = transport(c, { alivePolls: 1 });
    c.alive = async () => {
      throw new Error("the sandbox restarted under the run");
    };
    await expect(collect(t, 1)).rejects.toThrow("the sandbox restarted under the run");
    expect(t.exited).toBe(false);
    const onRead = new FakeHarnessContainer();
    await onRead.start({ paths, command: "pi", args: [], env: {} });
    onRead.failNext = { operation: "read", error: new Error("runtime-replaced: the resident runtime was replaced") };
    const { t: t2 } = transport(onRead);
    await expect(collect(t2, 1)).rejects.toThrow("runtime-replaced");
    expect(t2.exited).toBe(false);
  });

  it("a write that fails surfaces as the stream's error on the next read", async () => {
    const c = new FakeHarnessContainer();
    await c.start({ paths, command: "pi", args: [], env: {} });
    const { t } = transport(c);
    c.failNext = { operation: "send", error: new Error("resident /exec: worktree evicted") };
    t.send({ type: "abort" });
    await t.flushed();
    await expect(collect(t, 1)).rejects.toThrow("worktree evicted");
  });

  it("a re-attach starts reading at the offset it was handed", async () => {
    const c = new FakeHarnessContainer();
    await c.start({ paths, command: "pi", args: [], env: {} });
    c.emit({ type: "agent_start" }, { type: "turn_start" });
    const skip = Buffer.byteLength('{"type":"agent_start"}\n');
    const { t } = transport(c, { offset: skip });
    expect(await collect(t, 1)).toEqual(['{"type":"turn_start"}']);
  });

  // The two positions the harness's re-attach fact needs kept apart (harness-pi
  // item 8): the read position moves by whole chunks, the consumed boundary by
  // the records a reader has actually been handed.
  it("the consumed offset is the boundary after the record last handed out while the read position sits at the end of the bytes read; a partial record is read but not consumed; both start at the offset handed in", async () => {
    const c = new FakeHarnessContainer();
    await c.start({ paths, command: "pi", args: [], env: {} });
    const first = '{"type":"agent_start"}';
    const second = '{"type":"turn_start"}';
    c.emit(first, second);
    c.emitRaw('{"type":"turn_en');
    const { t } = transport(c);
    expect(t.consumedOffset).toBe(0);
    const lines = t.lines[Symbol.asyncIterator]();
    expect((await lines.next()).value).toBe(first);
    // One read took every byte pi had written; only the first record is in the reader's hands.
    expect(t.offset).toBe(Buffer.byteLength(`${first}\n${second}\n{"type":"turn_en`));
    expect(t.consumedOffset).toBe(Buffer.byteLength(`${first}\n`));
    expect((await lines.next()).value).toBe(second);
    expect(t.consumedOffset).toBe(Buffer.byteLength(`${first}\n${second}\n`));
    expect(t.offset).toBe(Buffer.byteLength(`${first}\n${second}\n{"type":"turn_en`));
    t.close();
    const skip = Buffer.byteLength(`${first}\n`);
    const handed = transport(c, { offset: skip }).t;
    expect(handed.consumedOffset).toBe(skip);
    expect(handed.offset).toBe(skip);
  });
});
