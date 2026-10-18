import { describe, expect, it } from "vitest";
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
    if (method === "PUT") {
      state.writes.push(name);
      state.objects.set(name, String(init?.body));
      if (state.uncertain && name !== "owner.sealed.json") throw new Error("original response lost");
      return page({ key: name });
    }
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
    await expect(journal.write("runs/1/original/entry.sealed.json", sealed)).rejects.toThrow("readback differs");
    expect(state.writes).toEqual(["create", "owner.sealed.json", "runs/1/original/entry.sealed.json"]);
  });
});
