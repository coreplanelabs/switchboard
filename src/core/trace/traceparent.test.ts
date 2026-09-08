// Feature: features/tracing.md — strict W3C trace context.
import { describe, expect, it } from "vitest";
import { formatTraceparent, parseTraceparent } from "./traceparent.js";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";

describe("parseTraceparent", () => {
  it("accepts the W3C example and reads the sampled flag", () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)).toEqual({ traceId: TRACE, parentId: SPAN, sampled: true });
    expect(parseTraceparent(` 00-${TRACE}-${SPAN}-00 `)).toEqual({ traceId: TRACE, parentId: SPAN, sampled: false });
  });

  it("rejects other versions, uppercase, wrong lengths, all-zero ids and non-strings", () => {
    for (const bad of [
      `01-${TRACE}-${SPAN}-01`,
      `00-${TRACE.toUpperCase()}-${SPAN}-01`,
      `00-${TRACE.slice(1)}-${SPAN}-01`,
      `00-${TRACE}-${SPAN.slice(1)}-01`,
      `00-${"0".repeat(32)}-${SPAN}-01`,
      `00-${TRACE}-${"0".repeat(16)}-01`,
      `00-${TRACE}-${SPAN}-01-extra`,
      "",
    ]) {
      expect(parseTraceparent(bad), bad).toBeUndefined();
    }
    expect(parseTraceparent(null)).toBeUndefined();
    expect(parseTraceparent(undefined)).toBeUndefined();
  });

  it("formatTraceparent round-trips", () => {
    expect(parseTraceparent(formatTraceparent(TRACE, SPAN))).toEqual({ traceId: TRACE, parentId: SPAN, sampled: true });
    expect(formatTraceparent(TRACE, SPAN, false)).toBe(`00-${TRACE}-${SPAN}-00`);
  });
});
