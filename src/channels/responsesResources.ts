import { serialize, deserialize } from "node:v8";
import { RESPONSES_VALIDATION_LIMITS as limits } from "../core/budgets.js";
import { ResponsesValidationInterrupted } from "./responsesValidationCapacity.js";

export type ResponsesJsonTarget = "request" | "frame" | "buffered" | "error";
export interface ResponsesGraphStats {
  entries: number;
  depth: number;
  units: number;
}
export const responsesIpcLimit = (target: ResponsesJsonTarget): number =>
  target === "request" ? limits.requestIpcBytes : limits.responseIpcBytes;
export const responsesStringLimit = (target: ResponsesJsonTarget): number =>
  target === "request" ? limits.requestStringBytes : limits.responseStringBytes;
export const responsesGraphMaximum = (target: ResponsesJsonTarget): number =>
  limits.graphEntries * limits.graphEntryBytes + responsesStringLimit(target);
export const responsesSerializationWorking = (target: ResponsesJsonTarget): number =>
  3 * responsesIpcLimit(target) + limits.serializationSlackBytes;
export const responsesGraphCharge = (stats: ResponsesGraphStats): number =>
  stats.entries * limits.graphEntryBytes + stats.units * 2;
export const responsesTextCharge = (text: string): number => text.length * 2 + limits.stringHeaderBytes;

export function validResponsesStats(value: unknown, target: ResponsesJsonTarget): value is ResponsesGraphStats {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 3) return false;
  return (
    Number.isSafeInteger(row.entries) &&
    Number(row.entries) >= 1 &&
    Number(row.entries) <= limits.graphEntries &&
    Number.isSafeInteger(row.depth) &&
    Number(row.depth) >= 1 &&
    Number(row.depth) <= limits.graphDepth &&
    Number.isSafeInteger(row.units) &&
    Number(row.units) >= 0 &&
    Number(row.units) * 2 <= responsesStringLimit(target)
  );
}

/** Counts storage, never SDK/provider meaning. Opaque argument strings stay whole. */
export function inspectResponsesGraph(value: unknown, target: ResponsesJsonTarget): ResponsesGraphStats {
  const stats: ResponsesGraphStats = { entries: 0, depth: 0, units: 0 };
  type Cursor = { value: unknown; depth: number; keys?: Iterator<string>; index?: number };
  const stack: Cursor[] = [{ value, depth: 1 }];
  const seen = new Set<object>();
  const text = (value: string) => {
    stats.units += value.length;
    if (stats.units * 2 > responsesStringLimit(target)) throw new ResponsesValidationInterrupted("graph");
  };
  while (stack.length) {
    const cursor = stack[stack.length - 1];
    if (cursor.keys) {
      const next = cursor.keys.next();
      if (next.done) {
        stack.pop();
        continue;
      }
      text(next.value);
      stack.push({ value: (cursor.value as Record<string, unknown>)[next.value], depth: cursor.depth + 1 });
      continue;
    }
    if (cursor.index !== undefined) {
      const array = cursor.value as unknown[];
      if (cursor.index >= array.length) {
        stack.pop();
        continue;
      }
      stack.push({ value: array[cursor.index++], depth: cursor.depth + 1 });
      continue;
    }
    if (++stats.entries > limits.graphEntries || cursor.depth > limits.graphDepth)
      throw new ResponsesValidationInterrupted("graph");
    stats.depth = Math.max(stats.depth, cursor.depth);
    if (typeof cursor.value === "string") text(cursor.value);
    if (cursor.value !== null && typeof cursor.value === "object") {
      if (seen.has(cursor.value)) throw new ResponsesValidationInterrupted("protocol");
      seen.add(cursor.value);
      if (Array.isArray(cursor.value)) {
        cursor.index = 0;
        continue;
      }
      const prototype = Object.getPrototypeOf(cursor.value);
      if (prototype !== Object.prototype && prototype !== null) throw new ResponsesValidationInterrupted("protocol");
      // Enumeration is inside the reserved worker parse/graph phase. Do not
      // materialize a second array of every key before applying the bound.
      cursor.keys = (function* (object: object) {
        for (const key in object) if (Object.hasOwn(object, key)) yield key;
      })(cursor.value);
      continue;
    }
    if (typeof cursor.value === "function" || typeof cursor.value === "symbol" || typeof cursor.value === "bigint")
      throw new ResponsesValidationInterrupted("protocol");
    stack.pop();
  }
  return stats;
}

export function validateResponsesPayload(value: unknown, target: ResponsesJsonTarget): asserts value is ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) throw new ResponsesValidationInterrupted("protocol");
  if (value.byteLength > responsesIpcLimit(target)) throw new ResponsesValidationInterrupted("ipc-bytes");
}

/** Caller reserves native serialization working space BEFORE entering this. */
export function packResponsesValue(value: unknown, target: ResponsesJsonTarget): ArrayBuffer {
  const encoded = serialize(value);
  if (encoded.byteLength > responsesIpcLimit(target)) throw new ResponsesValidationInterrupted("ipc-bytes");
  // Never expose a pooled slab or unrelated bytes. This bounded copy is
  // covered by the serialization working permit; transfer detaches it whole.
  const owned = new Uint8Array(encoded.byteLength);
  owned.set(encoded);
  return owned.buffer;
}

/** Fixed owned-worker integrity is assumed; header/length is not V8 preflight. */
export function unpackResponsesValue(payload: ArrayBuffer, target: ResponsesJsonTarget): unknown {
  validateResponsesPayload(payload, target);
  try {
    const value = deserialize(Buffer.from(payload));
    inspectResponsesGraph(value, target);
    return value;
  } catch (error) {
    throw error instanceof ResponsesValidationInterrupted ? error : new ResponsesValidationInterrupted("protocol");
  }
}
