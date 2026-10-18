import { describe, expect, it, vi } from "vitest";
import { resetRepositorySettings, assertRepositorySettingsWritable, type SettingsKv } from "./registrySettings.js";

function store() {
  const data = new Map<string, unknown>();
  const kv: SettingsKv & { transaction<T>(action: (kv: SettingsKv) => Promise<T>): Promise<T> } = {
    get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    list: async <T>(options?: { prefix?: string }) =>
      new Map(
        [...data]
          .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
          .map(([key, value]) => [key, structuredClone(value) as T]),
      ),
    put: async (key, value) => {
      data.set(key, structuredClone(value));
    },
    transaction: async (action) => {
      const before = structuredClone(data);
      try {
        return await action(kv);
      } catch (error) {
        data.clear();
        for (const [key, value] of before) data.set(key, value);
        throw error;
      }
    },
  };
  return { kv, data };
}
const operation = "11111111-1111-4111-8111-111111111111";
const record = { resource: "repo:acme/api", noResident: true, commands: { test: "npm test" }, defaultRef: "main" };
const validate = (value: typeof record) => {
  if (value.resource !== "repo:acme/api") throw new Error("invalid fixture repository");
};

describe("registry reset settings", () => {
  it("reports a frozen write with its operation and preserves refusal when telemetry fails", async () => {
    const source = store();
    await source.kv.put("resident:repo:acme/api", record);
    await resetRepositorySettings(source.kv, "freeze", operation, undefined, validate);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(assertRepositorySettingsWritable(source.kv, "onboard")).rejects.toThrow(
        "repository settings are frozen for reset",
      );
      expect(log.mock.calls).toEqual([
        [JSON.stringify({ event: "repository.settings.frozen_refused", operation, mutation: "onboard" })],
      ]);
      log.mockImplementation(() => {
        throw new Error("telemetry unavailable");
      });
      await expect(assertRepositorySettingsWritable(source.kv, "remove")).rejects.toThrow(
        "repository settings are frozen for reset",
      );
      expect(await resetRepositorySettings(source.kv, "preview", undefined, undefined, validate)).toEqual({
        schema: 1,
        records: [record],
      });
    } finally {
      log.mockRestore();
    }
  });
  it("previews registrations without copying admission history or writing a lock", async () => {
    const source = store();
    await source.kv.put("resident:repo:acme/api", record);
    await source.kv.put("deploy:admission:unknown", { outcome: "unknown" });
    expect(await resetRepositorySettings(source.kv, "preview", undefined, undefined, validate)).toEqual({
      schema: 1,
      records: [record],
    });
    expect([...source.data]).toEqual([
      ["resident:repo:acme/api", record],
      ["deploy:admission:unknown", { outcome: "unknown" }],
    ]);
  });

  it("keeps a persistent freeze and restores only settings into an empty registry", async () => {
    const source = store();
    await source.kv.put("resident:repo:acme/api", record);
    await source.kv.put("deploy:admission:unknown", { outcome: "unknown" });
    const captured = await resetRepositorySettings(source.kv, "freeze", operation, undefined, validate);
    await expect(assertRepositorySettingsWritable(source.kv, "onboard")).rejects.toThrow("frozen for reset");
    const target = store();
    expect(await resetRepositorySettings(target.kv, "restore", operation, captured.records, validate)).toEqual({
      schema: 1,
      records: [record],
    });
    expect([...target.data]).toEqual([
      ["resident:repo:acme/api", record],
      ["installation-reset:settings", { operation, phase: "restored" }],
    ]);
    await assertRepositorySettingsWritable(target.kv, "updateConfig");
    await expect(resetRepositorySettings(target.kv, "restore", operation, [], validate)).rejects.toThrow("not empty");
    const next = "22222222-2222-4222-8222-222222222222";
    expect(await resetRepositorySettings(target.kv, "freeze", next, undefined, validate)).toEqual({
      schema: 1,
      records: [record],
    });
    await expect(assertRepositorySettingsWritable(target.kv, "remove")).rejects.toThrow("frozen for reset");
  });

  it("rejects a target with only an old obligation instead of treating it as empty", async () => {
    const target = store();
    await target.kv.put("deploy:admission:unknown", { outcome: "unknown" });
    await expect(resetRepositorySettings(target.kv, "restore", operation, [record], validate)).rejects.toThrow(
      "not empty",
    );
    expect([...target.data]).toEqual([["deploy:admission:unknown", { outcome: "unknown" }]]);
  });
});
