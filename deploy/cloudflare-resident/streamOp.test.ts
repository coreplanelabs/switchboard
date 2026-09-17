import { describe, expect, it } from "vitest";
import { readSource } from "./testing/sourceScan";
import { threadErrBuilders, type ThrowPredicates } from "./threadErr";

// Feature: docs/reference/specs/execution.md item 9 — `/op`'s streamed failure
// document carries its `status` in the body as `/exec`'s does, so the client
// reads it by the one rule (`answeredStatus`) and judges `transient` by the
// one rule (`isTransientRefusal`). The client's own tests stub the body they
// expect; this pins the Worker's half — the document `streamOp` streams is the
// one `catchAllErr` builds, passed through unchanged — so a later mapping that
// shed a field could not silently re-open the deploy-skew path the client's
// dated clause exists for. The Worker imports `cloudflare:workers`, so the
// wiring is pinned by a source scan and the document by the Node-loadable
// builder, as notServiceable.test.ts and threadErr.test.ts do.

const source = readSource("worker.ts");

describe("streamOp — the streamed failure document carries its status", () => {
  it("streams the op's result as it is and a rejection as `catchAllErr(err, \"op-failed\")`'s document, with no mapping between that could shed a field", () => {
    const streamOp =
      /function streamOp\([^)]*\): Response \{\s*return streamHeartbeatJson\(\s*pending,\s*\(result\) => result,\s*\(err\) => catchAllErr\(err, "op-failed"\),?\s*\);\s*\}/;
    expect(source).toMatch(streamOp);
  });

  it("the stream helper writes the mapped payload itself, sanitized and whole — one JSON document, never a projection of it", () => {
    expect(source).toMatch(/\.then\(\(result\) => finish\(sanitizeResidentBody\(toPayload\(result\)\)\)\)/);
    expect(source).toMatch(/\.catch\(\(err: unknown\) => finish\(sanitizeResidentBody\(toErrorPayload\(err\)\)\)\)/);
    expect(source).toMatch(/controller\.enqueue\(encoder\.encode\(JSON\.stringify\(payload\)\)\)/);
  });

  it("the document a rejected op streams carries `status` beside its `error` — the field the client's `answeredStatus` reads — for a throw no route named and for a transient one", () => {
    const never: ThrowPredicates = {
      isControlReset: () => false,
      isRuntimeReplacement: () => false,
      sdkVouchesRuntimeMoved: () => false,
      isPlatformTransientError: () => false,
    };
    const { catchAllErr } = threadErrBuilders(never);
    const untyped = catchAllErr(new Error("boom"), "op-failed") as Record<string, unknown>;
    expect(untyped.status).toBe(500);
    expect(String(untyped.error)).toMatch(/^op-failed/);
    expect(untyped.transient).not.toBe(true);
    const { catchAllErr: typing } = threadErrBuilders({ ...never, isPlatformTransientError: () => true });
    const transient = typing(new Error("Network connection lost."), "op-failed") as Record<string, unknown>;
    expect(transient.status).toBe(500);
    expect(transient.transient).toBe(true);
  });
});
