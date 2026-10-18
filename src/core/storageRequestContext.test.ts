import type { StorageOperation, StorageOperationBody } from "./storageRequestContext.js";
import type { PreparedStorageRequest } from "./storeResponse.js";
import type { StoreRequestWitness } from "./storeFailure.js";

type Accepted<O extends StorageOperation, B extends StorageOperationBody<O>> = B;
export type ValidDeletion = Accepted<"/runs/delete", { id: string }>;
export type ValidBatch = Accepted<"/runs/deleted", { ids: readonly string[] }>;
// @ts-expect-error A deletion cannot omit its run identity.
export type MissingDeletion = Accepted<"/runs/delete", Record<string, never>>;
// @ts-expect-error A deletion batch uses ids, not an unbound alias.
export type WrongBatch = Accepted<"/runs/deleted", { runIds: string[] }>;
// @ts-expect-error Unknown operations cannot enter a first-party transport.
export type UnknownOperation = StorageOperationBody<"/runs/not-registered">;
// @ts-expect-error Confirmation and original claim identities are separate variants.
export type ConflictingClaim = Accepted<"/runs/claim", { run: { runId: string }; confirm: { runId: string } }>;
// @ts-expect-error Current session writers must name their run or trusted source run.
export type MissingSessionOwner = Accepted<"/runs/session/write", { key: string; gen: string }>;
type Dispatchable<T extends PreparedStorageRequest> = T;
// @ts-expect-error Legacy witnesses without validated context cannot enter the transport.
export type UnboundDispatch = Dispatchable<StoreRequestWitness>;
// @ts-expect-error A caller cannot certify guessed context without the validated constructor.
export type GuessedDispatch = Dispatchable<StoreRequestWitness & { context: { scope: "runs"; runIds: string[] } }>;

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { STORAGE_OPERATIONS, storageRequestContext } from "./storageRequestContext.js";
import { prepareStorageRequest } from "./storeResponse.js";
import { storageFailureNotice, emitStorageFailure } from "./storageFailureDiagnostic.js";
import { storageTransport } from "./storageTransport.js";

describe("storage request identity contract", () => {
  it("bounds aggregate operator output and explicitly counts omitted targets while preserving the full notice", async () => {
    const ids = Array.from(
      { length: 5000 },
      (_, i) => `${i.toString(16).padStart(8, "0")}-1111-4111-a111-111111111111`,
    );
    const notice = storageFailureNotice(
      await prepareStorageRequest("/runs/deleted", { ids }),
      "read",
      "transport",
      new Error("offline"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let retained: readonly string[] = [];
    try {
      emitStorageFailure(notice, (value) => {
        retained = value.runIds;
      });
      const lines = warn.mock.calls.map(([value]) => String(value));
      expect(Buffer.byteLength(lines.join("\n"), "utf8")).toBeLessThanOrEqual(32768);
      expect(lines.map((value) => JSON.parse(value))).toMatchObject([
        {
          runIds: expect.any(Array),
          context: { scope: "runs" },
          targetCounts: { total: 5000, emitted: 200, omitted: 4800 },
        },
      ]);
      expect(JSON.parse(lines[0]!).runIds).toHaveLength(200);
      expect(JSON.parse(lines[0]!).context).toEqual({ scope: "runs" });
      expect({ count: retained.length, last: retained.at(-1) }).toEqual({
        count: 5000,
        last: "00001387-1111-4111-a111-111111111111",
      });
    } finally {
      warn.mockRestore();
    }
  });
  it("uses each operation's identity rather than unrelated run-like fields", () => {
    const cases = [
      [
        ["/runs/delete", "/runs/get", "/runs/summary", "/runs/events"],
        { id: "target", runId: "unrelated" },
        ["target"],
      ],
      [["/runs/put", "/runs/shutdown"], { record: { id: "target" }, runId: "unrelated" }, ["target"]],
      [["/runs/check-source"], { selector: { runId: "target" }, runId: "unrelated" }, ["target"]],
      [["/runs/claim-observations/record"], { observation: { runId: "target" }, runId: "unrelated" }, ["target"]],
      [["/runs/cancellation/read"], { cancellation: { runId: "target" }, runId: "unrelated" }, ["target"]],
      [
        ["/runs/ingress/finish", "/runs/ingress/refusal-ack"],
        { request: { runId: "target" }, runId: "unrelated" },
        ["target"],
      ],
      [
        ["/runs/native-retirement/prepare"],
        { target: { scope: { owner: { runId: "target" } } }, runId: "unrelated" },
        ["target"],
      ],
      [
        ["/runs/source-events/relevance"],
        { request: { result: { context: { runId: "target" } } }, runId: "unrelated" },
        ["target"],
      ],
      [["/runs/claim", "/runs/promotion/prepare"], { run: { runId: "target" }, runId: "unrelated" }, ["target"]],
      [["/runs/claim"], { confirm: { runId: "target" }, runId: "unrelated" }, ["target"]],
      [
        ["/runs/session/expected-seed/read", "/runs/session/expected-seed/verify"],
        { reference: { runId: "target" }, runId: "unrelated" },
        ["target"],
      ],
      [["/runs/session/expected-seed/verify"], { release: { runId: "target" }, runId: "unrelated" }, ["target"]],
      [["/runs/workspace-disposition"], { allocation: { runId: "target" }, runId: "unrelated" }, ["target"]],
      [["/plane/ack"], { owner: { runId: "target" }, runId: "unrelated" }, ["target"]],
      [["/runs/deleted"], { ids: ["target", "second", "target"], runId: "unrelated" }, ["target", "second"]],
      [["/runs/handoff"], { runIds: ["target", "second", "target"], runId: "unrelated" }, ["target", "second"]],
      [
        ["/plane/reclaimed"],
        { outcomes: [{ runId: "target" }, { runId: "second" }], runId: "unrelated" },
        ["target", "second"],
      ],
      [["/runs/session/write"], { sourceRunId: "target", sources: { version: 1, status: "unknown" } }, ["target"]],
      [["/runs/private-worker/append"], { event: { kind: "reply", runId: "target" }, runId: "unrelated" }, ["target"]],
    ] as const;
    for (const [operations, body, runIds] of cases)
      for (const operation of operations)
        expect({ operation, context: storageRequestContext(operation, body) }).toEqual({
          operation,
          context: { scope: "runs", runIds },
        });
  });
  it("refuses encoded bytes naming another run before dispatch and accepts the matching wire identity", async () => {
    let calls = 0;
    const send = async (encoded: string) =>
      storageTransport(
        await prepareStorageRequest("/runs/delete", { id: "original" }, encoded),
        {
          url: "https://storage.invalid/runs/delete",
          headers: {},
          signal: new AbortController().signal,
          timeoutMs: 10000,
          fetch: async (_url, init) => {
            calls++;
            return Response.json({ wire: JSON.parse(String(init?.body)) });
          },
        },
        (response) => response.json(),
      );
    await expect(send('{"id":"foreign"}')).rejects.toThrow("encoded request identity mismatch");
    await expect(
      prepareStorageRequest("/runs/delete", { id: "original", toJSON: () => ({ id: "foreign" }) }),
    ).rejects.toThrow("encoded request identity mismatch");
    expect(calls).toBe(0);
    expect(await send('{ "id": "original" }')).toEqual({ wire: { id: "original" } });
    expect(calls).toBe(1);
  });
  it("captures the immutable batch before a later caller edit and does not decode payloads on failure", async () => {
    const body = { ids: ["original", "second", "original"] };
    const preparing = prepareStorageRequest("/runs/deleted", body);
    body.ids[0] = "later";
    const request = await preparing;
    const originalParse = JSON.parse;
    const parse = vi.spyOn(JSON, "parse").mockImplementation((value, reviver) => {
      if (value === request.payload) throw new Error("must not decode request bytes");
      return originalParse(value, reviver);
    });
    try {
      const notice = storageFailureNotice(request, "read", "transport", new Error("offline"));
      expect({ targets: notice.runIds, context: notice.context }).toEqual({
        targets: ["original", "second"],
        context: { scope: "runs", runIds: ["original", "second"] },
      });
    } finally {
      parse.mockRestore();
    }
    expect(JSON.parse(request.payload)).toEqual({ ids: ["original", "second", "original"] });
  });

  it("keeps invalid identities distinct from explicit session and service scopes", async () => {
    await expect(prepareStorageRequest("/runs/delete", { id: "private/id" })).rejects.toThrow(
      "invalid request identity",
    );
    expect([
      storageRequestContext("/runs/check-source", { selector: { runId: "original" } }),
      storageRequestContext("/runs/ingress/unread-hold", {
        proof: { ingressRunId: "first", receiverRunId: "second", receiverGen: "g1" },
      }),
      storageRequestContext("/runs/cancellation/finish", {
        cancellation: { runId: "first" },
        record: { id: "second" },
      }),
      storageRequestContext("/runs/session/read", { key: "private:original", runId: "unrelated" }),
      storageRequestContext("/runs/list", { runId: "unrelated" }),
      storageRequestContext("/runs/unknown", { runId: "unrelated" }),
    ]).toEqual([
      { scope: "runs", runIds: ["original"] },
      { scope: "runs", runIds: ["first", "second"], ownerGen: "g1" },
      { scope: "unresolved", reason: "malformed-target" },
      { scope: "session" },
      { scope: "store" },
      { scope: "unresolved", reason: "unknown-operation" },
    ]);
  });

  it("uses active owning variants and preserves accepted legacy identity protocols", async () => {
    expect(storageRequestContext("/runs/session/write", { runId: "original", sourceRunId: "ignored" })).toEqual({
      scope: "runs",
      runIds: ["original"],
    });
    expect(
      storageRequestContext("/runs/session/write", {
        runId: "ignored",
        sourceRunId: "original",
        sources: { version: 1, status: "unknown" },
      }),
    ).toEqual({ scope: "runs", runIds: ["original"] });
    expect(storageRequestContext("/plane/ack", { owner: { runId: "ignored" }, reconciliation: {} })).toEqual({
      scope: "plane",
    });
    const settlement = await prepareStorageRequest("/runs/ingress/finish", { request: { runId: "legacy:ingress" } });
    const reply = await prepareStorageRequest("/runs/private-worker/append", {
      event: { kind: "reply", runId: "legacy:reply", text: "saved", at: 1 },
    });
    expect([settlement.context, reply.context]).toEqual([
      { scope: "unresolved", reason: "legacy-identity" },
      { scope: "unresolved", reason: "legacy-identity" },
    ]);
  });

  it("covers the Worker route boundary without interpreting payload fields on non-run operations", () => {
    const worker = readFileSync(new URL("../../deploy/cloudflare-memory/worker.ts", import.meta.url), "utf8");
    const declarations = ["LEDGER_ROUTES", "PLANE_ROUTES", "ROUTES"].map(
      (name) => worker.split(new RegExp(`const ${name} = new Set(?:<string>)?\\(\\[`))[1]!.split("]")[0]!,
    );
    const routes = [
      ...new Set(
        declarations.flatMap((block) =>
          [...block.matchAll(/"(\/(?:runs|plane)\/[^"\n]+)"/g)].map((match) => match[1]!),
        ),
      ),
    ].sort();
    expect(Object.keys(STORAGE_OPERATIONS).sort()).toEqual(routes);
    expect(storageRequestContext("/plane/admit", { request: { runId: "foreign" } })).toEqual({ scope: "plane" });
  });
});
