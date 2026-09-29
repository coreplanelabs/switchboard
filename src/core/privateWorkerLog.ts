import type { StatusUpdate } from "./types.js";

/** An internal worker's conversation and progress. No platform message id or URL is needed. */
export type PrivateWorkerEventInput =
  | { kind: "input"; id: string; sender: string; text: string; at: number }
  | { kind: "reply"; text: string; at: number; runId?: string }
  | { kind: "status"; phase: "start"; frame: StatusUpdate; at: number }
  | { kind: "status"; phase: "update" | "done"; statusSeq: number; frame: StatusUpdate; at: number };

export type PrivateWorkerEvent = PrivateWorkerEventInput & { seq: number; statusSeq?: number };

/** The production implementation must persist this log outside the bot process. */
export interface PrivateWorkerLog {
  /** Assigns one monotonic sequence per thread. A repeated input id returns its original row. */
  append(threadKey: string, event: PrivateWorkerEventInput): Promise<PrivateWorkerEvent>;
  /** Complete oldest-first thread history, including progress frames. */
  list(threadKey: string): Promise<PrivateWorkerEvent[]>;
}

/** Test implementation; never used as a production fallback. */
export class InMemoryPrivateWorkerLog implements PrivateWorkerLog {
  private readonly rows = new Map<string, PrivateWorkerEvent[]>();

  async append(threadKey: string, event: PrivateWorkerEventInput): Promise<PrivateWorkerEvent> {
    const rows = this.rows.get(threadKey) ?? [];
    if (event.kind === "input") {
      const prior = rows.find((row) => row.kind === "input" && row.id === event.id);
      if (prior !== undefined) {
        if (JSON.stringify({ ...prior, seq: undefined }) !== JSON.stringify({ ...event, seq: undefined }))
          throw new Error("private worker input id reused with different content");
        return structuredClone(prior);
      }
    }
    const seq = (rows.at(-1)?.seq ?? 0) + 1;
    const row: PrivateWorkerEvent = {
      ...structuredClone(event),
      seq,
      ...(event.kind === "status" && event.phase === "start" ? { statusSeq: seq } : {}),
    };
    rows.push(row);
    this.rows.set(threadKey, rows);
    return structuredClone(row);
  }

  async list(threadKey: string): Promise<PrivateWorkerEvent[]> {
    return structuredClone(this.rows.get(threadKey) ?? []);
  }
}

/** Fail closed until the durable Worker-backed implementation is wired. */
export class UnavailablePrivateWorkerLog implements PrivateWorkerLog {
  async append(_threadKey: string, _event: PrivateWorkerEventInput): Promise<PrivateWorkerEvent> {
    throw new Error("private worker log unavailable");
  }

  async list(_threadKey: string): Promise<PrivateWorkerEvent[]> {
    throw new Error("private worker log unavailable");
  }
}
