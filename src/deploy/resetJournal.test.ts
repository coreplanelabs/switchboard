import { describe, expect, it, vi } from "vitest";
import { ResetCloudflare } from "./resetCloudflare.js";
import { ResetJournal } from "./resetJournal.js";
import { importCredentialKey, sealCredential, openCredential } from "../mcp/sealed.js";

const account = "a".repeat(32);
const key = importCredentialKey(Buffer.alloc(32, 7).toString("base64"));
const page = (result: unknown) => Response.json({ success: true, result });
function fixture() {
  const state = {
    exists: false,
    public: false,
    expiration: false,
    uncertain: false,
    corrupt: false,
    failedStage: undefined as "absence" | "put" | "readback" | undefined,
    failureStatus: 403,
    failureRay: "0123456789abcdef-SJC",
    objects: new Map<string, string>(),
    writes: [] as string[],
  };
  const native = new ResetCloudflare(account, "test-token", async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (method === "POST") {
      state.exists = true;
      state.writes.push("create");
      return page({ name: "gateway-memory-reset-journal" });
    }
    if (!state.exists) return new Response(null, { status: 404 });
    if (path.endsWith("/domains/managed")) return page({ enabled: state.public });
    if (path.endsWith("/domains/custom")) return page({ domains: [] });
    if (path.endsWith("/lifecycle"))
      return page({
        rules: state.expiration
          ? [{ enabled: true, deleteObjectsTransition: { condition: { type: "Age", maxAge: 1 } } }]
          : [{ id: "multipart", enabled: true, conditions: {}, abortMultipartUploadsTransition: {} }],
      });
    const at = path.indexOf("/objects/");
    if (at < 0) return page({ name: "gateway-memory-reset-journal" });
    const name = path.slice(at + "/objects/".length);
    const failed = () =>
      new Response("private provider body", {
        status: state.failureStatus,
        headers: { "cf-ray": state.failureRay, "x-private": "private header" },
      });
    if (name !== "owner.sealed.json" && method === "GET" && state.failedStage === "absence" && !state.objects.has(name))
      return failed();
    if (method === "PUT") {
      state.writes.push(name);
      if (name !== "owner.sealed.json" && state.failedStage === "put") return failed();
      state.objects.set(name, String(init?.body));
      if (state.uncertain && name !== "owner.sealed.json") throw new Error("original response lost");
      return page({ key: name });
    }
    if (name !== "owner.sealed.json" && state.failedStage === "readback" && state.objects.has(name)) return failed();
    const body = state.objects.get(name);
    return body === undefined
      ? new Response(null, { status: 404 })
      : new Response(state.corrupt && name !== "owner.sealed.json" ? "different bytes" : body);
  });
  return { state, journal: new ResetJournal(native, "gateway-memory", ["gateway", "gateway-memory"], key, () => 42) };
}

describe("durable reset journal", () => {
  it("keeps preview read-only and stores encrypted original records outside application storage", async () => {
    const { state, journal } = fixture();
    expect(await journal.inspect()).toEqual({ bucket: "gateway-memory-reset-journal", status: "new" });
    expect(state.writes).toEqual([]);
    await journal.ensure();
    const sealed = await sealCredential(
      key,
      `installation-reset:${account}:original-operation`,
      "original deletion intent",
      42,
    );
    expect(await journal.write("runs/1/original/entry.sealed.json", sealed)).toMatchObject({
      bucket: "gateway-memory-reset-journal",
      key: "runs/1/original/entry.sealed.json",
    });
    expect(await openCredential(key, JSON.parse(await journal.read("runs/1/original/entry.sealed.json")))).toBe(
      "original deletion intent",
    );
    expect(state.writes).toEqual(["create", "owner.sealed.json", "runs/1/original/entry.sealed.json"]);
    expect([...state.objects.values()].join("\n")).not.toContain("original deletion intent");
    await expect(journal.write("runs/1/original/entry.sealed.json", sealed)).rejects.toThrow("key exists");
  });

  it.each(["absence", "put", "readback"] as const)(
    "reports the exact %s HTTP boundary without repeating or exposing private data",
    async (stage) => {
      const { state, journal } = fixture();
      await journal.ensure();
      state.failedStage = stage;
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const sealed = await sealCredential(
          key,
          `installation-reset:${account}:original-operation`,
          "private original intent",
          42,
        );
        await expect(journal.write("runs/1/original/entry.sealed.json", sealed)).rejects.toMatchObject({
          diagnostic: {
            stage,
            reason: "http",
            httpStatus: 403,
            requestId: "0123456789abcdef-SJC",
            writeOutcome: "unknown",
          },
        });
        expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
          {
            event: "installation.reset.journal.failure",
            account,
            bucket: "gateway-memory-reset-journal",
            keySha256: "0de17887c23f11dcfdda1f9822637fa19acaff25d98bd08af308ba6affe3f41c",
            stage,
            reason: "http",
            httpStatus: 403,
            requestId: "0123456789abcdef-SJC",
            writeOutcome: "unknown",
          },
        ]);
        expect(state.writes).toEqual(
          stage === "absence"
            ? ["create", "owner.sealed.json"]
            : ["create", "owner.sealed.json", "runs/1/original/entry.sealed.json"],
        );
        expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|original-operation|runs\/1/);
      } finally {
        log.mockRestore();
      }
    },
  );

  it.each([
    ["TypeError", new TypeError("private sink failure")],
    ["RangeError", new RangeError("private sink failure")],
    ["SyntaxError", new SyntaxError("private sink failure")],
    ["Error", Object.assign(new Error("private sink failure"), { name: "private sink name" })],
    ["non-error", "private sink failure"],
  ])(
    "keeps the HTTP failure when reporting throws %s and rejects an unsafe request ID",
    async (reportingError, sinkError) => {
      const { state, journal } = fixture();
      await journal.ensure();
      state.failedStage = "put";
      state.failureRay = "private invalid request id";
      const log = vi.spyOn(console, "error").mockImplementation(() => {
        throw sinkError;
      });
      try {
        const sealed = await sealCredential(
          key,
          `installation-reset:${account}:original-operation`,
          "private original intent",
          42,
        );
        const error = await journal
          .write("runs/1/original/entry.sealed.json", sealed)
          .catch((failure: unknown) => failure);
        expect(error).toMatchObject({
          name: "ResetJournalWriteError",
          diagnostic: {
            stage: "put",
            httpStatus: 403,
            requestId: null,
            writeOutcome: "unknown",
            reporting: "failed",
            reportingError,
          },
        });
        expect(JSON.stringify(error)).not.toContain("private");
        expect(state.writes).toEqual(["create", "owner.sealed.json", "runs/1/original/entry.sealed.json"]);
      } finally {
        log.mockRestore();
      }
    },
  );

  it("retains an original committed record after a lost response without repeating the write", async () => {
    const { state, journal } = fixture();
    await journal.ensure();
    state.uncertain = true;
    const sealed = await sealCredential(
      key,
      `installation-reset:${account}:original-operation`,
      "original deletion intent",
      42,
    );
    await expect(journal.write("runs/1/original/entry.sealed.json", sealed)).rejects.toThrow("original response lost");
    expect(state.writes).toEqual(["create", "owner.sealed.json", "runs/1/original/entry.sealed.json"]);
    expect(await openCredential(key, JSON.parse(state.objects.get("runs/1/original/entry.sealed.json")!))).toBe(
      "original deletion intent",
    );
  });

  it("refuses foreign ownership, public endpoints and expiration before any write", async () => {
    for (const condition of ["foreign", "public", "expiration"] as const) {
      const { state, journal } = fixture();
      state.exists = true;
      state.public = condition === "public";
      state.expiration = condition === "expiration";
      await expect(journal.ensure()).rejects.toThrow(
        condition === "foreign" ? "no verified owner" : condition === "public" ? "no public endpoint" : "expiration",
      );
      expect(state.writes).toEqual([]);
    }
  });

  it("refuses an unverified readback and never overwrites its original record", async () => {
    const { state, journal } = fixture();
    await journal.ensure();
    state.corrupt = true;
    const sealed = await sealCredential(
      key,
      `installation-reset:${account}:original-operation`,
      "original deletion intent",
      42,
    );
    await expect(journal.write("runs/1/original/entry.sealed.json", sealed)).rejects.toMatchObject({
      message: "original reset journal readback differs; no deletion is allowed",
      diagnostic: {
        stage: "readback",
        reason: "body-mismatch",
        httpStatus: 200,
        requestId: null,
        writeOutcome: "unknown",
      },
    });
    expect(state.writes).toEqual(["create", "owner.sealed.json", "runs/1/original/entry.sealed.json"]);
  });
});
