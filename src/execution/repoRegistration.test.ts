import { describe, expect, it } from "vitest";
import { registerRepository, residentRecords, type RepositoryStorage } from "./repoRegistration.js";

describe("repository registration without a resident", () => {
  const record = (resource: string, noResident = false) => ({ resource, noResident, defaultRef: "main" });
  function storage() {
    const rows = new Map<string, ReturnType<typeof record>>();
    const port: RepositoryStorage<ReturnType<typeof record>> = {
      get: async (key) => rows.get(key),
      list: async () => new Map(rows),
      put: async (key, value) => {
        rows.set(key, value);
      },
    };
    return { rows, port };
  }

  it("persists cold repositories at the resident cap", async () => {
    const { rows, port } = storage();
    expect(await registerRepository(port, record("repo:acme/warm"), 1)).toMatchObject({ ok: true });
    expect(await registerRepository(port, record("repo:acme/cold", true), 1)).toMatchObject({ ok: true });
    expect(residentRecords([...rows.values()])).toEqual([record("repo:acme/warm")]);
    expect(await registerRepository(port, record("repo:acme/another"), 1)).toMatchObject({ status: 429 });
    expect([...rows.values()]).toContainEqual(record("repo:acme/cold", true));
  });

  it("cold entries never consume a resident slot; legacy entries still do", async () => {
    const { port } = storage();
    await registerRepository(port, record("repo:acme/cold", true), 1);
    expect(await registerRepository(port, record("repo:acme/warm"), 1)).toMatchObject({ ok: true });
    expect(residentRecords([{ resource: "repo:acme/legacy" }, record("repo:acme/cold", true)])).toEqual([
      { resource: "repo:acme/legacy" },
    ]);
  });

  it("refuses mode changes without overwriting either registration", async () => {
    for (const noResident of [true, false]) {
      const { rows, port } = storage();
      const original = record("repo:acme/api", noResident);
      await registerRepository(port, original, 1);
      expect(await registerRepository(port, record("repo:acme/api", !noResident), 1)).toMatchObject({ status: 409 });
      expect([...rows.values()]).toEqual([original]);
    }
  });
});
