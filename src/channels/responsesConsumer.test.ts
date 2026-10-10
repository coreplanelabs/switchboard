import { describe, expect, it, vi } from "vitest";
import { ResponsesConsumer } from "./responsesConsumer.js";

describe("Responses validation isolation", () => {
  it("cancels queued parsing before worker startup and returns its permit for a later call", async () => {
    const pool = new ResponsesValidationCapacity({ workers: 3, queued: 0 });
    const blockers = Array.from(
      { length: 1 },
      () =>
        new ResponsesConsumer("test", {
          capacity: pool,
          createWorker: () =>
            new Worker(
              "const { parentPort } = require('node:worker_threads'); parentPort.on('message', () => {}); parentPort.postMessage({ ready: true });",
              { eval: true, env: {} },
            ),
        }),
    );
    const pending = blockers.map((consumer) => consumer.parseJSON("{}").catch((error) => error));
    const control = new AbortController();
    let started = 0;
    const waiting = new ResponsesConsumer("test", {
      capacity: pool,
      signal: control.signal,
      createWorker: (url, options) => {
        started++;
        return new Worker(url, options);
      },
    });
    try {
      await vi.waitFor(() => expect(pool.activeCount).toBe(1));
      const outcome = waiting.parseJSON('{"answer":"unexpected"}').catch((error: { kind: string }) => error.kind);
      await vi.waitFor(() => expect(pool.activeCount).toBe(2));
      expect(started).toBe(0);
      control.abort();
      expect(await outcome).toBe("aborted");
      expect(started).toBe(0);
    } finally {
      await waiting.dispose();
      await Promise.all(blockers.map((consumer) => consumer.dispose()));
      await Promise.all(pending);
    }
    const fresh = new ResponsesConsumer("test", { capacity: pool });
    try {
      const result = await fresh.parseJSON('{"answer":"ready"}');
      expect(result).toMatchObject({ ok: true, value: { answer: "ready" } });
      if (result.ok) result.release?.();
    } finally {
      await fresh.dispose();
    }
    expect(pool.activeCount).toBe(0);
    expect(pool.storageBytes).toBe(0);
  });

  it("admits two simultaneous2MiB NativeJSON graphs without projection or leaked storage", async () => {
    const pool = new ResponsesValidationCapacity({ workers: 2, queued: 0 });
    const clients = [
      new ResponsesConsumer("test", { capacity: pool }),
      new ResponsesConsumer("test", { capacity: pool }),
    ];
    const text = JSON.stringify({ type: "response.function_call_arguments.delta", delta: "x".repeat(2 * 1024 * 1024) });
    try {
      const results = await Promise.all(clients.map((client) => client.parseJSON(text)));
      for (const result of results) {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect((result.value as { delta: string }).delta.length).toBe(2 * 1024 * 1024);
          result.release?.();
        }
      }
    } finally {
      await Promise.all(clients.map((client) => client.dispose()));
    }
    expect(pool.activeCount).toBe(0);
    expect(pool.storageBytes).toBe(0);
  });

  it.each(["target", "id", "op", "permit", "phase", "stats", "duplicate", "oversize"] as const)(
    "rejects malformed private%s before value decoding",
    async (kind) => {
      const pool = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
      const client = new ResponsesConsumer("test", {
        capacity: pool,
        createWorker: () =>
          new Worker(
            `
      const {parentPort,workerData}=require('node:worker_threads');
      parentPort.on('message',r=>{
        if(r.op==='parse'){
          const meta={id:r.id,op:'parse',target:r.target,permit:r.permit,phase:'prepared',stats:{entries:1,depth:1,units:0}};
          if(workerData==='target')meta.target='wrong';if(workerData==='id')meta.id++;if(workerData==='op')meta.op='consume';if(workerData==='permit')meta.permit++;if(workerData==='phase')meta.phase='wrong';if(workerData==='stats')meta.stats.entries=262145;parentPort.postMessage(meta);
          if(workerData==='duplicate')parentPort.postMessage(meta);
        }else if(r.op==='serialize'&&workerData==='oversize'){
          const payload=new ArrayBuffer(32*1024*1024+1);parentPort.postMessage({id:r.id,op:'parse',target:r.target,permit:r.permit,phase:'reply',ok:true,stats:{entries:1,depth:1,units:0},payload},[payload]);
        }
      });parentPort.postMessage({ready:true});
    `,
            { eval: true, env: {}, workerData: kind },
          ),
      });
      try {
        await expect(client.parseJSON("{}")).rejects.toMatchObject({
          kind: kind === "oversize" ? "ipc-bytes" : "protocol",
        });
      } finally {
        await client.dispose();
      }
      expect(pool.storageBytes).toBe(0);
      expect(pool.activeCount).toBe(0);
    },
  );

  it("holds one actual worker graph without a full reply until matching serialization permission", async () => {
    const once = (worker: Worker, _event: "message") =>
      new Promise<unknown[]>((resolve) => worker.once("message", (message) => resolve([message])));
    const pool = new ResponsesValidationCapacity();
    const permit = pool.reserveStorage(128 * 1024 * 1024, "parse-working");
    const worker = new Worker(new URL("./responsesConsumerWorker.ts", import.meta.url), {
      env: {},
      execArgv: ["--import", "tsx"],
      workerData: { modelId: "test" },
    });
    try {
      expect((await once(worker, "message"))[0]).toEqual({ ready: true });
      const prepared = once(worker, "message");
      const payload = new TextEncoder().encode("{}").buffer;
      worker.postMessage({ id: 1, permit: permit.id, op: "parse", target: "request", encoding: "utf8", payload }, [
        payload,
      ]);
      const reply = (await prepared)[0] as { payload?: unknown };
      expect(reply).toMatchObject({
        id: 1,
        permit: permit.id,
        phase: "prepared",
        stats: { entries: 1, depth: 1, units: 0 },
      });
      expect(reply.payload).toBeUndefined();
      const refused = once(worker, "message");
      const second = new TextEncoder().encode("{}").buffer;
      worker.postMessage(
        { id: 2, permit: permit.id, op: "parse", target: "request", encoding: "utf8", payload: second },
        [second],
      );
      expect((await refused)[0]).toMatchObject({ id: 2, phase: "failure", kind: "protocol" });
      expect(permit.bytes).toBe(128 * 1024 * 1024);
    } finally {
      await worker.terminate();
      permit.release();
    }
    expect(pool.storageBytes).toBe(0);
  });

  it("holds failed prepared-swap storage until the actual worker exits", async () => {
    const pool = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const pressure = pool.reserveStorage(200 * 1024 * 1024, "other-owner");
    let storageAtExit = 0,
      exited = false;
    const client = new ResponsesConsumer("test", {
      capacity: pool,
      createWorker: () => {
        const worker = new Worker(
          `const {parentPort}=require('node:worker_threads');parentPort.on('message',r=>{if(r.op==='parse')parentPort.postMessage({id:r.id,op:'parse',target:r.target,permit:r.permit,phase:'prepared',stats:{entries:262144,depth:1,units:33554432}});});parentPort.postMessage({ready:true});`,
          { eval: true, env: {} },
        );
        worker.once("exit", () => {
          storageAtExit = pool.storageBytes;
          exited = true;
        });
        return worker;
      },
    });
    try {
      await expect(client.parseBytes(new TextEncoder().encode("{}").buffer, "request")).rejects.toMatchObject({
        kind: "storage",
      });
      await client.dispose();
      expect(exited).toBe(true);
      expect(storageAtExit).toBeGreaterThan(pressure.bytes);
      expect(pool.storageBytes).toBe(pressure.bytes);
    } finally {
      await client.dispose();
      pressure.release();
    }
    expect(pool.storageBytes).toBe(0);
  });

  it("aborts while a prepared graph has no serialized reply and releases only after exit", async () => {
    const pool = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const control = new AbortController();
    const probe = new (await import("node:worker_threads")).MessageChannel();
    const prepared = new Promise<void>((resolve) => probe.port1.once("message", () => resolve()));
    let exited = false,
      storageAtExit = 0;
    const client = new ResponsesConsumer("test", {
      capacity: pool,
      signal: control.signal,
      createWorker: () => {
        const worker = new Worker(
          `const {parentPort,workerData}=require('node:worker_threads');parentPort.on('message',r=>{if(r.op==='parse')parentPort.postMessage({id:r.id,op:'parse',target:r.target,permit:r.permit,phase:'prepared',stats:{entries:1,depth:1,units:0}});if(r.op==='serialize')workerData.postMessage('prepared');});parentPort.postMessage({ready:true});`,
          { eval: true, env: {}, workerData: probe.port2, transferList: [probe.port2] },
        );
        worker.once("exit", () => {
          storageAtExit = pool.storageBytes;
          exited = true;
        });
        return worker;
      },
    });
    const pending = client.parseJSON("{}").catch((error) => error);
    try {
      await prepared;
      expect(pool.storageBytes).toBeGreaterThan(0);
      control.abort();
      expect(await pending).toMatchObject({ kind: "aborted" });
      await client.dispose();
      expect(exited).toBe(true);
      expect(storageAtExit).toBeGreaterThan(0);
      expect(pool.storageBytes).toBe(0);
    } finally {
      await client.dispose();
      probe.port1.close();
      probe.port2.close();
    }
  });

  it.each([false, true])(
    "honors original caller control after neutral parsing enters its worker, aborted=%s",
    async (aborted) => {
      const control = new AbortController();
      const probe = new (await import("node:worker_threads")).MessageChannel();
      const gate = new SharedArrayBuffer(4);
      const entered = new Promise<void>((resolve) => probe.port1.once("message", () => resolve()));
      const pool = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
      const consumer = new ResponsesConsumer("test", {
        signal: control.signal,
        capacity: pool,
        createWorker: (_url, options) =>
          new Worker(
            `
        const {parentPort,workerData}=require('node:worker_threads');
        (async()=>{
          const {responsesFixtureProtocol}=await require('tsx/esm/api').tsImport(workerData.protocol,__filename);
          const rpc=responsesFixtureProtocol(parentPort);
          parentPort.on('message',request=>{
            if(request.op==='parse'){
              workerData.probe.postMessage('entered');
              Atomics.wait(new Int32Array(workerData.gate),0,0);
            }
            rpc.control(request);
          });
          parentPort.postMessage({ready:true});
        })();`,
            {
              ...options,
              eval: true,
              workerData: {
                gate,
                probe: probe.port2,
                protocol: new URL("./testing/responsesFixtureProtocol.ts", import.meta.url).href,
              },
              transferList: [probe.port2],
            },
          ),
      });
      const pending = consumer.parseJSON(JSON.stringify({ type: "large", text: "x".repeat(2 * 1024 * 1024) }));
      try {
        await entered;
        expect(pool.activeCount).toBe(1);
        if (aborted) {
          const rejected = expect(pending).rejects.toMatchObject({
            name: "ResponsesValidationInterrupted",
            kind: "aborted",
          });
          control.abort();
          await rejected;
        } else {
          Atomics.store(new Int32Array(gate), 0, 1);
          Atomics.notify(new Int32Array(gate), 0);
          const result = await pending;
          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error("expected admitted JSON value");
          expect(result.value).toMatchObject({ type: "large" });
          expect((result.value as { text: string }).text.length).toBe(2_097_152);
          result.release?.();
        }
        await consumer.dispose();
        expect(pool.activeCount).toBe(0);
        expect(pool.storageBytes).toBe(0);
      } finally {
        Atomics.store(new Int32Array(gate), 0, 1);
        Atomics.notify(new Int32Array(gate), 0);
        await consumer.dispose();
        await pending.catch(() => {});
        probe.port1.close();
        probe.port2.close();
      }
    },
  );
});

import { Worker } from "node:worker_threads";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { ResponsesValidationCapacity } from "./responsesValidationCapacity.js";

const created = { type: "response.created", response: { id: "response" } };

describe("Responses validation isolation", () => {
  it("cancels a queued caller without releasing another call's validator", async () => {
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 1 });
    const control = new AbortController();
    const first = new ResponsesConsumer("test", { capacity });
    const queued = new ResponsesConsumer("test", { capacity, signal: control.signal });
    const graph = await first.parseJSON(JSON.stringify(created));
    expect(graph).toMatchObject({ ok: true, value: { type: "response.created", response: { id: "response" } } });
    if (graph.ok) graph.release?.();
    const pending = queued.parseJSON(JSON.stringify(created));
    await yieldToIo();
    expect(capacity.activeCount).toBe(1);
    expect(capacity.queuedCount).toBe(1);
    control.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
    await queued.dispose();
    expect(capacity.activeCount).toBe(1);
    expect(capacity.queuedCount).toBe(0);
    await first.finish();
    expect(capacity.activeCount).toBe(0);
  });

  it("refuses excess waiting calls locally and reuses a slot only after actual worker exit", async () => {
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 1 });
    let firstExited = false;
    let births = 0;
    const createWorker = (url: URL, options: import("node:worker_threads").WorkerOptions) => {
      births++;
      if (births === 2) expect(firstExited).toBe(true);
      const worker = new Worker(url, options);
      if (births === 1)
        worker.once("exit", () => {
          firstExited = true;
        });
      return worker;
    };
    const first = new ResponsesConsumer("test", { capacity, createWorker });
    const second = new ResponsesConsumer("test", { capacity, createWorker });
    const excess = new ResponsesConsumer("test", { capacity, createWorker });
    const graph = await first.parseJSON(JSON.stringify(created));
    expect(graph).toMatchObject({ ok: true, value: { type: "response.created", response: { id: "response" } } });
    if (graph.ok) graph.release?.();
    const waiting = second.parseJSON(JSON.stringify(created));
    await yieldToIo();
    await expect(excess.parseJSON(JSON.stringify(created))).rejects.toMatchObject({ kind: "capacity" });
    expect(births).toBe(1);
    await excess.dispose();
    await first.finish();
    const admitted = await waiting;
    expect(admitted).toMatchObject({ ok: true, value: { type: "response.created", response: { id: "response" } } });
    if (admitted.ok) admitted.release?.();
    expect(births).toBe(2);
    await second.finish();
    expect(capacity.activeCount).toBe(0);
    expect(capacity.queuedCount).toBe(0);
  });

  it("settles an unexpected worker exit as local uncertainty and releases its slot", async () => {
    const capacity = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const consumer = new ResponsesConsumer("test", {
      capacity,
      createWorker: () => new Worker("process.exit(1)", { eval: true, env: {} }),
    });
    await expect(consumer.parseJSON(JSON.stringify(created))).rejects.toMatchObject({
      name: "ResponsesValidationInterrupted",
      kind: "worker-exit",
    });
    await consumer.dispose();
    expect(capacity.activeCount).toBe(0);
  });
});
