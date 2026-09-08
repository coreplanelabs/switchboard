/** W3C Trace Context `traceparent` (version 00), strict: exactly
 *  `00-<32 hex>-<16 hex>-<2 hex>`, lowercase, and neither id all zero. Used
 *  only between our own Workers (docs/reference/specs/tracing.md: container edges ignore an
 *  inbound header and mint their own; internal Workers adopt one only inside
 *  their authenticated branch). */

export interface TraceParent {
  traceId: string;
  parentId: string;
  sampled: boolean;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(header: string | null | undefined): TraceParent | undefined {
  if (typeof header !== "string") return undefined;
  const m = TRACEPARENT_RE.exec(header.trim());
  if (!m) return undefined;
  const [, traceId, parentId, flags] = m;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return undefined;
  return { traceId, parentId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(traceId: string, spanId: string, sampled = true): string {
  return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}

/** The three context headers an edge strips or ignores. */
export const TRACE_CONTEXT_HEADERS = ["traceparent", "tracestate", "baggage"] as const;
