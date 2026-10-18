import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigDocumentClient, baseConfigDocument } from "./configDocument.js";
import { WorkerOverridesBacking } from "./config.js";
import { storageFailureDiagnosticOf, type StorageFailureNotice } from "./core/storageFailureDiagnostic.js";

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const RAY = "0123456789abcdef-DFW";

describe("config storage failure evidence", () => {
  beforeEach(() => {
    vi.useFakeTimers().setSystemTime(0);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retains an HTML denial's request time and correlation without treating it as a Worker refusal", async () => {
    const notices: StorageFailureNotice[] = [];
    let requests = 0;
    let sentRequestId: string | null = null;
    const client = new ConfigDocumentClient({
      baseUrl: "https://state.example",
      token: "private-bearer",
      onFailure: (notice) => notices.push(notice),
      fetch: async (_url, init) => {
        requests++;
        sentRequestId = new Headers(init?.headers).get("x-switchboard-storage-request-id");
        return new Response("<!doctype html><html>private response bytes</html>", {
          status: 403,
          headers: { "content-type": "text/html; charset=utf-8", "cf-ray": RAY, "set-cookie": "private-cookie" },
        });
      },
    });
    expect(await client.readBase()).toEqual({
      ok: false,
      status: 403,
      problem: "state Worker https://state.example: /config/get → HTTP 403 — is MEMORY_TOKEN the Worker's bearer?",
    });
    expect({ requests, sentRequestId }).toEqual({ requests: 1, sentRequestId: REQUEST_ID });
    expect(notices).toEqual([
      {
        runIds: [],
        context: { scope: "config" },
        diagnostic: {
          version: 1,
          operation: "/config/get",
          requestDigest: "f97ca81381b9669cbb999f9274a50ec72231d43efd7f92ca9ee7a149da969461",
          requestId: REQUEST_ID,
          requestedAt: 0,
          kind: "read",
          phase: "http",
          httpStatus: 403,
          rayId: RAY,
          response: { contentType: "html", bodyKind: "html" },
          timing: { elapsedMs: 0, timeoutMs: 8000, deadlineExceeded: false },
        },
      },
    ]);
    expect(storageFailureDiagnosticOf(notices[0].diagnostic)).toEqual(notices[0].diagnostic);
    expect(JSON.stringify(notices)).not.toMatch(/private-bearer|private-cookie|private response bytes/);
  });

  it("captures JSON denial evidence from runtime overrides through the same contract", async () => {
    const notices: StorageFailureNotice[] = [];
    const backing = new WorkerOverridesBacking({
      baseUrl: "https://state.example",
      token: "private-bearer",
      onFailure: (notice) => notices.push(notice),
      fetch: async () =>
        Response.json({ error: "private response prose" }, { status: 401, headers: { "cf-ray": RAY } }),
    });
    await expect(backing.load()).rejects.toThrow("config store answered HTTP 401 on /config/get");
    expect(notices).toMatchObject([
      {
        runIds: [],
        diagnostic: {
          operation: "/config/get",
          requestDigest: "eef228e9599660871e16b0a54fc9aa0f8a93798c139042a8372d02c850b71e1c",
          requestedAt: 0,
          requestId: REQUEST_ID,
          kind: "read",
          phase: "http",
          httpStatus: 401,
          rayId: RAY,
          response: { contentType: "json", bodyKind: "json" },
        },
      },
    ]);
    expect(JSON.stringify(notices)).not.toMatch(/private-bearer|private response prose/);
  });

  it("preserves HTTP refusal metadata when its response body cannot be read", async () => {
    const notices: StorageFailureNotice[] = [];
    const client = new ConfigDocumentClient({
      baseUrl: "https://state.example",
      token: "private-bearer",
      onFailure: (notice) => notices.push(notice),
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("private decoder details"));
            },
          }),
          { status: 403, headers: { "content-type": "text/html", "cf-ray": RAY } },
        ),
    });
    expect(await client.readBase()).toEqual({
      ok: false,
      problem: "state Worker https://state.example: /config/get response body was not received",
    });
    expect(notices).toMatchObject([
      {
        diagnostic: {
          phase: "response-body",
          httpStatus: 403,
          rayId: RAY,
          response: { contentType: "html", bodyKind: "unreadable" },
        },
      },
    ]);
    expect(JSON.stringify(notices)).not.toContain("private decoder details");
  });

  it("keeps a failed config write unknown and sends it once even when telemetry throws", async () => {
    let requests = 0;
    const document = baseConfigDocument("private: config\n", "private-source", new Date(0));
    const client = new ConfigDocumentClient({
      baseUrl: "https://state.example",
      token: "private-bearer",
      onFailure: () => {
        throw new Error("telemetry unavailable");
      },
      fetch: async () => {
        requests++;
        return Response.json({ error: "private failure" }, { status: 500 });
      },
    });
    expect(await client.pushBase(document, "base", 4)).toEqual({
      ok: false,
      write: "unknown",
      problem: "state Worker https://state.example: /config/put → HTTP 500; config write outcome unknown",
    });
    expect(requests).toBe(1);
    const logs = vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logs).toMatchObject([{ event: "storage.request.failure", diagnostic: { operation: "/config/put" } }]);
    expect(JSON.stringify(logs)).not.toMatch(/private-bearer|private failure|private-source|private: config/);
  });

  it("keeps a successful config read when diagnostic request IDs cannot be generated", async () => {
    vi.mocked(crypto.randomUUID).mockImplementation(() => {
      throw new Error("entropy unavailable");
    });
    const client = new ConfigDocumentClient({
      baseUrl: "https://state.example",
      token: "private-bearer",
      fetch: async () => Response.json({ document: null, version: 0 }),
    });
    expect(await client.readBase()).toEqual({ ok: true, document: null, version: 0 });
  });

  it("keeps the declared content type separate from the observed body format", async () => {
    const notices: StorageFailureNotice[] = [];
    const client = new ConfigDocumentClient({
      baseUrl: "https://state.example",
      token: "private-bearer",
      onFailure: (notice) => notices.push(notice),
      fetch: async () =>
        new Response('{"error":"private response prose"}', {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
    });
    expect(await client.readBase()).toMatchObject({ ok: false, status: 403 });
    expect(notices).toMatchObject([{ diagnostic: { response: { contentType: "html", bodyKind: "json" } } }]);
    expect(JSON.stringify(notices)).not.toContain("private response prose");
  });

  it("freezes failure timing before asynchronous diagnostic work can pass the request deadline", async () => {
    const notices: StorageFailureNotice[] = [];
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, bytes) => {
      vi.setSystemTime(9000);
      deadline.abort();
      return digest(algorithm, bytes);
    });
    const client = new ConfigDocumentClient({
      baseUrl: "https://state.example",
      token: "private-bearer",
      onFailure: (notice) => notices.push(notice),
      fetch: async () => {
        vi.setSystemTime(25);
        return new Response("denied", { status: 403 });
      },
    });
    expect(await client.readBase()).toMatchObject({ ok: false, status: 403 });
    expect(notices).toMatchObject([
      {
        diagnostic: {
          requestedAt: 0,
          timing: { elapsedMs: 25, timeoutMs: 8000, deadlineExceeded: false },
        },
      },
    ]);
  });

  it("reports an unreadable override response without changing its existing empty-document result", async () => {
    const notices: StorageFailureNotice[] = [];
    const backing = new WorkerOverridesBacking({
      baseUrl: "https://state.example",
      token: "private-bearer",
      onFailure: (notice) => notices.push(notice),
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("private decoder details"));
            },
          }),
          { headers: { "content-type": "application/json", "cf-ray": RAY } },
        ),
    });
    expect(await backing.load()).toBeUndefined();
    expect(notices).toMatchObject([
      {
        diagnostic: {
          phase: "response-body",
          httpStatus: 200,
          rayId: RAY,
          response: { contentType: "json", bodyKind: "unreadable" },
        },
      },
    ]);
    expect(JSON.stringify(notices)).not.toContain("private decoder details");
  });
});
