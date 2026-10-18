import { describe, expect, it, vi } from "vitest";
import { failureContextOf, isFailureContext, requestFailureResponse } from "./requestFailure.js";
import { createTracer } from "./trace/tracer.js";
import { recordingSink } from "./testing/recordingSink.js";
import { RunRegistry } from "./runRegistry.js";
import { createRunsService } from "./runsService.js";
import type { RunEvent } from "./runEvents.js";
import { privateMainEvent } from "./privateMainEvent.js";

const TRACE = "1".repeat(32);
const problem = { type: "urn:switchboard:request-failure", status: 500, requestId: TRACE };

function failure(error = problem, at = 1000): RunEvent {
  return {
    type: "run_note",
    kind: "harness_error",
    at,
    summary: "Model call failed",
    failureContext: failureContextOf(error) ?? null,
    modelFailure: {
      kind: "unknown",
      phase: "run",
      stops: { pi: "error", provider: "missing" },
      diagnostic: { source: "unverified", errorMessage: "present", contentParts: 0, error: { ...error } },
    },
  };
}

describe("shared request failure context", () => {
  it("retains only structural failure context through private projection and replay", () => {
    const event = failure();
    if (event.type !== "run_note") throw new Error("Expected a failure note");
    event.summary = "PRIVATE_REQUEST";
    event.modelFailure!.diagnostic.error!.message = "PRIVATE_EXCEPTION";
    const projected = privateMainEvent(event);
    const registry = new RunRegistry();
    const run = registry.create(
      undefined,
      {
        agent: "orchestrator",
        privateConversation: true,
        channelId: "slack:DMAIN",
        userId: "slack:UACTOR",
        threadKey: "slack:DMAIN:1",
      },
      { replay: [{ ...projected, seq: 1 }] },
    );
    expect(registry.getById(run.id)).toMatchObject({ failureContext: { traceId: TRACE, source: "unverified" } });
    expect(registry.snapshotById(run.id)?.events[0]).toMatchObject({
      type: "run_note",
      kind: "follow_up",
      summary: "Private conversation activity",
      failureContext: { traceId: TRACE, source: "unverified" },
    });
    expect(JSON.stringify(registry.snapshotById(run.id))).not.toContain("PRIVATE_");
    expect(projected).not.toHaveProperty("modelFailure");
    registry.publish(run.id, {
      type: "run_note",
      kind: "harness_error",
      summary: "PRIVATE_LATER",
      failureContext: null,
    });
    expect(registry.getById(run.id)).toMatchObject({ failureContext: null });
  });

  it.each([
    { label: "report", error: new SyntaxError("PRIVATE_DECODER_PAYLOAD"), captured: true },
    {
      label: "capture",
      error: {
        get name(): string {
          throw new Error("PRIVATE_CAPTURE_FAILURE");
        },
      },
      captured: false,
    },
  ])(
    "keeps a failed $label private and emits a queryable fallback with the same reference",
    async ({ error, captured }) => {
      const sink = recordingSink();
      const root = createTracer({ clock: () => 1000 }).start("request", { sinks: [sink] });
      const lines: string[] = [];
      const log = vi.spyOn(console, "error").mockImplementation((line: string) => lines.push(line));
      let response: Response;
      try {
        response = requestFailureResponse(root, error, () => {
          throw new Error("PRIVATE_REPORT_FAILURE");
        });
      } finally {
        log.mockRestore();
      }
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        type: "urn:switchboard:request-failure",
        title: "Request failed",
        status: 500,
        request_id: root.traceId,
      });
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        {
          event: "request_failure_report_failed",
          traceId: root.traceId,
          spanId: root.id,
          captured,
        },
      ]);
      expect(sink.ends[0]).toMatchObject({ traceId: root.traceId, status: "error", attrs: { httpStatus: 500 } });
      expect(sink.ends[0].errorMessage).toContain("reporter unavailable");
      expect(sink.ends[0].errorMessage).toContain(captured ? "Stored JSON is unreadable" : "capture unavailable");
      expect(JSON.stringify({ lines, ends: sink.ends })).not.toContain("PRIVATE_");
    },
  );

  it("returns the failure reference and marks the trace when both reporters fail", async () => {
    const sink = recordingSink();
    const root = createTracer({ clock: () => 1000 }).start("request", { sinks: [sink] });
    const log = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("PRIVATE_FALLBACK_FAILURE");
    });
    let response: Response;
    try {
      response = requestFailureResponse(root, new SyntaxError("PRIVATE_DECODER_PAYLOAD"), () => {
        throw new Error("PRIVATE_REPORT_FAILURE");
      });
    } finally {
      log.mockRestore();
    }
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      type: "urn:switchboard:request-failure",
      title: "Request failed",
      status: 500,
      request_id: root.traceId,
    });
    expect(sink.ends[0]).toMatchObject({ traceId: root.traceId, status: "error", attrs: { httpStatus: 500 } });
    expect(sink.ends[0].errorMessage).toContain("Fallback unavailable");
    expect(sink.ends[0].errorMessage).toContain("Stored JSON is unreadable");
    expect(JSON.stringify(sink.ends)).not.toContain("PRIVATE_");
  });

  it("accepts only the shared problem reference and keeps its provenance unverified", () => {
    expect(failureContextOf(problem)).toEqual({ traceId: TRACE, source: "unverified" });
    for (const error of [
      { ...problem, type: "provider-error" },
      { ...problem, status: 503 },
      { ...problem, requestId: "0".repeat(32) },
      { ...problem, requestId: "private-context" },
      { ...problem, requestId: "sk-proj-12345678901234567890" },
    ])
      expect(failureContextOf(error)).toBeUndefined();
    expect(isFailureContext({ traceId: TRACE, source: "unverified" })).toBe(true);
    expect(isFailureContext({ traceId: TRACE, source: "proxy" })).toBe(false);
    expect(isFailureContext({ traceId: TRACE, source: "unverified", body: "PRIVATE" })).toBe(false);
    expect(
      isFailureContext(
        Object.assign(Object.create({ traceId: TRACE, source: "unverified" }), { body: "PRIVATE", extra: true }),
      ),
    ).toBe(false);
  });

  it("replays one projection outside the backlog and clears it for a later failure with no origin", () => {
    const registry = new RunRegistry({ backlogLimit: 1 });
    const run = registry.create(undefined, undefined, {
      replay: [
        { type: "assistant", text: "Begin", seq: 1 },
        { ...failure(), seq: 2 },
        { type: "assistant", text: "Later", seq: 3 },
      ],
    });
    expect(registry.getById(run.id)).toMatchObject({ failureContext: { traceId: TRACE, source: "unverified" } });
    expect(registry.snapshotById(run.id)?.events).toEqual([{ type: "assistant", text: "Later", seq: 3 }]);
    registry.publish(run.id, failure({ type: "unknown", status: 500, requestId: TRACE }, 1));
    expect(registry.getById(run.id)).toMatchObject({ failureContext: null });
  });

  it("reads live failure metadata without copying or scanning the event backlog", async () => {
    const registry = new RunRegistry();
    const run = registry.create();
    registry.publish(run.id, failure());
    vi.spyOn(registry, "snapshotById").mockImplementation(() => {
      throw new Error("Metadata must not copy events");
    });
    const service = createRunsService({ registry, store: null });
    expect(await service.getRun(run.id)).toMatchObject({
      ok: true,
      value: { id: run.id, failureContext: { traceId: TRACE, source: "unverified" } },
    });
  });
});
