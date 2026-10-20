import { describe, expect, it, vi } from "vitest";
import { observeWorkerRequest } from "./workerCorrelation.js";

describe("Worker invocation correlation", () => {
  it("joins an authenticated request to its app trace before work starts without recording payloads", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const attributes: Record<string, string> = {};
    try {
      observeWorkerRequest(
        new Request("https://state.example/runs/step?token=PRIVATE_QUERY", {
          method: "POST",
          headers: {
            authorization: "Bearer PRIVATE_BEARER",
            "x-switchboard-storage-request-id": "11111111-1111-4111-a111-111111111111",
            "cf-ray": "a".repeat(16) + "-SFO",
            traceparent: `00-${"4".repeat(32)}-${"5".repeat(16)}-01`,
          },
          body: "PRIVATE_BODY",
        }),
        { service: "memory", route: "/runs/step", build: { commit: "a".repeat(40) } },
        { getActiveSpan: () => ({ setAttributes: (value) => Object.assign(attributes, value) }) },
      );
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        {
          event: "cloudflare.request.received",
          service: "memory",
          route: "/runs/step",
          requestId: "11111111-1111-4111-a111-111111111111",
          traceId: "4".repeat(32),
          rayId: "a".repeat(16) + "-SFO",
          build: { commit: "a".repeat(40) },
        },
      ]);
      expect(attributes).toEqual({
        "switchboard.service": "memory",
        "switchboard.route": "/runs/step",
        "switchboard.request_id": "11111111-1111-4111-a111-111111111111",
        "switchboard.trace_id": "4".repeat(32),
        "switchboard.build_commit": "a".repeat(40),
      });
    } finally {
      log.mockRestore();
    }
  });

  it("uses the public edge's own trace and ignores caller correlation, malformed IDs and sink failures", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = new Request("https://bot.example/mcp?token=PRIVATE", {
      headers: {
        "x-switchboard-request-id": "11111111-1111-4111-a111-111111111111",
        traceparent: `00-${"4".repeat(32)}-${"5".repeat(16)}-01`,
        "cf-ray": "PRIVATE_BAD_RAY",
      },
    });
    try {
      const options = {
        service: "bot" as const,
        route: "mcp",
        build: { commit: "unknown" },
        traceId: "1".repeat(32),
        publicEdge: true as const,
      };
      observeWorkerRequest(request, options);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({
        event: "cloudflare.request.received",
        service: "bot",
        route: "mcp",
        traceId: "1".repeat(32),
        build: { commit: "unknown" },
      });
      log.mockImplementation(() => {
        throw new Error("PRIVATE_SINK_ERROR");
      });
      observeWorkerRequest(request, options, {
        getActiveSpan: () => {
          throw new Error("PRIVATE_TRACER_ERROR");
        },
      });
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        { event: "cloudflare.correlation.unavailable", service: "bot", stage: "native-span" },
        { event: "cloudflare.correlation.unavailable", service: "bot", stage: "operator-log" },
      ]);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});
