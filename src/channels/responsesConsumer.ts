import { Worker, type WorkerOptions } from "node:worker_threads";
import { RESPONSES_VALIDATION_LIMITS } from "../core/budgets.js";
import {
  ResponsesValidationInterrupted,
  responsesValidationCapacity,
  type ResponsesValidationCapacity,
  type ResponsesValidationReservation,
  type ResponsesStoragePermit,
} from "./responsesValidationCapacity.js";

import {
  inspectResponsesGraph,
  packResponsesValue,
  unpackResponsesValue,
  validateResponsesPayload,
  validResponsesStats,
  responsesGraphCharge,
  responsesGraphMaximum,
  responsesSerializationWorking,
  responsesTextCharge,
  type ResponsesJsonTarget,
  type ResponsesGraphStats,
} from "./responsesResources.js";
export type ParsedResponsesFrame = { ok: true; value: unknown; release?: () => void } | { ok: false };
export type ResponsesWorkerRequest =
  | {
      id: number;
      permit: number;
      op: "parse";
      target: ResponsesJsonTarget;
      encoding: "utf8" | "string";
      payload: ArrayBuffer;
    }
  | { id: number; permit: number; op: "serialize"; target: ResponsesJsonTarget };
export type ResponsesWorkerReply = {
  id: number;
  permit: number;
  op: "parse";
  target: ResponsesJsonTarget;
  phase: "prepared" | "reply" | "failure";
  ok?: boolean;
  payload?: ArrayBuffer;
  stats?: ResponsesGraphStats;
  kind?: unknown;
};
interface Pending {
  id: number;
  op: "parse";
  target: ResponsesJsonTarget;
  phase: "prepare" | "reply";
  stats?: ResponsesGraphStats;
  working: ResponsesStoragePermit;
  input?: ResponsesStoragePermit;
  decoderBytes: number;
  resolve: (reply: ParsedResponsesFrame) => void;
  reject: (error: ResponsesValidationInterrupted) => void;
}
export interface ResponsesConsumerOptions {
  signal?: AbortSignal;
  capacity?: ResponsesValidationCapacity;
  reservation?: ResponsesValidationReservation;
  createWorker?: (url: URL, options: WorkerOptions) => Worker;
}

/** Bounded JSON parsing stays off the gateway loop; SDK interpretation belongs to the harness. */
export class ResponsesConsumer {
  private readonly stopControl = new AbortController();
  private readonly signal: AbortSignal;
  private ready?: Promise<void>;
  private worker?: Worker;
  private pending?: Pending;
  private release?: () => void;
  private stopped = false;
  private exited = false;
  private sequence = 0;
  private failure?: ResponsesValidationInterrupted;
  private shutdown?: Promise<void>;
  private readonly storage = new Set<ResponsesStoragePermit>();
  private readonly parentGraphs = new Set<ResponsesStoragePermit>();
  constructor(
    _modelId: string,
    private readonly options: ResponsesConsumerOptions = {},
  ) {
    this.signal = options.signal ? AbortSignal.any([options.signal, this.stopControl.signal]) : this.stopControl.signal;
    this.signal.addEventListener("abort", this.onAbort, { once: true });
  }
  private readonly onAbort = (): void => {
    this.interrupt(new ResponsesValidationInterrupted("aborted"));
    void this.dispose();
  };
  private interrupt(error: ResponsesValidationInterrupted): void {
    this.failure ??= error;
    this.pending?.reject(this.failure);
    this.pending = undefined;
  }
  private assertReady(): void {
    if (this.failure) throw this.failure;
    if (this.stopped || this.signal.aborted) throw new ResponsesValidationInterrupted("aborted");
  }
  private async start(): Promise<void> {
    const release = await (this.options.capacity ?? responsesValidationCapacity).acquire(this.signal);
    if (this.stopped || this.signal.aborted) {
      release();
      throw new ResponsesValidationInterrupted("aborted");
    }
    this.release = release;
    const source = import.meta.url.endsWith(".ts");
    try {
      const worker = (this.options.createWorker ?? ((url, options) => new Worker(url, options)))(
        new URL(source ? "./responsesConsumerWorker.ts" : "./responsesConsumerWorker.js", import.meta.url),
        {
          env: {},
          execArgv: source ? ["--import", "tsx"] : [],
          resourceLimits: {
            maxOldGenerationSizeMb: RESPONSES_VALIDATION_LIMITS.oldGenerationMb,
            maxYoungGenerationSizeMb: RESPONSES_VALIDATION_LIMITS.youngGenerationMb,
            stackSizeMb: RESPONSES_VALIDATION_LIMITS.stackMb,
          },
        },
      );
      this.worker = worker;
      await new Promise<void>((resolve, reject) => {
        let booted = false;
        worker.on("message", (message: unknown) => {
          const reply =
            typeof message === "object" && message !== null && !Array.isArray(message)
              ? (message as Record<string, unknown>)
              : undefined;
          if (reply?.ready === true && !booted) {
            if (Object.keys(reply).length !== 1) {
              this.interrupt(new ResponsesValidationInterrupted("protocol"));
              void this.dispose();
              return;
            }
            booted = true;
            resolve();
            return;
          }
          try {
            const pending = this.pending;
            if (
              reply &&
              Object.keys(reply).some(
                (key) => !["id", "op", "target", "permit", "phase", "stats", "ok", "payload", "kind"].includes(key),
              )
            )
              throw new ResponsesValidationInterrupted("protocol");
            if (
              !reply ||
              !pending ||
              reply.id !== pending.id ||
              reply.op !== pending.op ||
              reply.target !== pending.target ||
              reply.permit !== pending.working.id
            )
              throw new ResponsesValidationInterrupted("protocol");
            if (reply.phase === "failure") {
              const kinds = [
                "aborted",
                "capacity",
                "worker-error",
                "worker-exit",
                "protocol",
                "frame-bytes",
                "stream-bytes",
                "fields",
                "output-bytes",
                "graph",
                "ipc-bytes",
                "storage",
              ];
              if (typeof reply.kind !== "string" || !kinds.includes(reply.kind))
                throw new ResponsesValidationInterrupted("protocol");
              throw new ResponsesValidationInterrupted(
                reply.kind as import("./responsesValidationCapacity.js").ValidationInterruption,
              );
            }
            if (reply.phase === "prepared") {
              if (
                pending.op !== "parse" ||
                pending.phase !== "prepare" ||
                !validResponsesStats(reply.stats, pending.target)
              )
                throw new ResponsesValidationInterrupted("protocol");
              pending.stats = reply.stats;
              // Atomic resize: a failed swap leaves the old parse permit held
              // until actual worker exit. The graph never gets a free gap.
              pending.working.resize(
                pending.decoderBytes +
                  responsesGraphCharge(reply.stats) +
                  responsesSerializationWorking(pending.target),
              );
              pending.working.transfer("worker-serialization");
              pending.phase = "reply";
              worker.postMessage({
                id: pending.id,
                op: "serialize",
                target: pending.target,
                permit: pending.working.id,
              });
              return;
            }
            if (
              reply.phase !== "reply" ||
              (pending.phase !== "reply" && !(pending.op === "parse" && reply.ok === false))
            )
              throw new ResponsesValidationInterrupted("protocol");
            {
              if (typeof reply.ok !== "boolean") throw new ResponsesValidationInterrupted("protocol");
              if (!reply.ok) {
                this.pending = undefined;
                this.drop(pending.input);
                this.drop(pending.working);
                pending.resolve({ ok: false });
                return;
              }
              if (
                !pending.stats ||
                !validResponsesStats(reply.stats, pending.target) ||
                reply.stats.entries !== pending.stats.entries ||
                reply.stats.depth !== pending.stats.depth ||
                reply.stats.units !== pending.stats.units
              )
                throw new ResponsesValidationInterrupted("protocol");
              validateResponsesPayload(reply.payload, pending.target);
              pending.working.resize(responsesGraphMaximum(pending.target) + reply.payload.byteLength);
              pending.working.transfer("parent-deserialization");
              const value = unpackResponsesValue(reply.payload, pending.target),
                stats = inspectResponsesGraph(value, pending.target);
              if (
                stats.entries !== pending.stats.entries ||
                stats.depth !== pending.stats.depth ||
                stats.units !== pending.stats.units
              )
                throw new ResponsesValidationInterrupted("protocol");
              pending.working.resize(responsesGraphCharge(stats));
              pending.working.transfer("parent-graph");
              this.parentGraphs.add(pending.working);
              this.drop(pending.input);
              this.pending = undefined;
              const parsed: ParsedResponsesFrame = { ok: true, value };
              Object.defineProperty(parsed, "release", { value: () => this.drop(pending.working) });
              pending.resolve(parsed);
              return;
            }
          } catch (error) {
            this.interrupt(
              error instanceof ResponsesValidationInterrupted ? error : new ResponsesValidationInterrupted("protocol"),
            );
            void this.dispose();
          }
        });
        worker.once("error", () => {
          const error = new ResponsesValidationInterrupted("worker-error");
          this.interrupt(error);
          reject(error);
        });
        worker.once("exit", () => {
          this.exited = true;
          this.dropWorkerStorage();
          this.release?.();
          this.release = undefined;
          if (!this.stopped) this.interrupt(new ResponsesValidationInterrupted("worker-exit"));
          if (!booted) reject(this.failure ?? new ResponsesValidationInterrupted("worker-exit"));
        });
      });
    } catch (error) {
      if (!this.worker) {
        release();
        this.release = undefined;
      }
      throw error instanceof ResponsesValidationInterrupted
        ? error
        : new ResponsesValidationInterrupted("worker-error");
    }
  }
  private reserve(bytes: number, owner: string): ResponsesStoragePermit {
    const permit = (this.options.reservation ?? this.options.capacity ?? responsesValidationCapacity).reserveStorage(
      bytes,
      owner,
    );
    this.storage.add(permit);
    permit.onRelease(() => {
      this.storage.delete(permit);
      this.parentGraphs.delete(permit);
    });
    return permit;
  }
  private drop(permit?: ResponsesStoragePermit): void {
    if (!permit) return;
    permit.release();
    this.storage.delete(permit);
    this.parentGraphs.delete(permit);
  }
  private dropWorkerStorage(): void {
    // Parent graph ownership may outlive the worker; its explicit release or
    // the transport reservation settles it. All other in-flight permits stay
    // owned through the actual exit, including failed prepared swaps.
    for (const permit of [...this.storage]) if (!this.parentGraphs.has(permit)) this.drop(permit);
  }
  private async operation(
    op: "parse",
    target: ResponsesJsonTarget,
    payload?: ArrayBuffer,
    encoding?: "utf8" | "string",
    decoderBytes = 0,
    working?: ResponsesStoragePermit,
    input?: ResponsesStoragePermit,
  ): Promise<ParsedResponsesFrame> {
    this.assertReady();
    this.ready ??= this.start();
    await this.ready;
    this.assertReady();
    if (this.pending) throw new ResponsesValidationInterrupted("protocol");
    working ??= this.reserve(0, "worker-parse");
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending = {
        id,
        op,
        target,
        phase: "prepare",
        working,
        input,
        decoderBytes,
        resolve,
        reject,
      };
      try {
        const request = {
          id,
          op,
          target,
          permit: working.id,
          ...(payload ? { payload } : {}),
          ...(encoding ? { encoding } : {}),
        };
        if (input) input.transfer("worker-input");
        this.worker!.postMessage(request, payload ? [payload] : []);
      } catch {
        this.interrupt(new ResponsesValidationInterrupted("protocol"));
        void this.dispose();
      }
    });
  }
  async parseJSON(data: string, target: ResponsesJsonTarget = "frame"): Promise<ParsedResponsesFrame> {
    this.assertReady();
    const decoderBytes = responsesTextCharge(data);
    const encode = this.reserve(responsesSerializationWorking(target), "parent-input-serialization");
    let input: ResponsesStoragePermit | undefined, working: ResponsesStoragePermit | undefined;
    try {
      const payload = packResponsesValue(data, target);
      // The serialization permit already owns this output allocation. Give
      // its actual backing an input permit before dropping temporary credit.
      input = this.reserve(payload.byteLength, "parent-input");
      this.drop(encode);
      working = this.reserve(RESPONSES_VALIDATION_LIMITS.parserWorkingBytes + decoderBytes, "worker-parse");
      return (await this.operation(
        "parse",
        target,
        payload,
        "string",
        decoderBytes,
        working,
        input,
      )) as ParsedResponsesFrame;
    } catch (error) {
      if (!this.worker || this.exited) {
        this.drop(working);
        this.drop(input);
      }
      this.drop(encode);
      throw error;
    }
  }
  async parseBytes(
    payload: ArrayBuffer,
    target: ResponsesJsonTarget,
    ownedInput?: ResponsesStoragePermit,
  ): Promise<ParsedResponsesFrame> {
    this.assertReady();
    validateResponsesPayload(payload, target);
    const decoderBytes = payload.byteLength * 2 + RESPONSES_VALIDATION_LIMITS.stringHeaderBytes;
    let working: ResponsesStoragePermit | undefined, input: ResponsesStoragePermit | undefined;
    try {
      working = this.reserve(RESPONSES_VALIDATION_LIMITS.parserWorkingBytes + decoderBytes, "worker-parse");
      input = ownedInput ?? this.reserve(payload.byteLength, "parent-input");
      this.storage.add(input);
      return (await this.operation(
        "parse",
        target,
        payload,
        "utf8",
        decoderBytes,
        working,
        input,
      )) as ParsedResponsesFrame;
    } catch (error) {
      if (!this.worker || this.exited) {
        this.drop(working);
        this.drop(input);
      }
      throw error;
    }
  }
  /** EOF checks the neutral parser's latched outcome before cleanup hides it. */
  async finish(): Promise<void> {
    try {
      this.assertReady();
    } finally {
      await this.dispose();
    }
    if (this.options.signal?.aborted) throw new ResponsesValidationInterrupted("aborted");
  }

  dispose(): Promise<void> {
    this.shutdown ??= (async () => {
      this.stopped = true;
      this.signal.removeEventListener("abort", this.onAbort);
      this.stopControl.abort();
      this.interrupt(new ResponsesValidationInterrupted("aborted"));
      if (this.worker && !this.exited) await this.worker.terminate();
      // A cancelled queue acquisition either owned no slot or releases it on start.
      await this.ready?.catch(() => {});
      if (!this.worker) for (const permit of [...this.storage]) this.drop(permit);
    })();
    return this.shutdown;
  }
}
