import { describe, expect, it } from "vitest";
import {
  inspectResponsesGraph,
  packResponsesValue,
  unpackResponsesValue,
  validateResponsesPayload,
} from "./responsesResources.js";
import { ResponsesValidationCapacity } from "./responsesValidationCapacity.js";

describe("Responses full-value resource protocol", () => {
  it.each(["frame", "request"] as const)("counts exact UTF16 string units for%s before serialization", (target) => {
    const ceiling = target === "request" ? 64 * 1024 * 1024 : 32 * 1024 * 1024;
    const text = "x".repeat(ceiling / 2);
    expect(inspectResponsesGraph(text.slice(1), target).units * 2).toBe(ceiling - 2);
    expect(inspectResponsesGraph(text, target).units * 2).toBe(ceiling);
    expect(() => inspectResponsesGraph(text + "x", target)).toThrow("graph");
  });

  it("preserves full NativeJSON values including negative zero and infinity", () => {
    const value = JSON.parse(
      '{"negative":-0,"large":1e400,"small":-1e400,"text":"\\ud800","args":{"command":"whole"}}',
    );
    const pool = new ResponsesValidationCapacity();
    const permit = pool.reserveStorage(97 * 1024 * 1024, "serializer");
    try {
      const packed = packResponsesValue(value, "frame");
      validateResponsesPayload(packed, "frame");
      const result = unpackResponsesValue(packed, "frame") as typeof value;
      expect(Object.is(result.negative, -0)).toBe(true);
      expect(result.large).toBe(Infinity);
      expect(result.small).toBe(-Infinity);
      expect(result.text).toBe("\ud800");
      expect(result.args.command).toBe("whole");
    } finally {
      permit.release();
    }
  });
  it.each([262143, 262144, 262145])("checks%s graph entries before reply", (entries) => {
    const data = Array(entries - 1).fill(0);
    if (entries > 262144) expect(() => inspectResponsesGraph(data, "frame")).toThrow("graph");
    else expect(inspectResponsesGraph(data, "frame").entries).toBe(entries);
  });
  it.each([127, 128, 129])("checks graph depth%s iteratively", (depth) => {
    let data: unknown = 0;
    for (let at = 1; at < depth; at++) data = { next: data };
    if (depth > 128) expect(() => inspectResponsesGraph(data, "frame")).toThrow("graph");
    else expect(inspectResponsesGraph(data, "frame").depth).toBe(depth);
  });
  it.each(["frame", "request"] as const)(
    "bounds the actual whole IPC backing for %s at its exact ceiling",
    (target) => {
      const ceiling = target === "request" ? 64 * 1024 * 1024 : 32 * 1024 * 1024;
      expect(() => validateResponsesPayload(new ArrayBuffer(ceiling - 1), target)).not.toThrow();
      expect(() => validateResponsesPayload(new ArrayBuffer(ceiling), target)).not.toThrow();
      expect(() => validateResponsesPayload(new ArrayBuffer(ceiling + 1), target)).toThrow("ipc-bytes");
    },
  );
  it("rejects shared or offset backing and oversized encoded payload before unpacking", () => {
    expect(() => validateResponsesPayload(new SharedArrayBuffer(1), "frame")).toThrow("protocol");
    expect(() => validateResponsesPayload(new Uint8Array(new ArrayBuffer(8), 1, 2), "frame")).toThrow("protocol");
    expect(() => validateResponsesPayload(new ArrayBuffer(32 * 1024 * 1024 + 1), "frame")).toThrow("ipc-bytes");
  });
});
