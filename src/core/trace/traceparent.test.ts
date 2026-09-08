// Feature: features/tracing.md — strict W3C trace context.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatTraceparent, parseTraceparent } from "./traceparent.js";
import { TRACE_CONTEXT_HEADERS } from "./traceparent.js";

/** The W3C Trace Context specification's own example trace id and parent span id. */
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
// Feature: features/tracing.md item 21 — a container edge ignores an inbound
// trace context unconditionally: no adapter has a code path that reads one.
describe("the container edges", () => {
  it("never read traceparent, tracestate or baggage — the root they mint is theirs", () => {
    const edges = ["src/channels/http.ts", "src/channels/mcp.ts", "src/channels/slack.ts", "src/channels/liveView.ts"];
    for (const file of edges) {
      const source = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
      for (const header of TRACE_CONTEXT_HEADERS) expect(source, `${file} mentions ${header}`).not.toContain(header);
    }
  });
});
