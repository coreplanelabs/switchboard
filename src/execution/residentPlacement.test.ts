import { describe, expect, it } from "vitest";
import { recordResidentPlacement, type ResidentPlacement } from "./residentPlacement.js";

describe("durable resident placement", () => {
  const first: ResidentPlacement = {
    schema: 1,
    resource: "repo:acme/api",
    threadKey: "mcp:default:review-a",
    residentId: "repo:acme/api",
    placementId: "cf5c0a88-820b-45f2-b689-4432d93fbdce",
  };
  const nextId = "5f73a3bb-bd29-48f9-858e-a651670565b4";
  function storage(rows = new Map<string, unknown>()) {
    return {
      get: async (key: string) => rows.get(key),
      put: async (key: string, value: unknown) => {
        rows.set(key, structuredClone(value));
      },
    };
  }

  it("returns the first saved destination after a restart and a changed proposed destination", async () => {
    const rows = new Map<string, unknown>();
    expect(await recordResidentPlacement(storage(rows), first)).toEqual({ ok: true, placement: first });
    expect(
      await recordResidentPlacement(storage(rows), { ...first, residentId: "replica-b", placementId: nextId }),
    ).toEqual({ ok: true, placement: first });
    expect([...rows.values()]).toEqual([first]);
  });

  it("keeps separate placements for separate repositories and threads", async () => {
    const rows = new Map<string, unknown>();
    await recordResidentPlacement(storage(rows), first);
    const otherThread = { ...first, threadKey: "mcp:default:review-b", residentId: "replica-b", placementId: nextId };
    const otherRepo = { ...first, resource: "repo:acme/other", residentId: "repo:acme/other", placementId: nextId };
    expect(await recordResidentPlacement(storage(rows), otherThread)).toEqual({ ok: true, placement: otherThread });
    expect(await recordResidentPlacement(storage(rows), otherRepo)).toEqual({ ok: true, placement: otherRepo });
    expect(await recordResidentPlacement(storage(rows), first)).toEqual({ ok: true, placement: first });
  });

  it("reads the original placement after a committed write loses its acknowledgment", async () => {
    const rows = new Map<string, unknown>();
    const port = storage(rows);
    await expect(
      recordResidentPlacement(
        {
          ...port,
          put: async (key, value) => {
            await port.put(key, value);
            throw new Error("ack lost");
          },
        },
        first,
      ),
    ).rejects.toThrow("ack lost");
    expect(
      await recordResidentPlacement(storage(rows), { ...first, residentId: "replica-b", placementId: nextId }),
    ).toEqual({ ok: true, placement: first });
  });

  it("allows a new placement after a write did not commit and no destination was acknowledged", async () => {
    const rows = new Map<string, unknown>();
    await expect(
      recordResidentPlacement(
        {
          ...storage(rows),
          put: async () => {
            throw new Error("not committed");
          },
        },
        first,
      ),
    ).rejects.toThrow("not committed");
    const next = { ...first, residentId: "replica-b", placementId: nextId };
    expect(await recordResidentPlacement(storage(rows), next)).toEqual({ ok: true, placement: next });
  });

  it.each([
    null,
    {},
    { ...first, schema: 2 },
    { ...first, resource: "repo:acme/other" },
    { ...first, threadKey: "mcp:default:other" },
    { ...first, residentId: "" },
    { ...first, placementId: "" },
  ])("refuses corrupt saved placement without overwriting it: %j", async (corrupt) => {
    const rows = new Map<string, unknown>();
    await recordResidentPlacement(storage(rows), first);
    const key = [...rows.keys()][0];
    rows.set(key, corrupt);
    expect(await recordResidentPlacement(storage(rows), first)).toEqual({ ok: false, reason: "placement-unverified" });
    expect([...rows.entries()]).toEqual([[key, corrupt]]);
  });
});
