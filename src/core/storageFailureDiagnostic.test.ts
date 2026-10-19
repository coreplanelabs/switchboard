import { describe, expect, it, vi } from "vitest";
import {
  storageFailureDiagnosticOf,
  storageFailureNotice,
  storageFailureNote,
  rememberStorageFailure,
  originalStorageFailure,
  storageFailureWasReported,
  reportStorageFailure,
  inheritStorageFailure,
  emitStorageFailure,
} from "./storageFailureDiagnostic.js";
import { storeRequestWitness } from "./storeResponse.js";
import { parseRunEventLines } from "./runEventLines.js";
import { createRunTimeline } from "../channels/runTimeline.js";
import { analyzeRunFriction } from "./runFriction.js";

describe("storage diagnostic captures", () => {
  it("names Cloudflare's boundary on new and retained storage failures without blaming a generic 500", async () => {
    const request = await storeRequestWitness("/runs/step", '{"runId":"original","gen":"owner"}');
    const diagnostic = {
      version: 1 as const,
      operation: "/runs/step",
      requestDigest: request.digest,
      phase: "http" as const,
      httpStatus: 500,
      server: {
        stage: "request" as const,
        errorKind: "error" as const,
        exception: { name: "Error", message: "internal error; reference = 0123456789abcdefghijklmn" },
      },
    };
    const expected =
      "Storage request failed: /runs/step (http, HTTP 500): Error: Failed inside Cloudflare's infrastructure boundary: internal error; reference = 0123456789abcdefghijklmn";
    expect(storageFailureNote(diagnostic).summary).toBe(expected);
    const retained = {
      type: "run_note" as const,
      kind: "storage_failure" as const,
      summary:
        "Storage request failed: /runs/step (http, HTTP 500): Error: internal error; reference = 0123456789abcdefghijklmn",
      storageFailure: diagnostic,
    };
    const parsed = parseRunEventLines(JSON.stringify(retained));
    expect(createRunTimeline().push(parsed.events[0])).toMatchObject([{ kind: "note", text: expected }]);
    expect(analyzeRunFriction([retained]).findings).toEqual([
      { category: "infra_failure", severity: "high", summary: expected, eventIndex: 0 },
    ]);
    expect(
      createRunTimeline().push({
        ...retained,
        summary: "Storage checkpoint remains unconfirmed.",
        storageFailure: { ...diagnostic, server: undefined },
      }),
    ).toMatchObject([{ kind: "note", text: "Storage checkpoint remains unconfirmed." }]);
    expect(storageFailureNote({ ...diagnostic, server: undefined }).summary).toBe(
      "Storage request failed: /runs/step (http, HTTP 500)",
    );
    expect(
      storageFailureNote({
        ...diagnostic,
        server: {
          ...diagnostic.server,
          exception: { name: "Error", message: "git: internal error; reference = 0123456789abcdefghijklmn" },
        },
      }).summary,
    ).toBe(
      "Storage request failed: /runs/step (http, HTTP 500): Error: git: internal error; reference = 0123456789abcdefghijklmn",
    );
  });
  it("clears a reused error before capture and bounds unavailable targets without decoding request bytes", async () => {
    const error = new Error("offline");
    const requestA = await storeRequestWitness("/runs/delete", '{"id":"old"}');
    const noticeA = storageFailureNotice(requestA, "write", "transport", error);
    const ids = Array.from({ length: 5000 }, (_, i) => `run-${i}`);
    const requestB = await storeRequestWitness(
      "/runs/deleted",
      JSON.stringify({ ids }),
      { ids },
      "11111111-1111-4111-a111-111111111111",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      reportStorageFailure(error, noticeA);
      expect(storageFailureWasReported(error)).toBe(true);
      expect(
        reportStorageFailure(
          error,
          () => {
            throw new Error("private capture failure");
          },
          undefined,
          requestB,
        ),
      ).toBe(false);
      expect(storageFailureWasReported(error)).toBe(false);
      expect(originalStorageFailure(error)).toBeUndefined();
      const line = String(warn.mock.calls[1]?.[0]);
      expect(JSON.parse(line)).toMatchObject({
        event: "storage.request.failure.unavailable",
        operation: "/runs/deleted",
        requestId: "11111111-1111-4111-a111-111111111111",
        targetCounts: { total: 5000, emitted: 200, omitted: 4800 },
      });
      expect(JSON.parse(line).runIds).toHaveLength(200);
      expect(JSON.parse(line).runIds.at(-1)).toBe("run-199");
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(32768);
      expect(line).not.toContain("private capture failure");
    } finally {
      warn.mockRestore();
    }
  });

  it("marks the primary report before an observer can replace its boundary metadata", async () => {
    const error = new Error("offline");
    const noticeA = storageFailureNotice(
      await storeRequestWitness("/runs/delete", '{"id":"request-a"}'),
      "write",
      "http",
      error,
      new Response(null, { status: 500 }),
    );
    const noticeB = storageFailureNotice(
      await storeRequestWitness("/runs/get", '{"id":"request-b"}'),
      "read",
      "http",
      error,
      new Response(null, { status: 503 }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let during: unknown;
    try {
      reportStorageFailure(error, noticeA, () => {
        during = { reported: storageFailureWasReported(error), diagnostic: originalStorageFailure(error) };
        rememberStorageFailure(error, noticeB.diagnostic);
      });
      expect(during).toMatchObject({ reported: true, diagnostic: { operation: "/runs/delete", httpStatus: 500 } });
      expect(originalStorageFailure(error)).toMatchObject({ operation: "/runs/get", httpStatus: 503 });
      expect(storageFailureWasReported(error)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("replaces an earlier report observation when one error is reused for another request", async () => {
    const error = new Error("offline");
    const noticeA = storageFailureNotice(
      await storeRequestWitness("/runs/delete", '{"id":"request-a"}'),
      "write",
      "http",
      error,
      new Response(null, { status: 500 }),
    );
    const noticeB = storageFailureNotice(
      await storeRequestWitness("/runs/get", '{"id":"request-b"}'),
      "read",
      "http",
      error,
      new Response(null, { status: 503 }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      reportStorageFailure(error, noticeA);
      expect(storageFailureWasReported(error)).toBe(true);
      inheritStorageFailure(error, error);
      expect(storageFailureWasReported(error)).toBe(true);
      warn.mockImplementationOnce(() => {
        throw new Error("log unavailable");
      });
      reportStorageFailure(error, noticeB);
      expect(originalStorageFailure(error)).toMatchObject({ operation: "/runs/get", httpStatus: 503 });
      expect(storageFailureWasReported(error)).toBe(false);
      reportStorageFailure(error, noticeB);
      expect(storageFailureWasReported(error)).toBe(true);
      rememberStorageFailure(error, noticeA.diagnostic);
      expect(originalStorageFailure(error)).toMatchObject({ operation: "/runs/delete", httpStatus: 500 });
      expect(storageFailureWasReported(error)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps saved metadata separate from primary reporting and preserves a wrapper's observed report", async () => {
    const error = new Error("offline");
    const notice = storageFailureNotice(
      await storeRequestWitness("/runs/delete", '{"id":"original"}'),
      "write",
      "http",
      error,
      new Response(null, { status: 500 }),
    );
    rememberStorageFailure(error, notice.diagnostic);
    expect(originalStorageFailure(error)).toMatchObject({ operation: "/runs/delete", httpStatus: 500 });
    expect(storageFailureWasReported(error)).toBe(false);
    const metadataWrapper = new Error("unknown outcome", { cause: error });
    inheritStorageFailure(metadataWrapper, error);
    expect(storageFailureWasReported(metadataWrapper)).toBe(false);
    expect(originalStorageFailure(metadataWrapper)).toMatchObject({ operation: "/runs/delete", httpStatus: 500 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      reportStorageFailure(error, notice);
      const wrapper = new Error("unknown outcome", { cause: error });
      inheritStorageFailure(wrapper, error);
      expect(storageFailureWasReported(error)).toBe(true);
      expect(storageFailureWasReported(wrapper)).toBe(true);
      expect(originalStorageFailure(wrapper)).toEqual(originalStorageFailure(error));
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toMatchObject([
        { event: "storage.request.failure", runIds: ["original"], diagnostic: { httpStatus: 500 } },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not count a successful fallback or observer as an emitted primary log", async () => {
    const notice = storageFailureNotice(
      await storeRequestWitness("/runs/delete", '{"id":"original"}'),
      "write",
      "transport",
      new Error("offline"),
    );
    const notices: unknown[] = [];
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementationOnce(() => {
        throw new Error("log unavailable");
      })
      .mockImplementation(() => {});
    try {
      expect(emitStorageFailure(notice, (value) => notices.push(value))).toBe(false);
      expect(notices).toEqual([notice]);
      expect(JSON.parse(String(warn.mock.calls[1]?.[0]))).toEqual({
        event: "storage.request.failure_telemetry_failed",
        side: "client",
        stage: "operator-log",
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps deletion targets and excludes run-like fields on unrelated operations", async () => {
    const targets: string[][] = [];
    for (const [operation, body] of [
      ["/runs/delete", { id: "original" }],
      ["/runs/deleted", { ids: ["original", "other", "original"] }],
      ["/runs/summary", { id: "original" }],
      ["/runs/events", { id: "original" }],
      ["/runs/list", { runId: "foreign" }],
      ["/runs/unknown", { runId: "foreign" }],
    ] as const) {
      const request = await storeRequestWitness(operation, JSON.stringify(body));
      targets.push([...storageFailureNotice(request, "read", "transport", new Error("offline")).runIds]);
    }
    expect(targets).toEqual([["original"], ["original", "other"], ["original"], ["original"], [], []]);
  });
  it("does not label an externally consumed body as unread when no decoder evidence was retained", async () => {
    const response = new Response("private body", { status: 403 });
    await response.text();
    const notice = storageFailureNotice(
      await storeRequestWitness("/config/get", '{"key":"base"}'),
      "read",
      "http",
      new Error("denied"),
      response,
    );
    expect(notice.diagnostic).toMatchObject({
      httpStatus: 403,
      response: { contentType: "text", bodyKind: "unknown" },
    });
    expect(storageFailureDiagnosticOf(notice.diagnostic)).toEqual(notice.diagnostic);
    expect(JSON.stringify(notice)).not.toContain("private body");
  });

  it("shows the redacted exception on the run timeline and keeps bounded causal evidence in an exported capture", async () => {
    const request = await storeRequestWitness(
      "/runs/state",
      JSON.stringify({ runId: "run-1", gen: "owner-1", state: { notepad: "private request bytes" } }),
    );
    const error = Object.assign(new Error("connection reset token=fixture-credential"), {
      code: "ECONNRESET",
      retryable: true,
      cause: new Error("socket closed"),
    });
    error.stack = "Error: connection reset token=fixture-credential\n" + "x".repeat(4000);
    const notice = storageFailureNotice(request, "write", "transport", error);
    const note = storageFailureNote(notice.diagnostic);
    const captured = parseRunEventLines(JSON.stringify(note));
    expect(createRunTimeline().push(captured.events[0])).toMatchObject([
      {
        kind: "note",
        text: "Storage request failed: /runs/state (transport): Error: connection reset token=«redacted»",
        noteKind: "storage_failure",
      },
    ]);
    expect(captured.events[0]).toMatchObject({
      storageFailure: {
        operation: "/runs/state",
        ownerGen: "owner-1",
        requestDigest: request.digest,
        exception: {
          message: "connection reset token=«redacted»",
          code: "ECONNRESET",
          retryable: true,
          cause: { message: "socket closed" },
        },
      },
    });
    expect(notice.diagnostic.exception?.stack?.length).toBe(1025);
    expect(JSON.stringify(captured)).not.toMatch(/fixture-credential|private request bytes/);
  });

  it("rejects private extra fields and malformed diagnostics while preserving a valid legacy note", () => {
    const valid = {
      type: "run_note",
      kind: "storage_failure",
      summary: "storage failed",
      storageFailure: {
        version: 1,
        operation: "/runs/state",
        requestDigest: "a".repeat(64),
        kind: "write",
        phase: "http",
        httpStatus: 500,
        server: {
          stage: "state-rpc",
          errorKind: "error",
          exception: { name: "Error", message: "reset token=fixture-credential" },
        },
      },
    };
    const bad = [
      { ...valid.storageFailure, kind: { toString: null } },
      { ...valid.storageFailure, kind: ["write"] },
      { ...valid.storageFailure, server: { ...valid.storageFailure.server, stage: { toString: null } } },
      { ...valid.storageFailure, server: { ...valid.storageFailure.server, stage: ["state-rpc"] } },
      { ...valid.storageFailure, body: "private" },
      { ...valid.storageFailure, phase: "guessed" },
      {
        ...valid.storageFailure,
        server: {
          ...valid.storageFailure.server,
          exception: { ...valid.storageFailure.server.exception, body: "private" },
        },
      },
      { ...valid.storageFailure, requestDigest: "bad" },
      { ...valid.storageFailure, requestId: "private request bytes" },
      { ...valid.storageFailure, requestedAt: -1 },
      { ...valid.storageFailure, requestedAt: "private time" },
      { ...valid.storageFailure, response: { contentType: "text/html private", bodyKind: "html" } },
      { ...valid.storageFailure, response: { contentType: "html", bodyKind: "html", body: "private" } },
      { ...valid.storageFailure, response: { contentType: "json", bodyKind: "worker-refusal" } },
      { ...valid.storageFailure, timing: { elapsedMs: -1, timeoutMs: 10000, deadlineExceeded: true } },
      { ...valid.storageFailure, timing: { elapsedMs: 10000, timeoutMs: 10000 } },
      {
        ...valid.storageFailure,
        timing: { elapsedMs: 10000, timeoutMs: 10000, deadlineExceeded: true, body: "private" },
      },
    ];
    const parsed = parseRunEventLines(
      [
        valid,
        ...bad.map((storageFailure) => ({ ...valid, storageFailure })),
        { type: "run_note", kind: "checkpoint_deferred", summary: "legacy" },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n"),
    );
    expect(parsed.events).toEqual([
      {
        ...valid,
        storageFailure: {
          ...valid.storageFailure,
          server: { ...valid.storageFailure.server, exception: { name: "Error", message: "reset token=«redacted»" } },
        },
      },
      ...bad.map(() => ({ type: "run_note", kind: "storage_failure", summary: "storage failed" })),
      { type: "run_note", kind: "checkpoint_deferred", summary: "legacy" },
    ]);
  });

  it("correlates every explicit wire run identity without guessing a key-only request owner", async () => {
    for (const [path, body] of [
      ["/runs/session/write", { sourceRunId: "run-a", sources: { version: 1, status: "unknown" }, gen: "owner-1" }],
      ["/runs/workspace-disposition", { allocation: { runId: "run-a" } }],
      ["/runs/claim", { confirm: { runId: "run-a", gen: "owner-1" } }],
      ["/runs/session/expected-seed/read", { reference: { runId: "run-a", gen: "owner-1" } }],
      ["/runs/session/expected-seed/verify", { release: { runId: "run-a", gen: "owner-1" } }],
      ["/runs/get", { id: "run-a" }],
      ["/runs/workspace-ack", { runId: "run-a", ownerGen: "owner-1" }],
    ] as const) {
      const notice = storageFailureNotice(
        await storeRequestWitness(path, JSON.stringify(body)),
        "write",
        "http",
        new Error("failure"),
      );
      expect(notice.runIds).toEqual(["run-a"]);
      if ("allocation" in body || "id" in body) expect(notice.diagnostic.ownerGen).toBeUndefined();
      else expect(notice.diagnostic.ownerGen).toBe("owner-1");
    }
    for (const [path, body] of [
      ["/runs/handoff", { gen: "owner-1", runIds: ["run-a", "run-b", "run-a"] }],
      ["/plane/reclaimed", { outcomes: [{ runId: "run-a" }, { runId: "run-b" }, { runId: "run-a" }] }],
    ] as const) {
      expect(
        storageFailureNotice(
          await storeRequestWitness(path, JSON.stringify(body)),
          "write",
          "http",
          new Error("failure"),
        ).runIds,
      ).toEqual(["run-a", "run-b"]);
    }
    for (const [path, body] of [
      ["/runs/session/read", { key: "slack:C1:1:general" }],
      ["/plane/ack", { id: "effect-1" }],
    ] as const) {
      const notice = storageFailureNotice(
        await storeRequestWitness(path, JSON.stringify(body)),
        "read",
        "http",
        new Error("failure"),
      );
      expect({ targets: notice.runIds, operation: notice.diagnostic.operation }).toEqual({
        targets: [],
        operation: path,
      });
    }
  });
});
