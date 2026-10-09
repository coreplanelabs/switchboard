import { describe, expect, it, vi } from "vitest";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import type { Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { PiBridge } from "../core/harness/pi/bridge.js";
import { ResponsesFailureBoundary } from "./modelProxyResponses.js";

// Feature: docs/reference/specs/harness-pi.md item 6 — the real pi adapter
// preserves signed structural diagnostics without copying provider payloads.
describe("Responses unknown terminal diagnostics", () => {
  it("carries structural reasons through the real pi adapter without provider prose or replay", async () => {
    const model: Model<"openai-responses"> = {
      id: "test",
      name: "test",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://proxy.test/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 1000,
    };
    for (const [data, reason] of [
      ["private invalid JSON", "malformed_json"],
      [
        'private invalid JSON\n\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"private later transient"}}}',
        "malformed_json",
      ],
      ["null", "unverified_terminal"],
      [
        JSON.stringify({
          type: "response.failed",
          response: { status: "failed", error: { code: "unknown", message: "private provider response" } },
        }),
        "unverified_terminal",
      ],
    ] as const) {
      const boundary = new ResponsesFailureBoundary({ model: "test" });
      let calls = 0;
      const message = await stream(model, normalizeContext({ messages: [] }), {
        apiKey: "test",
        maxRetries: 0,
        fetch: (async () => {
          calls++;
          const body = new Response(`data: ${data}\n\n`).body!.pipeThrough(boundary.transform());
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch,
      }).result();
      const bridge = new PiBridge({ emit: () => {}, clock: () => 0 });
      const result = bridge.observe({ type: "message_end", message });
      expect(result.terminalFailure).toMatchObject({
        kind: "unknown",
        diagnostic: { source: "proxy", reason, errorMessage: "present", contentParts: 0 },
      });
      expect(result.providerFailure).toBeUndefined();
      expect(result.message).toBeUndefined();
      expect(message.errorMessage).not.toContain("private");
      expect(boundary.failure).toBeUndefined();
      expect(calls).toBe(1);
    }
  });
});

import { Worker } from "node:worker_threads";
import { ResponsesValidationCapacity } from "./responsesValidationCapacity.js";
import { ResponsesConsumer } from "./responsesConsumer.js";
import { proxyUnknownTerminalIsAuthenticated } from "../core/modelProxy/providerFailureAuth.js";

const sseFrame = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const fixtureProtocolUrl = new URL("./testing/responsesFixtureProtocol.ts", import.meta.url).href;

describe("Responses byte budgets", () => {
  it("retires small frame and output permits while the transport remains open", async () => {
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const reservation = await capacity.reserve();
    reservation.beginSource();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          source = controller;
        },
      },
      { highWaterMark: 0 },
    );
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      reservation,
      capacity: reservation.capacity,
      onSourceSettled: () => reservation.finishSource(),
    });
    const reader = boundary.pipe(input).getReader();
    const frame = new TextEncoder().encode(":keepalive\n\n");
    try {
      for (let at = 0; at < 2000; at++) {
        source.enqueue(frame);
        const next = await reader.read();
        expect(next.value).toEqual(frame);
        boundary.releaseOutput(next.value!);
        // The emergency output and reusable unfinished-frame permit remain;
        // delivered frame/output history does not remain in the live set.
        expect(reservation.liveStoragePermits).toBeLessThanOrEqual(2);
        expect(capacity.storageBytes).toBe(4096);
      }
      expect(capacity.activeCount).toBe(1);
      expect(input.locked).toBe(true);
    } finally {
      await reader.cancel();
      await boundary.dispose();
      reservation.finishTransport();
    }
    await expect.poll(() => capacity.storageBytes).toBe(0);
    expect(reservation.liveStoragePermits).toBe(0);
    expect(capacity.activeCount).toBe(0);
  });

  it("delivers its reserved authenticated ending when the global storage policy is full", async () => {
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const reservation = await capacity.reserve();
    reservation.beginSource();
    const pressure = reservation.reserveStorage(512 * 1024 * 1024 - capacity.storageBytes, "pressure");
    const kinds: string[] = [];
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      reservation,
      capacity: reservation.capacity,
      onSourceSettled: () => reservation.finishSource(),
      onValidationInterruption: (kind) => kinds.push(kind),
    });
    try {
      const text = await new Response(boundary.pipe(new Response(":keepalive\n\n").body!)).text();
      expect(text).toContain("consumer_rejected");
      expect(text).toContain("model_terminal_unknown");
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
      expect(kinds).toEqual(["storage"]);
      expect(boundary.failure).toBeUndefined();
      expect(capacity.storageBytes).toBe(512 * 1024 * 1024);
    } finally {
      await boundary.dispose();
      pressure.release();
      reservation.finishTransport();
    }
    await expect.poll(() => capacity.storageBytes).toBe(0);
  });

  it("refuses a maximal finite frame before wire or usage acceptance and holds its prepared graph through exit", async () => {
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const reservation = await capacity.reserve();
    reservation.beginSource();
    const event = {
      type: "response.completed",
      response: { status: "completed", output: Array(262128).fill("x"), padding: "" },
    };
    const base = sseFrame(event);
    event.response.padding = "x".repeat(16 * 1024 * 1024 - base.byteLength);
    const bytes = sseFrame(event);
    expect(bytes.byteLength).toBe(16 * 1024 * 1024);
    const raw = reservation.reserveStorage(bytes.buffer.byteLength, "response-raw-backing");
    const pressure = reservation.reserveStorage(120 * 1024 * 1024, "other-owner-pressure");
    let prepared = false,
      storageAtExit = 0;
    const consumer = new ResponsesConsumer("test", {
      reservation,
      capacity: reservation.capacity,
      createWorker: (url, options) => {
        const worker = new Worker(url, options);
        worker.on("message", (reply) => {
          if (reply.phase === "prepared") prepared = true;
        });
        worker.once("exit", () => {
          storageAtExit = capacity.storageBytes;
        });
        return worker;
      },
    });
    const seen: unknown[] = [];
    const kinds: string[] = [];
    const boundary = new ResponsesFailureBoundary({ model: "test" }, (value) => seen.push(value), {
      consumer,
      reservation,
      capacity: reservation.capacity,
      onSourceSettled: () => reservation.finishSource(),
      onValidationInterruption: (kind) => kinds.push(kind),
    });
    const source = new Response(bytes).body!;
    try {
      const text = await new Response(boundary.pipe(source)).text();
      expect(text).toContain("consumer_rejected");
      expect(prepared).toBe(true);
      expect(kinds).toEqual(["storage"]);
      expect(seen).toEqual([]);
      expect(boundary.failure).toBeUndefined();
      expect(storageAtExit).toBeGreaterThan(pressure.bytes + raw.bytes + 4096);
      expect(capacity.storageBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
    } finally {
      await boundary.dispose();
      await expect.poll(() => source.locked).toBe(false);
      raw.release();
      pressure.release();
      reservation.finishTransport();
    }
    await expect.poll(() => capacity.storageBytes).toBe(0);
  });

  it("refuses complete-frame output admission before parsing or accepting a fatal under initial pressure", async () => {
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const reservation = await capacity.reserve();
    reservation.beginSource();
    const pressure = reservation.reserveStorage(416 * 1024 * 1024, "prior-owner-pressure");
    const consumer = new ResponsesConsumer("test", { reservation, capacity: reservation.capacity });
    const parse = vi.spyOn(consumer, "parseJSON");
    const seen: unknown[] = [];
    const boundary = new ResponsesFailureBoundary({ model: "test" }, (event) => seen.push(event), {
      consumer,
      reservation,
      capacity: reservation.capacity,
      onSourceSettled: () => reservation.finishSource(),
    });
    const event = {
      type: "response.failed",
      response: {
        status: "failed",
        error: { code: "server_error", message: "private" },
        usage: { preserved: "x".repeat(8192) },
      },
    };
    try {
      const text = await new Response(boundary.pipe(new Response(sseFrame(event)).body!)).text();
      expect(text).toContain("consumer_rejected");
      expect(text).not.toContain("provider_failure");
      expect(parse).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
      expect(boundary.failure).toBeUndefined();
    } finally {
      await boundary.dispose();
      pressure.release();
      reservation.finishTransport();
      parse.mockRestore();
    }
    await expect.poll(() => capacity.storageBytes).toBe(0);
  });

  it("preserves the full first fatal when another owner fills storage after frame parsing", async () => {
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const reservation = await capacity.reserve();
    reservation.beginSource();
    const consumer = new ResponsesConsumer("test", { reservation, capacity: reservation.capacity });
    const parse = consumer.parseJSON.bind(consumer);
    consumer.parseJSON = async (data, target) => {
      const result = await parse(data, target);
      reservation.reserveStorage(512 * 1024 * 1024 - capacity.storageBytes, "other-owner-pressure");
      return result;
    };
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      consumer,
      reservation,
      capacity: reservation.capacity,
      onSourceSettled: () => reservation.finishSource(),
    });
    const event = {
      type: "response.failed",
      response: {
        status: "failed",
        error: { code: "server_error", message: "private" },
        usage: { preserved: "x".repeat(8192) },
      },
    };
    try {
      const text = await new Response(boundary.pipe(new Response(sseFrame(event)).body!)).text();
      expect(text).toContain("provider_failure");
      expect(JSON.parse(text.slice(6)).response.usage).toEqual(event.response.usage);
      expect(boundary.failure?.cause).toBe("transient");
      expect(boundary.terminal).toBe("failed");
    } finally {
      await boundary.dispose();
      reservation.finishTransport();
    }
    await expect.poll(() => capacity.storageBytes).toBe(0);
  });

  it.each([false, true])(
    "preserves a first fatal whose retained usage exceeds the emergency ending permit with later pressure=%s",
    async (laterPressure) => {
      const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
      const reservation = await capacity.reserve();
      reservation.beginSource();
      const usage = { input_tokens: 1, output_tokens: 1, preserved: "x".repeat(8192) };
      const event = {
        type: "response.failed",
        response: { status: "failed", error: { code: "server_error", message: "private" }, usage },
      };
      const boundary = new ResponsesFailureBoundary(
        { model: "test" },
        () => {
          if (laterPressure)
            reservation.reserveStorage(512 * 1024 * 1024 - capacity.storageBytes, "later-owner-pressure");
        },
        {
          reservation,
          capacity: reservation.capacity,
          onSourceSettled: () => reservation.finishSource(),
        },
      );
      try {
        const text = await new Response(boundary.pipe(new Response(sseFrame(event)).body!)).text();
        expect(text).toContain("provider_failure");
        expect(JSON.parse(text.slice(6)).response.usage).toEqual(usage);
      } finally {
        await boundary.dispose();
        reservation.finishTransport();
      }
      await expect.poll(() => capacity.storageBytes).toBe(0);
    },
  );

  it.each([-1, 0, 1])("bounds pending normalized UTF8 output at32MiB%s before encoder allocation", async (over) => {
    const target = 32 * 1024 * 1024 + over,
      invalid = Math.floor(target / 3),
      ascii = target - invalid * 3;
    const bytes = new Uint8Array(invalid + ascii).fill(255);
    bytes.fill(120, invalid);
    const kinds: string[] = [];
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      onValidationInterruption: (kind) => kinds.push(kind),
    });
    const result = Buffer.from(await new Response(boundary.pipe(new Response(bytes).body!)).arrayBuffer());
    expect(kinds).toEqual(over > 0 ? ["output-bytes"] : []);
    if (over <= 0) {
      expect(result.length).toBe(target);
      expect(result.subarray(0, 3).equals(Buffer.from([239, 191, 189]))).toBe(true);
    } else {
      expect(result.toString()).toContain("consumer_rejected");
      expect(result.length).toBeLessThan(2048);
    }
  });

  it.each([-1, 0, 1])("counts retained UTF8 bytes at16MiB%s without UTF16 approximation", async (over) => {
    const kinds: string[] = [];
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      onValidationInterruption: (kind) => kinds.push(kind),
    });
    const bytes = new Uint8Array(16 * 1024 * 1024 + over).fill(120);
    const emoji = new TextEncoder().encode("🧭");
    bytes.set(emoji);
    const result = Buffer.from(await new Response(boundary.pipe(new Response(bytes).body!)).arrayBuffer());
    expect(kinds).toEqual(over > 0 ? ["frame-bytes"] : []);
    if (over <= 0) expect(result.equals(Buffer.from(bytes))).toBe(true);
    else expect(result.toString()).toContain("consumer_rejected");
  });

  it.each([-1, 0, 1])("counts every cumulative source byte at64MiB%s", async (over) => {
    const kinds: string[] = [];
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      onValidationInterruption: (kind) => kinds.push(kind),
    });
    const size = 8 * 1024 * 1024;
    const frame = new Uint8Array(size).fill(120);
    frame[0] = 58;
    frame[size - 2] = 10;
    frame[size - 1] = 10;
    let at = 0;
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at < 8) {
          const value = at === 7 && over < 0 ? frame.subarray(0, frame.length - 1) : frame;
          at++;
          controller.enqueue(value);
        } else if (at === 8 && over > 0) {
          at++;
          controller.enqueue(Uint8Array.of(58));
        } else controller.close();
      },
    });
    const reader = boundary.pipe(input).getReader();
    let bytes = 0,
      last = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (part.value.length < 2048) last = new TextDecoder().decode(part.value);
    }
    expect(kinds).toEqual(over > 0 ? ["stream-bytes"] : []);
    if (over <= 0) expect(bytes).toBe(64 * 1024 * 1024 + over);
    else expect(last).toContain("consumer_rejected");
  });

  it.each([1023, 1024, 1025])("checks%s SSEfields before field array allocation", async (fields) => {
    const kinds: string[] = [];
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      onValidationInterruption: (kind) => kinds.push(kind),
    });
    const text = ": x\n".repeat(fields) + "\n";
    const result = await new Response(boundary.pipe(new Response(text).body!)).text();
    expect(kinds).toEqual(fields > 1024 ? ["fields"] : []);
    if (fields <= 1024) expect(result).toBe(text);
  });

  it("counts split BOM/CRLF bytes and retains CR-only immediate dispatch", async () => {
    const text = "\uFEFF: x\r\n\uFEFF\r\n: y\r\r";
    const boundary = new ResponsesFailureBoundary({ model: "test" });
    const encoded = new TextEncoder().encode(text);
    let at = 0;
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at < encoded.length) controller.enqueue(encoded.subarray(at, ++at));
        else controller.close();
      },
    });
    expect(Buffer.from(await new Response(boundary.pipe(input)).arrayBuffer()).equals(Buffer.from(encoded))).toBe(true);
    expect((boundary as unknown as { responseBytes: number }).responseBytes).toBe(encoded.length);
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cr = new ResponsesFailureBoundary({ model: "test" });
    const reader = cr
      .pipe(
        new ReadableStream({
          start(controller) {
            source = controller;
          },
        }),
      )
      .getReader();
    source.enqueue(new TextEncoder().encode(": immediate\r\r"));
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(": immediate\r\r");
    await reader.cancel();
  });

  it("rejects normalized encoded output over32MiB before encoding it", async () => {
    const kinds: string[] = [];
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      onValidationInterruption: (kind) => kinds.push(kind),
    });
    const bytes = new Uint8Array(12 * 1024 * 1024).fill(255);
    const body = await new Response(boundary.pipe(new Response(bytes).body!)).text();
    expect(kinds).toEqual(["output-bytes"]);
    expect(body).toContain("consumer_rejected");
    expect(body.length).toBeLessThan(2048);
  });

  it("rejects a retained frame one byte past16MiB before validation and preserves accepted8MiB bytes", async () => {
    const kinds: string[] = [];
    let births = 0;
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      onValidationInterruption: (kind) => kinds.push(kind),
      createWorker: (url, options) => {
        births++;
        return new Worker(url, options);
      },
    });
    const bytes = new Uint8Array(16 * 1024 * 1024 + 1).fill(120);
    const body = await new Response(boundary.pipe(new Response(bytes).body!)).text();
    expect(kinds).toEqual(["frame-bytes"]);
    expect(body).toContain("consumer_rejected");
    expect(births).toBe(0);
    expect(boundary.terminal).toBe("failed");
    const accepted = new ResponsesFailureBoundary({ model: "test" });
    const original = new Uint8Array(8 * 1024 * 1024).fill(120);
    expect(
      Buffer.from(await new Response(accepted.pipe(new Response(original).body!)).arrayBuffer()).equals(
        Buffer.from(original),
      ),
    ).toBe(true);
  });

  it("rejects the1025th short SSEfield before split/map amplification", async () => {
    const kinds: string[] = [];
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      onValidationInterruption: (kind) => kinds.push(kind),
    });
    const text = ": x\n".repeat(1025) + "\n";
    const body = await new Response(boundary.pipe(new Response(text).body!)).text();
    expect(kinds).toEqual(["fields"]);
    expect(body).toContain("consumer_rejected");
    expect(body).not.toContain(text);
  });

  it("applies backpressure inside a giant chunk instead of staging every frame", async () => {
    const seen: unknown[] = [];
    const boundary = new ResponsesFailureBoundary({ model: "test" }, (event) => {
      seen.push(event.type);
    });
    const first = sseFrame({ type: "response.created", response: { id: "response" } });
    const second = sseFrame({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "item", call_id: "call", name: "f", arguments: "" },
    });
    const prefix = new TextEncoder().encode(": padding\n\n".repeat(500));
    const chunk = new Uint8Array(first.length + prefix.length + second.length);
    chunk.set(first);
    chunk.set(prefix, first.length);
    chunk.set(second, first.length + prefix.length);
    const reader = boundary.pipe(new Response(chunk).body!).getReader();
    try {
      await reader.read();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(seen).toEqual(["response.created"]);
    } finally {
      await reader.cancel();
      await boundary.dispose();
    }
  });

  it("retains an authenticated first fatal instead of replacing it with a later frame budget stop", async () => {
    const first = sseFrame({
      type: "response.failed",
      response: { status: "failed", error: { code: "server_error", message: "private error" } },
    });
    const bytes = new Uint8Array(first.length + 16 * 1024 * 1024 + 1);
    bytes.set(first);
    bytes.fill(120, first.length);
    const kinds: string[] = [];
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      onValidationInterruption: (kind) => kinds.push(kind),
    });
    const body = await new Response(boundary.pipe(new Response(bytes).body!)).text();
    expect(body).toContain("provider_failure");
    expect(body).not.toContain("consumer_rejected");
    expect(boundary.failure?.cause).toBe("transient");
    expect(body).not.toContain("private error");
    expect(kinds).toEqual(["frame-bytes"]);
    expect(body.length).toBeLessThan(2048);
  });
});

describe("Responses validator lifecycle", () => {
  it("keeps a throwing source-settlement observer outside the completed stream", async () => {
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      onSourceSettled: () => {
        throw new Error("private cleanup observer failure");
      },
    });
    const input = new Response(
      'data: {"type":"response.created","response":{"id":"response"}}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
    );
    const expected = await input.clone().text();
    expect(await new Response(boundary.pipe(input.body!)).text()).toBe(expected);
    expect(boundary.terminal).toBe("completed");
    await boundary.dispose();
  });

  it("settles source ownership only after deferred raw cancellation, with no validation after close", async () => {
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let cancellation = false,
      settlements = 0,
      births = 0;
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      capacity,
      onSourceSettled: () => {
        settlements++;
      },
      createWorker: (url, options) => {
        births++;
        return new Worker(url, options);
      },
    });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"'));
      },
      async cancel() {
        cancellation = true;
        await gate;
      },
    });
    const reader = boundary.pipe(source).getReader();
    const pending = reader.read();
    try {
      await reader.cancel();
      await expect.poll(() => cancellation).toBe(true);
      expect(settlements).toBe(0);
      expect(births).toBe(0);
      settle();
      await expect.poll(() => settlements).toBe(1);
      expect(births).toBe(0);
      expect(capacity.activeCount).toBe(0);
      expect(capacity.queuedCount).toBe(0);
      expect((await pending).done).toBe(true);
    } finally {
      settle();
      await boundary.dispose();
    }
  });

  it("releases a validator on readable cancellation without flush or model completion", async () => {
    for (const partial of [false, true]) {
      const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
      const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, { capacity });
      const transform = boundary.transform();
      const writer = transform.writable.getWriter();
      const reader = transform.readable.getReader();
      const closed = writer.closed.catch(() => {});
      const read = reader.read();
      await writer.write(sseFrame({ type: "response.created", response: { id: "response" } }));
      expect((await read).done).toBe(false);
      expect(capacity.activeCount).toBe(1);
      const unfinishedRead = partial ? reader.read() : undefined;
      if (partial)
        await writer.write(
          new TextEncoder().encode('data: {"type":"response.function_call_arguments.delta","delta":"unfinished'),
        );
      await reader.cancel();
      if (unfinishedRead) expect((await unfinishedRead).done).toBe(true);
      await closed;
      expect(capacity.activeCount).toBe(0);
      expect(capacity.queuedCount).toBe(0);
      expect(boundary.failure).toBeUndefined();
    }
  });

  it("emits signed unknown evidence for validator death without provider authority or unread terminal credit", async () => {
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const observed: unknown[] = [];
    const boundary = new ResponsesFailureBoundary({ model: "test" }, (event) => observed.push(event), {
      capacity,
      createWorker: () => new Worker("throw new Error('local validator failed')", { eval: true, env: {} }),
    });
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseFrame({ type: "response.created", response: { id: "response" } }));
        controller.enqueue(sseFrame({ type: "response.completed", response: { status: "completed", output: [] } }));
        controller.close();
      },
    });
    const text = await new Response(input.pipeThrough(boundary.transform())).text();
    const frame = JSON.parse(
      text
        .split("\n")
        .find((line) => line.startsWith("data: "))!
        .slice(6),
    ) as { code: string; message: string };
    expect(frame.code).toBe("unclassified_stream_failure");
    expect(proxyUnknownTerminalIsAuthenticated(frame.message)).toBe(true);
    expect(boundary.terminal).toBe("failed");
    expect(boundary.failure).toBeUndefined();
    expect(observed).toEqual([]);
    expect(capacity.activeCount).toBe(0);
  });
});

describe("Responses validator lifecycle", () => {
  it("releases unfinished validation on writable abort and provider-read failure", async () => {
    for (const ending of ["abort", "read-error"]) {
      const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
      const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, { capacity });
      if (ending === "abort") {
        const pair = boundary.transform();
        const reader = pair.readable.getReader();
        const writer = pair.writable.getWriter();
        const read = reader.read();
        await writer.write(sseFrame({ type: "response.created", response: { id: "response" } }));
        await read;
        expect(capacity.activeCount).toBe(1);
        await writer.abort();
        await reader.cancel().catch(() => {});
      } else {
        let source!: ReadableStreamDefaultController<Uint8Array>;
        const input = new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
          },
        });
        const reader = boundary.pipe(input).getReader();
        source.enqueue(sseFrame({ type: "response.created", response: { id: "response" } }));
        await reader.read();
        expect(capacity.activeCount).toBe(1);
        source.error(new Error("source read failed"));
        await expect(reader.read()).rejects.toThrow("source read failed");
      }
      expect(capacity.activeCount).toBe(0);
      expect(capacity.queuedCount).toBe(0);
    }
  });
});

import { MessageChannel } from "node:worker_threads";

describe("Responses validator lifecycle", () => {
  it("keeps diagnostic failure outside the signed local interruption outcome", async () => {
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const release = await capacity.acquire();
    const events: string[] = [];
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      capacity,
      onValidationInterruption: (kind) => {
        events.push(kind);
        throw new Error("private diagnostic sink failure");
      },
    });
    try {
      const body = await new Response(
        boundary.pipe(new Response(sseFrame({ type: "response.created", response: { id: "response" } })).body!),
      ).text();
      expect(body).toContain("consumer_rejected");
      expect(body).not.toContain("private diagnostic sink failure");
      expect(events).toEqual(["capacity"]);
      expect(boundary.failure).toBeUndefined();
      expect(capacity.activeCount).toBe(1);
      expect(capacity.queuedCount).toBe(0);
    } finally {
      await boundary.dispose();
      release();
    }
  });

  it("does not enqueue a local ending after source failure during actual worker exit", async () => {
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const original = new Error("source failed during local validator shutdown");
    let activeAtExit: number | undefined;
    let exited = false;
    const enqueue = vi.spyOn(TransformStreamDefaultController.prototype, "enqueue");
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      capacity,
      createWorker: () => {
        const worker = new Worker(
          `
          const {parentPort,workerData}=require('node:worker_threads');
          parentPort.on('message',()=>parentPort.postMessage({broken:true}));
          parentPort.postMessage({ready:true});
        `,
          { eval: true, env: {}, execArgv: ["--import", "tsx"], workerData: { protocol: fixtureProtocolUrl } },
        );
        worker.once("exit", () => {
          activeAtExit = capacity.activeCount;
          exited = true;
          // Local protocol failure has begun disposal, but its asynchronous
          // unknown ending must yield to this independently observed error.
          source.error(original);
        });
        return worker;
      },
    });
    const input = new ReadableStream<Uint8Array>({
      start: (controller) => {
        source = controller;
      },
    });
    const reader = boundary.pipe(input).getReader();
    const pending = reader.read().then(
      () => undefined,
      (error: unknown) => error,
    );
    source.enqueue(sseFrame({ type: "response.created", response: { id: "response" } }));
    try {
      expect(await pending).toBe(original);
      await boundary.dispose();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(enqueue).not.toHaveBeenCalled();
      expect(exited).toBe(true);
      expect(activeAtExit).toBe(1);
      expect(capacity.activeCount).toBe(0);
      expect(capacity.queuedCount).toBe(0);
      expect(boundary.failure).toBeUndefined();
      await expect.poll(() => input.locked).toBe(false);
    } finally {
      await boundary.dispose();
      await reader.cancel().catch(() => {});
      enqueue.mockRestore();
    }
  });

  it("preserves a source error before starting any validator", async () => {
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    let births = 0;
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      capacity,
      createWorker: (url, options) => {
        births++;
        return new Worker(url, options);
      },
    });
    const original = new Error("source failed before validation");
    const input = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(original) });
    const reader = boundary.pipe(input).getReader();
    await expect(reader.read()).rejects.toBe(original);
    await boundary.dispose();
    expect(births).toBe(0);
    expect(capacity.activeCount).toBe(0);
    expect(capacity.queuedCount).toBe(0);
    expect(input.locked).toBe(false);
  });

  it("cancels source-failed queued validation without releasing another worker's slot", async () => {
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 1 });
    const other = new ResponsesConsumer("test", { capacity });
    let births = 0;
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      capacity,
      createWorker: (url, options) => {
        births++;
        return new Worker(url, options);
      },
    });
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start: (controller) => {
        source = controller;
      },
    });
    const reader = boundary.pipe(input).getReader();
    const original = new Error("source failed in capacity queue");
    const pending = reader.read().then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      const parsed = await other.parseJSON('{"type":"response.created","response":{"id":"other"}}');
      expect(parsed).toMatchObject({ ok: true, value: { type: "response.created", response: { id: "other" } } });
      if (parsed.ok) parsed.release?.();
      source.enqueue(sseFrame({ type: "response.created", response: { id: "queued" } }));
      await expect.poll(() => capacity.queuedCount).toBe(1);
      source.error(original);
      expect(await pending).toBe(original);
      await boundary.dispose();
      expect(births).toBe(0);
      expect(capacity.activeCount).toBe(1);
      expect(capacity.queuedCount).toBe(0);
      await expect.poll(() => input.locked).toBe(false);
    } finally {
      await boundary.dispose();
      await other.dispose();
      await reader.cancel().catch(() => {});
    }
    expect(capacity.activeCount).toBe(0);
  });

  it.each(["startup", "parse"] as const)(
    "terminates source-failed validation during %s before granting its slot again",
    async (phase) => {
      const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
      const probe = new MessageChannel();
      const gate = new SharedArrayBuffer(4);
      let exited = false;
      let activeAtExit: number | undefined;
      const entered = new Promise<void>((resolve) => probe.port1.once("message", () => resolve()));
      const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
        capacity,
        createWorker: () => {
          const worker = new Worker(
            `
          const {parentPort,workerData}=require('node:worker_threads');
          const block=()=>{workerData.probe.postMessage('blocked');Atomics.wait(new Int32Array(workerData.gate),0,0);};
          if(workerData.phase==='startup') block();
          (async()=>{const {responsesFixtureProtocol}=await require('tsx/esm/api').tsImport(workerData.protocol, __filename);const rpc=responsesFixtureProtocol(parentPort);
          parentPort.on('message',request=>{if(request.op==='parse')block();rpc.control(request);});
          parentPort.postMessage({ready:true});})();
        `,
            {
              eval: true,
              env: {},
              execArgv: ["--import", "tsx"],
              workerData: { phase, gate, probe: probe.port2, protocol: fixtureProtocolUrl },
              transferList: [probe.port2],
            },
          );
          worker.once("exit", () => {
            activeAtExit = capacity.activeCount;
            exited = true;
          });
          return worker;
        },
      });
      let source!: ReadableStreamDefaultController<Uint8Array>;
      const input = new ReadableStream<Uint8Array>({
        start: (controller) => {
          source = controller;
        },
      });
      const reader = boundary.pipe(input).getReader();
      const pending = reader.read().then(
        () => undefined,
        (error: unknown) => error,
      );
      source.enqueue(sseFrame({ type: "response.created", response: { id: "response" } }));
      await entered;
      const original = new Error(`source failed during ${phase}`);
      try {
        expect(capacity.activeCount).toBe(1);
        source.error(original);
        expect(await pending).toBe(original);
        await boundary.dispose();
        expect(exited).toBe(true);
        expect(activeAtExit).toBe(1);
        expect(capacity.activeCount).toBe(0);
        expect(capacity.queuedCount).toBe(0);
        await expect.poll(() => input.locked).toBe(false);
      } finally {
        Atomics.store(new Int32Array(gate), 0, 1);
        Atomics.notify(new Int32Array(gate), 0);
        await boundary.dispose();
        await reader.cancel().catch(() => {});
        await pending;
        probe.port1.close();
        probe.port2.close();
      }
    },
  );

  it("stops unfinished framing on a source error at the next I/O yield", async () => {
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    let births = 0;
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      capacity,
      createWorker: (url, options) => {
        births++;
        return new Worker(url, options);
      },
    });
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start: (controller) => {
        source = controller;
      },
    });
    const reader = boundary.pipe(input).getReader();
    const pending = reader.read().then(
      () => undefined,
      (error: unknown) => error,
    );
    const original = new Error("source failed during unfinished framing");
    source.enqueue(new TextEncoder().encode('data: {"delta":"' + "x".repeat(1024 * 1024)));
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        source.error(original);
        resolve();
      }),
    );
    expect(await pending).toBe(original);
    await boundary.dispose();
    expect(births).toBe(0);
    expect(capacity.activeCount).toBe(0);
    expect(capacity.queuedCount).toBe(0);
  });

  it("retains source bytes, backpressure and cancellation ownership through the observed pipe", async () => {
    const chunks = [": first\r\n\r\n", ": second\n\n", ": final\r\r"].map((text) => new TextEncoder().encode(text));
    let pulls = 0;
    let cancellation: unknown;
    const input = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          const chunk = chunks[pulls++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel: (reason) => {
          cancellation = reason;
        },
      },
      { highWaterMark: 0 },
    );
    const boundary = new ResponsesFailureBoundary({ model: "test" });
    const reader = boundary.pipe(input).getReader();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pulls).toBe(1);
    expect((await reader.read()).value).toEqual(chunks[0]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pulls).toBe(2);
    const reason = new Error("original reader cancellation");
    await reader.cancel(reason);
    await expect.poll(() => input.locked).toBe(false);
    expect(cancellation).toBe(reason);
    expect(pulls).toBe(2);
    await boundary.dispose();

    const complete = new ResponsesFailureBoundary({ model: "test" });
    const source = new Response(chunks.map((chunk) => new TextDecoder().decode(chunk)).join("")).body!;
    expect(await new Response(complete.pipe(source)).text()).toBe(": first\r\n\r\n: second\n\n: final\r\r");
    expect(source.locked).toBe(false);
  });

  it("preserves an upstream source error while neutral JSON parsing is blocked without caller abort", async () => {
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const interruptions: string[] = [];
    const probe = new MessageChannel();
    const gate = new SharedArrayBuffer(4);
    let exited = false;
    let births = 0;
    const entered = new Promise<void>((resolve) => probe.port1.once("message", () => resolve()));
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      capacity,
      onValidationInterruption: (kind) => {
        interruptions.push(kind);
      },
      createWorker: () => {
        births++;
        const worker = new Worker(
          `
          const {parentPort,workerData}=require('node:worker_threads');
          (async () => {
            const {responsesFixtureProtocol}=await require('tsx/esm/api').tsImport(workerData.protocol, __filename);const rpc=responsesFixtureProtocol(parentPort);
            parentPort.on('message', request => {
              if(request.op==='parse' && request.target==='frame' && rpc.event(request).type==='response.function_call_arguments.delta') {
                workerData.probe.postMessage('parser busy');
                Atomics.wait(new Int32Array(workerData.gate),0,0);
              }
              rpc.control(request);
            });
            parentPort.postMessage({ready:true});
          })();
        `,
          {
            eval: true,
            env: {},
            execArgv: ["--import", "tsx"],
            workerData: {
              gate,
              probe: probe.port2,
              protocol: fixtureProtocolUrl,
            },
            transferList: [probe.port2],
          },
        );
        worker.once("exit", () => {
          exited = true;
        });
        return worker;
      },
    });
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start: (controller) => {
        source = controller;
      },
    });
    const reader = boundary.pipe(input).getReader();
    const item = { type: "function_call", id: "item", call_id: "call", name: "bash", arguments: "" };
    source.enqueue(sseFrame({ type: "response.output_item.added", output_index: 0, item }));
    await reader.read();
    const pending = reader.read().then(
      () => undefined,
      (error: unknown) => error,
    );
    source.enqueue(
      sseFrame({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"command":"busy' }),
    );
    await entered;
    expect(capacity.activeCount).toBe(1);
    const original = new Error("original upstream read failure");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      source.error(original);
      const failure = await Promise.race([
        pending,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 300);
        }),
      ]);
      expect(failure).toBe(original);
      await boundary.dispose();
      expect(exited).toBe(true);
      expect(capacity.activeCount).toBe(0);
      expect(capacity.queuedCount).toBe(0);
      expect(boundary.failure).toBeUndefined();
      expect(births).toBe(1);
      expect(interruptions).toEqual([]);
    } finally {
      if (timer) clearTimeout(timer);
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0);
      await boundary.dispose();
      await reader.cancel().catch(() => {});
      await pending;
      probe.port1.close();
      probe.port2.close();
    }
  });

  it("aborts a pending validator write without an external signal or deferred abort callback", async () => {
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const interruptions: string[] = [];
    const probe = new MessageChannel();
    let exited = false;
    const entered = new Promise<void>((resolve) => probe.port1.once("message", () => resolve()));
    const boundary = new ResponsesFailureBoundary({ model: "test" }, undefined, {
      capacity,
      onValidationInterruption: (kind) => {
        interruptions.push(kind);
      },
      createWorker: () => {
        // An independently blocked validator isolates the Web Streams abort
        // ordering from whether a particular parse happens to finish.
        const worker = new Worker(
          `
          const {parentPort,workerData}=require('node:worker_threads');
          (async()=>{const {responsesFixtureProtocol}=await require('tsx/esm/api').tsImport(workerData.protocol, __filename);const rpc=responsesFixtureProtocol(parentPort);
          parentPort.on('message',request=>{
            const event=request.op==='parse'&&request.target==='frame'?rpc.event(request):undefined;
            if(event?.type==='response.function_call_arguments.delta'){workerData.probe.postMessage('busy');while(true){}}
            rpc.control(request);
          });parentPort.postMessage({ready:true});})();
        `,
          {
            eval: true,
            env: {},
            execArgv: ["--import", "tsx"],
            workerData: { probe: probe.port2, protocol: fixtureProtocolUrl },
            transferList: [probe.port2],
          },
        );
        worker.once("exit", () => {
          exited = true;
        });
        return worker;
      },
    });
    const pair = boundary.transform();
    const writer = pair.writable.getWriter();
    const reader = pair.readable.getReader();
    const closed = writer.closed.catch(() => {});
    const firstRead = reader.read();
    await writer.write(sseFrame({ type: "response.created", response: { id: "response" } }));
    await firstRead;
    const pendingRead = reader.read().catch(() => ({ done: true }));
    const pendingWrite = writer
      .write(sseFrame({ type: "response.function_call_arguments.delta", output_index: 0, delta: "busy" }))
      .catch(() => {});
    await entered;
    expect(capacity.activeCount).toBe(1);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = writer.abort(new Error("original stream abort")).then(
      () => true,
      () => true,
    );
    try {
      const settled = await Promise.race([
        aborted,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 300);
        }),
      ]);
      expect(settled).toBe(true);
      expect(exited).toBe(true);
      expect(capacity.activeCount).toBe(0);
      expect(capacity.queuedCount).toBe(0);
      expect(boundary.failure).toBeUndefined();
      expect(interruptions).toEqual(["aborted"]);
    } finally {
      if (timer) clearTimeout(timer);
      await boundary.dispose();
      await reader.cancel().catch(() => {});
      await Promise.all([pendingWrite, pendingRead, aborted, closed]);
      probe.port1.close();
      probe.port2.close();
    }
  });
});
