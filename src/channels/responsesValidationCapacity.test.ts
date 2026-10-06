import { describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { ResponsesValidationCapacity } from "./responsesValidationCapacity.js";
import { ResponsesConsumer } from "./responsesConsumer.js";

describe("Responses transport reservation", () => {
  it("observes only actual queue entry without changing immediate admission or full-queue refusal", async () => {
    const pool = new ResponsesValidationCapacity({ workers: 1, queued: 1 });
    let entries = 0;
    const observe = () => entries++;
    const first = await pool.reserve(undefined, observe);
    const waiting = pool.reserve(undefined, observe);
    try {
      expect(entries).toBe(1);
      expect(pool.activeCount).toBe(1);
      expect(pool.queuedCount).toBe(1);
      await expect(pool.reserve(undefined, observe)).rejects.toMatchObject({ kind: "capacity" });
      expect(entries).toBe(1);
    } finally {
      first.finishTransport();
      (await waiting).finishTransport();
    }
    expect(pool.activeCount).toBe(0);
    expect(pool.queuedCount).toBe(0);
  });

  it("keeps a throwing queue observer outside the original cancellation and ownership", async () => {
    const pool = new ResponsesValidationCapacity({ workers: 1, queued: 1 });
    const first = await pool.reserve();
    const control = new AbortController();
    let observed = false;
    const waiting = pool.reserve(control.signal, () => {
      observed = true;
      throw new Error("private observer failure");
    });
    const rejected = expect(waiting).rejects.toMatchObject({ kind: "aborted" });
    try {
      expect(observed).toBe(true);
      expect(pool.activeCount).toBe(1);
      expect(pool.queuedCount).toBe(1);
      control.abort();
      await rejected;
      expect(pool.activeCount).toBe(1);
      expect(pool.queuedCount).toBe(0);
    } finally {
      control.abort();
      await rejected;
      first.finishTransport();
    }
    expect(pool.activeCount).toBe(0);
  });

  it("drops retired permit bookkeeping before transport close and keeps emergency closure inside512MiB", async () => {
    const pool = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const owner = await pool.reserve();
    const live = owner.liveStoragePermits;
    const storage = pool.storageBytes;
    for (let at = 0; at < 10000; at++) {
      const permit = owner.reserveStorage(1, "small-frame");
      permit.transfer("output");
      permit.release();
      permit.release();
    }
    expect(owner.liveStoragePermits).toBe(live);
    expect(pool.storageBytes).toBe(storage);
    const rest = owner.reserveStorage(512 * 1024 * 1024 - storage, "pressure");
    expect(() => owner.reserveStorage(1, "overflow")).toThrow("storage");
    expect(() => owner.claimEndingStorage(4096)).not.toThrow();
    expect(() => owner.claimEndingStorage(4097)).toThrow("output-bytes");
    rest.release();
    owner.finishTransport();
    expect(pool.storageBytes).toBe(0);
  });
  it("unwinds a slot when its emergency reservation cannot be admitted", async () => {
    const pool = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const full = pool.reserveStorage(512 * 1024 * 1024, "pressure");
    await expect(pool.reserve()).rejects.toMatchObject({ kind: "storage" });
    expect(pool.activeCount).toBe(0);
    full.release();
  });
  it("reserves managed storage before allocation, transfers without free credit, and fails overlapping maxima", async () => {
    const pool = new ResponsesValidationCapacity({ workers: 2, queued: 0 });
    const first = await pool.reserve(),
      second = await pool.reserve();
    try {
      const graph = first.reserveStorage(128 * 1024 * 1024, "worker-graph");
      const serialization = first.reserveStorage(193 * 1024 * 1024, "worker-serializer");
      expect(pool.storageBytes).toBe(321 * 1024 * 1024 + 8192);
      const secondGraph = second.reserveStorage(128 * 1024 * 1024, "worker-graph");
      expect(() => second.reserveStorage(193 * 1024 * 1024, "worker-serializer")).toThrow("storage");
      expect(pool.storageBytes).toBe(449 * 1024 * 1024 + 8192);
      graph.transfer("parent-graph");
      expect(pool.storageBytes).toBe(449 * 1024 * 1024 + 8192);
      graph.release();
      graph.release();
      serialization.release();
      secondGraph.release();
      expect(pool.storageBytes).toBe(8192);
    } finally {
      first.finishTransport();
      second.finishTransport();
    }
  });

  it("holds concurrent raw-reader and framer sources until both settle", async () => {
    const pool = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const reservation = await pool.reserve();
    reservation.beginSource();
    reservation.beginSource();
    reservation.finishTransport();
    reservation.finishSource();
    expect(pool.activeCount).toBe(1);
    reservation.finishSource();
    expect(pool.activeCount).toBe(0);
  });

  it("retains exact cumulative bytes and latches a local overflow across response attempts", async () => {
    const pool = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const reservation = await pool.reserve();
    reservation.countResponseBytes(16 * 1024 * 1024);
    reservation.countResponseBytes(48 * 1024 * 1024);
    expect(reservation.responseInterruption).toBeUndefined();
    expect(() => reservation.countResponseBytes(1)).toThrow("stream-bytes");
    const original = reservation.responseInterruption;
    expect(() => reservation.countResponseBytes(0)).toThrow(original);
    reservation.finishTransport();
    expect(pool.activeCount).toBe(0);
  });

  it.each(["transport", "validation"] as const)("waits for both owners when %s finishes first", async (first) => {
    const pool = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const reservation = await pool.reserve();
    const exited = await reservation.capacity.acquire();
    expect(pool.activeCount).toBe(1);
    if (first === "transport") reservation.finishTransport();
    else exited();
    expect(pool.activeCount).toBe(1);
    if (first === "transport") exited();
    else reservation.finishTransport();
    expect(pool.activeCount).toBe(0);
    exited();
    reservation.finishTransport();
    expect(pool.activeCount).toBe(0);
    await expect(reservation.capacity.acquire()).rejects.toMatchObject({ kind: "protocol" });
  });

  it("returns unused and cancelled-before-adoption reservations without a worker", async () => {
    const pool = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const unused = await pool.reserve();
    unused.finishTransport();
    const cancelled = await pool.reserve();
    const control = new AbortController();
    control.abort();
    await expect(cancelled.capacity.acquire(control.signal)).rejects.toMatchObject({ kind: "aborted" });
    cancelled.finishTransport();
    expect(pool.activeCount).toBe(0);
  });

  it("keeps the original bounded FIFO while a queued header request is cancelled", async () => {
    const pool = new ResponsesValidationCapacity({ workers: 1, queued: 2 });
    const first = await pool.reserve();
    const control = new AbortController();
    const cancelled = pool.reserve(control.signal);
    const next = pool.reserve();
    await expect(pool.reserve()).rejects.toMatchObject({ kind: "capacity" });
    control.abort();
    await expect(cancelled).rejects.toMatchObject({ kind: "aborted" });
    expect(pool.activeCount).toBe(1);
    expect(pool.queuedCount).toBe(1);
    first.finishTransport();
    const last = await next;
    expect(pool.activeCount).toBe(1);
    last.finishTransport();
    expect(pool.activeCount).toBe(0);
    expect(pool.queuedCount).toBe(0);
  });

  it("adopts one real worker without another slot and waits for its actual exit", async () => {
    const pool = new ResponsesValidationCapacity({ workers: 1, queued: 0 });
    const reservation = await pool.reserve();
    let exited = false;
    let activeAtExit: number | undefined;
    const consumer = new ResponsesConsumer("test", {
      capacity: reservation.capacity,
      createWorker: (url, options) => {
        const worker = new Worker(url, options);
        worker.once("exit", () => {
          exited = true;
          activeAtExit = pool.activeCount;
        });
        return worker;
      },
    });
    try {
      expect(await consumer.consume({ type: "response.created", response: { id: "response" } })).toBe(true);
      expect(pool.activeCount).toBe(1);
      reservation.finishTransport();
      expect(pool.activeCount).toBe(1);
      await consumer.close();
      expect(exited).toBe(true);
      expect(activeAtExit).toBe(1);
      expect(pool.activeCount).toBe(0);
    } finally {
      reservation.finishTransport();
      await consumer.dispose();
    }
  });
});
