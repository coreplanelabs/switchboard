import type { StatusUpdate } from "./types.js";

/** An internal worker's conversation and progress. No platform message id or URL is needed. */
export type PrivateWorkerEventInput =
  | { kind: "input"; id: string; sender: string; text: string; at: number }
  | { kind: "reply"; id?: string; text: string; at: number; runId?: string }
  | { kind: "status"; phase: "start"; frame: StatusUpdate; at: number }
  | { kind: "status"; phase: "update" | "done"; statusSeq: number; frame: StatusUpdate; at: number };

export type PrivateWorkerEvent = PrivateWorkerEventInput & { seq: number; statusSeq?: number };

export const PRIVATE_WORKER_EVENT_MAX_CHARS = 32_000;

const frame = (value: unknown): boolean =>
  typeof value === "object" && value !== null && typeof (value as { title?: unknown }).title === "string";

/** Bound stored worker prose and reject malformed rows at the persistence door. */
export function isPrivateWorkerEventInput(value: unknown): value is PrivateWorkerEventInput {
  if (typeof value !== "object" || value === null || JSON.stringify(value).length > PRIVATE_WORKER_EVENT_MAX_CHARS)
    return false;
  const row = value as Record<string, unknown>;
  if (typeof row.at !== "number" || !Number.isFinite(row.at)) return false;
  if (row.kind === "input")
    return (
      typeof row.id === "string" &&
      row.id.length > 0 &&
      row.id.length <= 256 &&
      typeof row.sender === "string" &&
      row.sender.length > 0 &&
      row.sender.length <= 256 &&
      typeof row.text === "string"
    );
  if (row.kind === "reply")
    return (
      typeof row.text === "string" &&
      (row.id === undefined || (typeof row.id === "string" && row.id.length > 0 && row.id.length <= 256)) &&
      (row.runId === undefined || typeof row.runId === "string")
    );
  if (row.kind === "status")
    return (
      (row.phase === "start" || row.phase === "update" || row.phase === "done") &&
      frame(row.frame) &&
      (row.phase === "start" || (Number.isSafeInteger(row.statusSeq) && (row.statusSeq as number) > 0))
    );
  return false;
}

export function isPrivateWorkerEvent(value: unknown): value is PrivateWorkerEvent {
  if (!isPrivateWorkerEventInput(value)) return false;
  const row = value as PrivateWorkerEvent;
  return (
    Number.isSafeInteger(row.seq) &&
    row.seq > 0 &&
    (row.kind !== "status" || (Number.isSafeInteger(row.statusSeq) && row.statusSeq! > 0))
  );
}

/** The production implementation must persist this log outside the bot process. */
export interface PrivateWorkerLog {
  /** Assigns one monotonic sequence per thread. A repeated input or settlement id returns its original row. */
  append(threadKey: string, event: PrivateWorkerEventInput): Promise<PrivateWorkerEvent>;
  /** Complete oldest-first thread history, including progress frames. */
  list(threadKey: string): Promise<PrivateWorkerEvent[]>;
}

/** Test implementation; never used as a production fallback. */
export class InMemoryPrivateWorkerLog implements PrivateWorkerLog {
  private readonly rows = new Map<string, PrivateWorkerEvent[]>();

  async append(threadKey: string, event: PrivateWorkerEventInput): Promise<PrivateWorkerEvent> {
    const rows = this.rows.get(threadKey) ?? [];
    if ((event.kind === "input" || event.kind === "reply") && event.id !== undefined) {
      const prior = rows.find((row) => (row.kind === "input" || row.kind === "reply") && row.id === event.id);
      if (prior !== undefined) {
        const same =
          prior.kind === event.kind &&
          (event.kind === "input"
            ? prior.kind === "input" && prior.sender === event.sender && prior.text === event.text
            : prior.kind === "reply" && prior.text === event.text && prior.runId === event.runId);
        if (!same) throw new Error("private worker event id reused with different content");
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
