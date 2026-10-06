import { RESPONSES_VALIDATION_LIMITS } from "../core/budgets.js";

export type ValidationInterruption =
  | "aborted"
  | "capacity"
  | "worker-error"
  | "worker-exit"
  | "protocol"
  | "frame-bytes"
  | "stream-bytes"
  | "fields"
  | "output-bytes"
  | "graph"
  | "ipc-bytes"
  | "storage";
export class ResponsesValidationInterrupted extends Error {
  readonly name = "ResponsesValidationInterrupted";
  constructor(readonly kind: ValidationInterruption) {
    super(`Responses validation interrupted: ${kind}`);
  }
}

type Waiter = { grant: (release: () => void) => void; cancel: () => void; signal?: AbortSignal };

/** Ephemeral CPU resources. A lease buys no run, time, turn or retry authority. */
export class ResponsesValidationCapacity {
  private active = 0;
  private readonly waiting: Waiter[] = [];
  private storage = 0;
  private storageSequence = 0;
  constructor(private readonly limits: { workers: number; queued: number } = RESPONSES_VALIDATION_LIMITS) {}
  get activeCount(): number {
    return this.active;
  }
  get queuedCount(): number {
    return this.waiting.length;
  }

  get storageBytes(): number {
    return this.storage;
  }

  reserveStorage(bytes: number, owner: string): ResponsesStoragePermit {
    const change = (delta: number) => {
      if (!Number.isSafeInteger(delta) || this.storage + delta < 0)
        throw new ResponsesValidationInterrupted("protocol");
      if (this.storage + delta > RESPONSES_VALIDATION_LIMITS.managedStorageBytes)
        throw new ResponsesValidationInterrupted("storage");
      this.storage += delta;
    };
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new ResponsesValidationInterrupted("protocol");
    change(bytes);
    return new ResponsesStoragePermit(++this.storageSequence, bytes, owner, change);
  }

  async reserve(signal?: AbortSignal, onQueued?: () => void): Promise<ResponsesValidationReservation> {
    const release = await this.acquire(signal, onQueued);
    try {
      return new ResponsesValidationReservation(this, release);
    } catch (error) {
      release();
      throw error;
    }
  }

  acquire(signal?: AbortSignal, onQueued?: () => void): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new ResponsesValidationInterrupted("aborted"));
    if (this.active < this.limits.workers) {
      this.active++;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.waiting.length >= this.limits.queued)
      return Promise.reject(new ResponsesValidationInterrupted("capacity"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        grant: resolve,
        cancel: () => {
          const at = this.waiting.indexOf(waiter);
          if (at < 0) return;
          this.waiting.splice(at, 1);
          signal?.removeEventListener("abort", waiter.cancel);
          reject(new ResponsesValidationInterrupted("aborted"));
        },
      };
      this.waiting.push(waiter);
      signal?.addEventListener("abort", waiter.cancel, { once: true });
      try {
        onQueued?.();
      } catch {
        // A queue observer cannot replace admission or cancellation.
      }
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        next.signal?.removeEventListener("abort", next.cancel);
        next.grant(this.releaseOnce());
      } else this.active--;
    };
  }
}

/** One transport owns the slot until its consumer and delivery both finish. */
export class ResponsesValidationReservation {
  private adopted = false;
  private validationDone = true;
  private requestDone = true;
  private sources = 0;
  private responseBytes = 0;
  private responseFailure?: ResponsesValidationInterrupted;
  private transportDone = false;
  private released = false;
  readonly capacity: ResponsesValidationCapacity;
  private readonly permits = new Set<ResponsesStoragePermit>();
  private readonly ending: ResponsesStoragePermit;

  constructor(
    private readonly owner: ResponsesValidationCapacity,
    private readonly release: () => void,
  ) {
    this.capacity = new ReservedResponsesValidationCapacity(owner, (signal) => this.adopt(signal));
    this.ending = this.reserveStorage(RESPONSES_VALIDATION_LIMITS.framingSliceBytes, "terminal-output");
  }

  reserveStorage(bytes: number, owner: string): ResponsesStoragePermit {
    if (this.released) throw new ResponsesValidationInterrupted("protocol");
    const permit = this.owner.reserveStorage(bytes, owner);
    this.permits.add(permit);
    permit.onRelease(() => this.permits.delete(permit));
    return permit;
  }
  get liveStoragePermits(): number {
    return this.permits.size;
  }
  claimEndingStorage(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.ending.bytes)
      throw new ResponsesValidationInterrupted("output-bytes");
    this.ending.transfer("authenticated-ending-output");
  }

  finishTransport(): void {
    this.transportDone = true;
    this.settle();
  }

  beginRequest(): void {
    if (this.released || !this.requestDone) throw new ResponsesValidationInterrupted("protocol");
    this.requestDone = false;
  }

  finishRequest(): void {
    this.requestDone = true;
    this.settle();
  }

  beginSource(): void {
    if (this.released) throw new ResponsesValidationInterrupted("protocol");
    this.sources++;
  }

  finishSource(): void {
    if (this.sources > 0) this.sources--;
    this.settle();
  }

  countResponseBytes(bytes: number): void {
    if (this.responseFailure) throw this.responseFailure;
    if (this.responseBytes + bytes > RESPONSES_VALIDATION_LIMITS.responseBytes) {
      this.responseFailure = new ResponsesValidationInterrupted("stream-bytes");
      throw this.responseFailure;
    }
    this.responseBytes += bytes;
  }

  stopResponse(error: ResponsesValidationInterrupted): void {
    this.responseFailure ??= error;
  }

  get responseInterruption(): ResponsesValidationInterrupted | undefined {
    return this.responseFailure;
  }

  private adopt(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new ResponsesValidationInterrupted("aborted"));
    if (this.adopted || this.released) return Promise.reject(new ResponsesValidationInterrupted("protocol"));
    this.adopted = true;
    this.validationDone = false;
    let done = false;
    return Promise.resolve(() => {
      if (done) return;
      done = true;
      this.validationDone = true;
      this.settle();
    });
  }

  private settle(): void {
    if (this.released || !this.requestDone || this.sources !== 0 || !this.transportDone || !this.validationDone) return;
    this.released = true;
    for (const permit of this.permits) permit.release();
    this.permits.clear();
    this.release();
  }
}

/** The existing consumer adopts this reservation instead of taking another. */
class ReservedResponsesValidationCapacity extends ResponsesValidationCapacity {
  constructor(
    private readonly owner: ResponsesValidationCapacity,
    private readonly adoption: (signal?: AbortSignal) => Promise<() => void>,
  ) {
    super();
  }
  override get activeCount(): number {
    return this.owner.activeCount;
  }
  override get queuedCount(): number {
    return this.owner.queuedCount;
  }
  override acquire(signal?: AbortSignal): Promise<() => void> {
    return this.adoption(signal);
  }
  override get storageBytes(): number {
    return this.owner.storageBytes;
  }
  override reserveStorage(bytes: number, owner: string): ResponsesStoragePermit {
    return this.owner.reserveStorage(bytes, owner);
  }
}

/** A deterministic policy charge. Transfer never creates a free-credit gap. */
export class ResponsesStoragePermit {
  private done = false;
  private readonly callbacks: Array<() => void> = [];
  constructor(
    readonly id: number,
    private size: number,
    private owner: string,
    private readonly change: (delta: number) => void,
  ) {}
  get bytes(): number {
    return this.size;
  }
  resize(bytes: number): void {
    if (this.done || !Number.isSafeInteger(bytes) || bytes < 0) throw new ResponsesValidationInterrupted("protocol");
    this.change(bytes - this.size);
    this.size = bytes;
  }
  transfer(owner: string): void {
    if (this.done) throw new ResponsesValidationInterrupted("protocol");
    this.owner = owner;
  }
  onRelease(callback: () => void): void {
    if (this.done) callback();
    else this.callbacks.push(callback);
  }
  release(): void {
    if (this.done) return;
    this.done = true;
    this.change(-this.size);
    this.size = 0;
    for (const callback of this.callbacks) callback();
    this.callbacks.length = 0;
  }
}

export const responsesValidationCapacity = new ResponsesValidationCapacity();
