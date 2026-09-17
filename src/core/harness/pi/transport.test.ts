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
    t.send({ type: "steer", message: "go" }); // any write but an abort, whose own failure is nobody's
    await t.flushed();
    await expect(collect(t, 1)).rejects.toThrow("worktree evicted");
  });

  it("a failed send records the command it carried as `pendingSend`, so a re-attach can resolve the write by pi's echo", async () => {
    const c = new FakeHarnessContainer();
    await c.start({ paths, command: "pi", args: [], env: {} });
    const { t } = transport(c);
    expect(t.pendingSend).toBeUndefined();
    c.failNext = { operation: "send", error: new Error("control-reset: the resident's Durable Object was reset") };
    t.send({ id: "p", type: "prompt", message: "go" });
    await t.flushed();
    expect(t.pendingSend).toEqual({ id: "p", type: "prompt", message: "go" });
    // The first failure's command is kept; a second failed send does not replace it.
    c.failNext = { operation: "send", error: new Error("another failure") };
    t.send({ type: "steer", message: "later" });
    await t.flushed();
    expect(t.pendingSend).toEqual({ id: "p", type: "prompt", message: "go" });
  });

  it("abandon() holds every write still queued behind the one in flight for the fresh transport, so none of the old transport's writes land out of turn after a re-attach (harness-pi item 16)", async () => {
    const c = new FakeHarnessContainer();
    await c.start({ paths, command: "pi", args: [], env: {} });
    // Hold the first write in flight (past the drop check, inside writeLine) so
    // a second queues behind it — the shape a re-attach's `abandon()` finds.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realWrite = c.writeLine.bind(c);
    let held = false;
    c.writeLine = async (p, line) => {
      if (!held) {
        held = true;
        await gate;
      }
      return realWrite(p, line);
    };
    const { t } = transport(c);
    t.send({ type: "prompt", message: "in flight" });
    t.send({ type: "steer", message: "queued behind it" });
    await new Promise((r) => setImmediate(r)); // let the first write reach the gate, past the hold check
    t.abandon(); // the re-attach's close: hold what is still queued for the fresh transport
    release();
    await t.flushed();
    // The in-flight write landed (already committed); the queued one never did —
    // it is held for the fresh transport, in order, not dropped.
    expect(c.stdin).toEqual(['{"type":"prompt","message":"in flight"}']);
    expect(t.takeUnsent()).toEqual([{ type: "steer", message: "queued behind it" }]);
  });

  it("close() still flushes a write queued just before it — a gate-bypass abort lands even as the transport closes", async () => {
    const c = new FakeHarnessContainer();
    await c.start({ paths, command: "pi", args: [], env: {} });
    const { t } = transport(c);
    t.send({ type: "abort" });
    t.close();
    await t.flushed();
    expect(c.stdin).toEqual(['{"type":"abort"}']);
  });

  it("a failed send stops the chain: a write queued behind the failure never lands on this transport, nor one sent after it — the loop re-sends from pendingSend and the inbox, in order, on the fresh transport (harness-pi item 16)", async () => {
    const c = new FakeHarnessContainer();
    await c.start({ paths, command: "pi", args: [], env: {} });
    const { t } = transport(c);
    c.failNext = { operation: "send", error: new Error("control-reset: the resident's Durable Object was reset") };
    t.send({ id: "p", type: "prompt", message: "go" });
    t.send({ type: "steer", message: "queued behind the failure" });
    await t.flushed();
    // The first write failed and is the pending one; the steer queued behind it
    // never landed here — landing it would put it ahead of the re-sent prompt.
    expect(t.pendingSend).toEqual({ id: "p", type: "prompt", message: "go" });
    expect(c.stdin).toEqual([]);
    // A send after the failure is held back too: this transport is spent.
    t.send({ type: "steer", message: "sent after the failure" });
    await t.flushed();
    expect(c.stdin).toEqual([]);
    // Neither is lost: the re-attach takes them, in order, for the fresh transport — once.
    expect(t.takeUnsent()).toEqual([
      { type: "steer", message: "queued behind the failure" },
      { type: "steer", message: "sent after the failure" },
    ]);
    expect(t.takeUnsent()).toEqual([]);
    // The one exception is an abort: its step ignores the spent chain, so it lands even here, and is never the re-attach's.
    t.send({ type: "abort" });
    await t.flushed();
    expect(c.stdin).toEqual(['{"type":"abort"}']);
    expect(t.takeUnsent()).toEqual([]);
  });

  it("the contracts after a failed send: flushed() resolves once every later write is held (not landed), and a plain close() delivers nothing more of the chain — the held writes are the re-attach's to take — while a teardown's abort still reaches pi, its step past the spent chain", async () => {
    const c = new FakeHarnessContainer();
    await c.start({ paths, command: "pi", args: [], env: {} });
    const { t } = transport(c);
    c.failNext = { operation: "send", error: new Error("control-reset: the resident's Durable Object was reset") };
    t.send({ id: "p", type: "prompt", message: "go" });
    await t.flushed(); // the failure recorded: the chain is spent
    t.send({ type: "steer", message: "behind the failure" }); // held
    t.send({ type: "abort" }); // a teardown's abort: direct, so it lands even now
    t.close();
    await t.flushed(); // settles: the steer held — never a hang
    expect(t.pendingSend).toEqual({ id: "p", type: "prompt", message: "go" });
    expect(c.stdin).toEqual(['{"type":"abort"}']);
    expect(t.takeUnsent()).toEqual([{ type: "steer", message: "behind the failure" }]);
  });

  it("an abort is one step on the chain that a spent chain does not stop — never queued for a re-attach to replay: at once when nothing is in flight, behind a write in flight or queued on a live chain (pi has the prompt first, the abort after), still written when the write before it failed with the reset, and skipped only on an abandoned transport", async () => {
    // A live chain with a prompt pending: the abort follows the prompt — never
    // an idle session aborted and then handed the prompt to run unwatched.
    const live = new FakeHarnessContainer();
    await live.start({ paths, command: "pi", args: [], env: {} });
    const { t: onLive } = transport(live);
    onLive.send({ id: "p", type: "prompt", message: "first" });
    onLive.send({ type: "abort" });
    await onLive.flushed();
    expect(live.stdin.map((l) => JSON.parse(l) as unknown)).toEqual([
      { id: "p", type: "prompt", message: "first" },
      { type: "abort" },
    ]);
    expect(onLive.takeUnsent()).toEqual([]);
    // The chain idle: the step runs at once, the one abort.
    onLive.send({ type: "abort" });
    await onLive.flushed();
    expect(live.stdin).toHaveLength(3);
    expect(live.stdin.slice(2).map((l) => JSON.parse(l) as unknown)).toEqual([{ type: "abort" }]);

    // A write in flight that fails only AFTER the abort was asked for: the
    // chain is spent by the time the abort's step runs, and the step writes
    // anyway — the reset must not swallow the stop — with nothing of it left
    // for `takeUnsent`.
    const late = new FakeHarnessContainer();
    await late.start({ paths, command: "pi", args: [], env: {} });
    let fail!: (err: Error) => void;
    const realWrite = late.writeLine.bind(late);
    late.writeLine = async (p, line) => {
      const cmd = JSON.parse(line) as Record<string, unknown>;
      if (cmd.type === "prompt") await new Promise<void>((_, reject) => (fail = reject));
      return realWrite(p, line);
    };
    const { t: onLate } = transport(late);
    onLate.send({ id: "p", type: "prompt", message: "go" });
    await new Promise((r) => setImmediate(r)); // the prompt is in flight
    onLate.send({ type: "abort" });
    expect(late.stdin).toEqual([]); // behind the in-flight write: not a second writer
    fail(new Error("control-reset: the resident's Durable Object was reset"));
    await onLate.flushed();
    expect(late.stdin.map((l) => JSON.parse(l) as unknown)).toEqual([{ type: "abort" }]);
    expect(onLate.pendingSend).toEqual({ id: "p", type: "prompt", message: "go" });
    expect(onLate.takeUnsent()).toEqual([]);
    // Even an abort handed to `send` never queues: it takes the same step.
    onLate.send({ type: "abort" });
    await onLate.flushed();
    expect(late.stdin.map((l) => JSON.parse(l) as unknown)).toEqual([{ type: "abort" }, { type: "abort" }]);
    expect(onLate.takeUnsent()).toEqual([]);

    // A spent chain: a plain send is held (the chain is spent); the abort's step runs at once.
    const spent = new FakeHarnessContainer();
    await spent.start({ paths, command: "pi", args: [], env: {} });
    const { t: onSpent } = transport(spent);
    spent.failNext = { operation: "send", error: new Error("resident /exec: Peer closed WebSocket: 1006") };
    onSpent.send({ id: "p", type: "prompt", message: "go" });
    await onSpent.flushed();
    expect(spent.stdin).toEqual([]);
    onSpent.send({ type: "steer", message: "held" });
    onSpent.send({ type: "abort" });
    await onSpent.flushed();
    expect(spent.stdin.map((l) => JSON.parse(l) as unknown)).toEqual([{ type: "abort" }]);
    // The re-attach takes the held steer and never an abort.
    expect(onSpent.takeUnsent()).toEqual([{ type: "steer", message: "held" }]);
    // A closed transport sends nothing: pi is being ended.
    onSpent.close();
    onSpent.send({ type: "abort" });
    await onSpent.flushed();
    expect(spent.stdin).toHaveLength(1);

    // An abandoned transport skips the step: the fresh transport is the one writer now.
    const left = new FakeHarnessContainer();
    await left.start({ paths, command: "pi", args: [], env: {} });
    const { t: onLeft } = transport(left);
    onLeft.send({ type: "abort" });
    onLeft.abandon();
    await onLeft.flushed();
    expect(left.stdin).toEqual([]);
  });

  it("no two writes to the FIFO are ever in flight at once: with a two-phase (slow) writeLine, a prompt, an abort asked for while it is in flight and a steer sent after land one after another — each begun only once the one before it ended — in the order pi must see them", async () => {
    const c = new FakeHarnessContainer();
    await c.start({ paths, command: "pi", args: [], env: {} });
    c.slowWrites = true;
    const { t } = transport(c);
    t.send({ id: "p", type: "prompt", message: "a prompt longer than PIPE_BUF would be" });
    await new Promise((r) => setImmediate(r)); // the prompt is mid-write
    expect(c.writeSpans).toEqual([{ phase: "begin", line: c.writeSpans[0]?.line ?? "" }]);
    t.send({ type: "abort" });
    t.send({ type: "steer", message: "after" });
    await t.flushed();
    // Never a second writer: every begin follows the previous end.
    let inFlight = 0;
    for (const span of c.writeSpans) {
      inFlight += span.phase === "begin" ? 1 : -1;
      expect(inFlight).toBeLessThanOrEqual(1);
      expect(inFlight).toBeGreaterThanOrEqual(0);
    }
    expect(c.writeSpans).toHaveLength(6);
    expect(c.commands().map((cmd) => cmd.type)).toEqual(["prompt", "abort", "steer"]);
  });

  it("write answers with the landing: `landed` once the line is on pi's FIFO, `failed` when its write rejected (the command kept as pendingSend; an abort's failed write kept as nothing), `held` when kept for takeUnsent on a spent chain, `dropped` when nothing kept it — a closed or abandoned transport, or an abort's step that found the transport abandoned by the time it ran (an answer no re-attach produces: it awaits the chain before it abandons) — what the gate's onLanded waits on", async () => {
    const c = new FakeHarnessContainer();
    await c.start({ paths, command: "pi", args: [], env: {} });
    const { t } = transport(c);
    await expect(t.write({ id: "s", type: "get_state" })).resolves.toBe("landed");
    c.failNext = { operation: "send", error: new Error("control-reset: the resident's Durable Object was reset") };
    await expect(t.write({ id: "p", type: "prompt", message: "go" })).resolves.toBe("failed");
    expect(t.pendingSend).toEqual({ id: "p", type: "prompt", message: "go" });
    await expect(t.write({ type: "steer", message: "behind the failure" })).resolves.toBe("held");
    expect(t.takeUnsent()).toEqual([{ type: "steer", message: "behind the failure" }]);
    const gone = new FakeHarnessContainer();
    await gone.start({ paths, command: "pi", args: [], env: {} });
    const { t: onGone } = transport(gone);
    onGone.abandon();
    await expect(onGone.write({ type: "steer", message: "late" })).resolves.toBe("dropped");
    expect(onGone.takeUnsent()).toEqual([]); // closed before it was sent: never queued, so never re-sent — `dropped`, not `held`
    await expect(onGone.write({ type: "abort" })).resolves.toBe("dropped");
    const shut = new FakeHarnessContainer();
    await shut.start({ paths, command: "pi", args: [], env: {} });
    const { t: onShut } = transport(shut);
    onShut.close();
    await expect(onShut.write({ type: "steer", message: "late" })).resolves.toBe("dropped");

    // An abort's step that finds the transport abandoned by the time it runs
    // (a write was in flight ahead of it when the re-attach took the chain).
    const left = new FakeHarnessContainer();
    await left.start({ paths, command: "pi", args: [], env: {} });
    let release!: () => void;
    const realWrite = left.writeLine.bind(left);
    left.writeLine = async (p, line) => {
      if ((JSON.parse(line) as { type: string }).type === "prompt") await new Promise<void>((r) => (release = r));
      return realWrite(p, line);
    };
    const { t: onLeft } = transport(left);
    onLeft.send({ id: "p", type: "prompt", message: "go" });
    await new Promise((r) => setImmediate(r)); // the prompt is in flight
    const abort = onLeft.write({ type: "abort" });
    onLeft.abandon();
    release();
    await expect(abort).resolves.toBe("dropped");
    expect(left.commands().map((c) => c.type)).toEqual(["prompt"]); // never written here: the fresh transport is the one writer

    // The `failed` leg: the abort's own write rejects. Nobody's — the transport
    // is being left, the process ended by `kill` — so nothing is recorded and
    // the chain is not spent: the next write still lands.
    const refusing = new FakeHarnessContainer();
    await refusing.start({ paths, command: "pi", args: [], env: {} });
    const { t: onRefusing } = transport(refusing);
    refusing.failNext = { operation: "send", error: new Error("resident /exec: Peer closed WebSocket: 1006") };
    await expect(onRefusing.write({ type: "abort" })).resolves.toBe("failed");
    expect(onRefusing.pendingSend).toBeUndefined();
    await expect(onRefusing.write({ type: "steer", message: "after" })).resolves.toBe("landed");
    expect(refusing.commands().map((c) => c.type)).toEqual(["steer"]);
  });

  it("caughtUp says whether every record read has been handed out and the last read was short — false before the first read, false while a chunk's earlier lines are still being consumed, true on its last line, false again while a full-size read means more follows", async () => {
    const c = new FakeHarnessContainer();
    await c.start({ paths, command: "pi", args: [], env: {} });
    const { t } = transport(c);
    expect(t.caughtUp).toBe(false);
    c.emit({ type: "agent_start" }, { type: "turn_start" }, { type: "turn_end" });
    const seen: boolean[] = [];
    for await (const _line of t.lines) {
      seen.push(t.caughtUp);
      if (seen.length === 3) t.close();
    }
    expect(seen).toEqual([false, false, true]); // one chunk of three: caught up only on the last

    // A read that fills the whole chunk: more follows at once, so not caught up
    // even on its last line; the short read after it is.
    const big = new FakeHarnessContainer();
    await big.start({ paths, command: "pi", args: [], env: {} });
    const { t: onBig } = transport(big);
    const filler = JSON.stringify({ type: "x", pad: "y".repeat(LOG_READ_BYTES / 2 - 32) });
    big.emitRaw(`${filler}\n${filler}\n`.slice(0, LOG_READ_BYTES)); // exactly one full chunk, its tail a partial line
    big.emitRaw(`${filler}\n`.slice(LOG_READ_BYTES - `${filler}\n`.length)); // the rest of that line
    const caught: boolean[] = [];
    for await (const _line of onBig.lines) {
      caught.push(onBig.caughtUp);
      if (caught.length === 2) onBig.close();
    }
    expect(caught[0]).toBe(false); // the first line of a full chunk
    expect(caught[1]).toBe(true); // the second, completed by the short read after
  });

  it("a gate reply rides the chain like every other write (only the abort is direct): on a spent chain it is held for the re-attach in its turn, and its own failed write is recorded for the re-attach to re-send as it was — where an abort's failed write is nobody's", async () => {
    const reply = { id: "d1", type: "extension_ui_response", response: { confirmed: true } };
    // A spent chain: the reply is held behind the steer, in order, for the
    // fresh transport — never written on a chain whose next write is a
    // re-send, never lost.
    const spent = new FakeHarnessContainer();
    await spent.start({ paths, command: "pi", args: [], env: {} });
    const { t: onSpent } = transport(spent);
    spent.failNext = { operation: "send", error: new Error("control-reset: the resident's Durable Object was reset") };
    onSpent.send({ id: "p", type: "prompt", message: "go" });
    await onSpent.flushed();
    onSpent.send({ type: "steer", message: "held" });
    onSpent.send(reply);
    await onSpent.flushed();
    expect(spent.stdin).toEqual([]);
    expect(onSpent.takeUnsent()).toEqual([{ type: "steer", message: "held" }, reply]);

    // A reply whose write fails: the failure is the stream's (the tool is
    // waiting on that answer) and the reply is `pendingSend`, for the re-attach
    // to re-send as it was (RESEND_AS_IS).
    const failing = new FakeHarnessContainer();
    await failing.start({ paths, command: "pi", args: [], env: {} });
    const { t: onFailing } = transport(failing);
    failing.failNext = {
      operation: "send",
      error: new Error("control-reset: the resident's Durable Object was reset"),
    };
    onFailing.send(reply);
    await onFailing.flushed();
    expect(onFailing.pendingSend).toEqual(reply);
    await expect(collect(onFailing, 1)).rejects.toThrow("control-reset");

    // An abort's failed write is nobody's: nothing recorded, the chain still live.
    const quiet = new FakeHarnessContainer();
    await quiet.start({ paths, command: "pi", args: [], env: {} });
    const { t: onQuiet } = transport(quiet);
    quiet.failNext = { operation: "send", error: new Error("resident /exec: Peer closed WebSocket: 1006") };
    onQuiet.send({ type: "abort" });
    await new Promise((r) => setImmediate(r));
    expect(onQuiet.pendingSend).toBeUndefined();
    onQuiet.send({ type: "steer", message: "after" });
    await onQuiet.flushed();
    expect(quiet.stdin).toEqual(['{"type":"steer","message":"after"}']);
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
