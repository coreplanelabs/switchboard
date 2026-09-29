import type { StatusUpdate } from "./types.js";
import { INSTANCE_ID_PATTERN } from "./coordinator/contract.js";

export interface PrivateWorkerIdentity {
  instanceId: string;
  unit: string;
}

const UNIT_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Stable across bot generations; never a Slack thread key. */
export function privateWorkerThreadKey(identity: PrivateWorkerIdentity): string {
  if (!INSTANCE_ID_PATTERN.test(identity.instanceId) || !UNIT_ID_PATTERN.test(identity.unit))
    throw new Error("invalid private worker identity");
  return `worker:${identity.instanceId}:${identity.unit}`;
}

/** Only an exact internal key can be rebuilt after a bot restart. */
export function parsePrivateWorkerThreadKey(threadKey: string): PrivateWorkerIdentity | undefined {
  const match = /^worker:([^:]+):([^:]+)$/.exec(threadKey);
  if (!match || !INSTANCE_ID_PATTERN.test(match[1]!) || !UNIT_ID_PATTERN.test(match[2]!)) return undefined;
  return { instanceId: match[1]!, unit: match[2]! };
}

/** An internal worker's conversation and progress. No platform message id or URL is needed. */
export type PrivateWorkerEventInput =
  | { kind: "input"; id: string; sender: string; text: string; at: number; textSha256?: string }
  | { kind: "reply"; id?: string; text: string; at: number; runId?: string }
  | { kind: "status"; phase: "start"; frame: StatusUpdate; at: number }
  | { kind: "status"; phase: "update" | "done"; statusSeq: number; frame: StatusUpdate; at: number };

export type PrivateWorkerEvent = PrivateWorkerEventInput & { seq: number; statusSeq?: number };

export const PRIVATE_WORKER_EVENT_MAX_CHARS = 32_000;
// A coordinator unit report can contain 20,000 characters. JSON can escape
// each control character as six characters, so its private copy needs room.
export const PRIVATE_WORKER_REPLY_MAX_CHARS = 128_000;

const frame = (value: unknown): boolean =>
  typeof value === "object" && value !== null && typeof (value as { title?: unknown }).title === "string";

/** Bound stored worker prose and reject malformed rows at the persistence door. */
export function isPrivateWorkerEventInput(value: unknown): value is PrivateWorkerEventInput {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  const limit = row.kind === "reply" ? PRIVATE_WORKER_REPLY_MAX_CHARS : PRIVATE_WORKER_EVENT_MAX_CHARS;
  // Admission must leave room for the sequence fields the state Worker adds;
  // otherwise it could write a row that its own read path rejects.
  const storedShape = {
    ...row,
    seq: Number.MAX_SAFE_INTEGER,
    ...(row.kind === "status" && row.phase === "start" ? { statusSeq: Number.MAX_SAFE_INTEGER } : {}),
  };
  if (JSON.stringify(storedShape).length > limit) return false;
  if (typeof row.at !== "number" || !Number.isFinite(row.at)) return false;
  if (row.kind === "input")
    return (
      typeof row.id === "string" &&
      row.id.length > 0 &&
      row.id.length <= 256 &&
      typeof row.sender === "string" &&
      row.sender.length > 0 &&
      row.sender.length <= 256 &&
      typeof row.text === "string" &&
      (row.textSha256 === undefined || (typeof row.textSha256 === "string" && /^[0-9a-f]{64}$/.test(row.textSha256)))
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
  /** Read at most `limit` rows after a durable sequence, without loading the full log. */
  listAfter(
    threadKey: string,
    afterSeq: number,
    limit: number,
  ): Promise<{ events: PrivateWorkerEvent[]; more: boolean }>;
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
            ? prior.kind === "input" &&
              prior.sender === event.sender &&
              prior.text === event.text &&
              prior.textSha256 === event.textSha256
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

  async listAfter(
    threadKey: string,
    afterSeq: number,
    limit: number,
  ): Promise<{ events: PrivateWorkerEvent[]; more: boolean }> {
    const rows = (this.rows.get(threadKey) ?? []).filter((row) => row.seq > afterSeq);
    return { events: structuredClone(rows.slice(0, limit)), more: rows.length > limit };
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

  async listAfter(
    _threadKey: string,
    _afterSeq: number,
    _limit: number,
  ): Promise<{ events: PrivateWorkerEvent[]; more: boolean }> {
    throw new Error("private worker log unavailable");
  }
}
