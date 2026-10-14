import { describe, expect, it } from "vitest";
import { storageFailureNotice, storageFailureNote } from "./storageFailureDiagnostic.js";
import { storeRequestWitness } from "./storeResponse.js";
import { parseRunEventLines } from "./runEventLines.js";
import { createRunTimeline } from "../channels/runTimeline.js";

describe("storage diagnostic captures", () => {
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
      ["/runs/session/write", { sourceRunId: "run-a", gen: "owner-1" }],
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
