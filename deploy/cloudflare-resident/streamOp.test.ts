import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import ts from "typescript";
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
  it("streams the op's result as it is and a rejection as `catchAllErr(err, \"op-failed\")`'s document, with no mapping between that could shed a field", async () => {
    const start = source.indexOf("function streamOp(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}\n", start) + 2);
    const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const predicates: ThrowPredicates = {
      isControlReset: () => false,
      isRuntimeReplacement: () => false,
      sdkVouchesRuntimeMoved: () => false,
      isPlatformTransientError: () => false,
    };
    const { catchAllErr } = threadErrBuilders(predicates);
    const streamOp = runInNewContext(`${compiled}\nstreamOp`, {
      catchAllErr,
      streamHeartbeatJson: async (
        pending: Promise<unknown>,
        answered: (value: unknown) => object,
        threw: (error: unknown) => object,
        correlation: unknown,
      ) => {
        try {
          return { body: answered(await pending), correlation };
        } catch (error) {
          return { body: threw(error), correlation };
        }
      },
    });
    const requestId = "11111111-1111-4111-a111-111111111111";
    const success = { stdout: "", stderr: "", exitCode: 0, truncated: false };
    expect(await streamOp(Promise.resolve(success), requestId)).toEqual({
      body: success,
      correlation: { route: "/op", requestId },
    });
    expect(await streamOp(Promise.reject(new Error("private failure")), requestId)).toMatchObject({
      body: { status: 500, error: expect.stringMatching(/^op-failed/) },
      correlation: { route: "/op", requestId },
    });
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
