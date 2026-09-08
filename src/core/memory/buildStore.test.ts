import { describe, expect, it } from "vitest";
import { buildMemoryStore } from "./buildStore.js";
import { InMemoryMemoryStore } from "./stores.js";
import { WorkerMemoryStore } from "./workerStore.js";

// Feature: features/memory.md — process-startup store selection:
// the durable Worker store when memory.worker is configured and its bearer is
// present, otherwise the in-process store WITH a loud durability warning;
// nothing at all when memory is disabled.

describe("buildMemoryStore", () => {
  it("memory disabled/absent → undefined (the dispatcher then uses NullMemoryStore)", () => {
    const warnings: string[] = [];
    expect(buildMemoryStore(undefined, {}, (m) => warnings.push(m))).toBeUndefined();
    expect(
      buildMemoryStore({ enabled: false, worker: { baseUrl: "https://m" } }, { MEMORY_TOKEN: "t" }, (m) =>
        warnings.push(m),
      ),
    ).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("enabled + worker configured + token present → WorkerMemoryStore, no warning", () => {
    const warnings: string[] = [];
    const store = buildMemoryStore(
      { enabled: true, worker: { baseUrl: "https://memory.example" } },
      { MEMORY_TOKEN: "secret" },
      (m) => warnings.push(m),
    );
    expect(store).toBeInstanceOf(WorkerMemoryStore);
    expect(warnings).toEqual([]);
  });

  it("honors a custom tokenEnv", () => {
    const store = buildMemoryStore(
      { enabled: true, worker: { baseUrl: "https://memory.example", tokenEnv: "MY_TOKEN" } },
      { MY_TOKEN: "secret" },
      () => {},
    );
    expect(store).toBeInstanceOf(WorkerMemoryStore);
  });

  // Feature: features/memory.md §29 — the cap is threaded into the store built here.
  it("threads memory.maxRecordsPerScope into the in-process store (a write past it evicts)", async () => {
    const store = buildMemoryStore({ enabled: true, maxRecordsPerScope: 1 }, {}, () => {})!;
    await store.write("org:acme", [{ kind: "fact", text: "first", sourceThreadKey: "slack:C1:1.0" }]);
    await store.write("org:acme", [{ kind: "fact", text: "second", sourceThreadKey: "slack:C1:1.0" }]);
    expect((await store.list("org:acme", 10)).map((r) => r.text)).toEqual(["second"]);
  });

  it("an out-of-range or non-integer memory.maxRecordsPerScope warns and falls back to the default instead of evicting everything / 400ing every write", async () => {
    for (const bad of [0, -5, 2.5, 10_001, Number.NaN]) {
      const warnings: string[] = [];
      const store = buildMemoryStore({ enabled: true, maxRecordsPerScope: bad }, {}, (m) => warnings.push(m))!;
      expect(warnings.some((w) => /maxRecordsPerScope/.test(w) && /500/.test(w))).toBe(true);
      await store.write("org:acme", [{ kind: "fact", text: "first", sourceThreadKey: "slack:C1:1.0" }]);
      await store.write("org:acme", [{ kind: "fact", text: "second", sourceThreadKey: "slack:C1:1.0" }]);
      expect(await store.list("org:acme", 10)).toHaveLength(2); // default cap (500) governs, nothing evicted
    }
  });

  it("enabled without a worker → in-process store and a warning naming the restart loss", () => {
    const warnings: string[] = [];
    const store = buildMemoryStore({ enabled: true }, {}, (m) => warnings.push(m));
    expect(store).toBeInstanceOf(InMemoryMemoryStore);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/restart/i);
    expect(warnings[0]).toMatch(/memory\.worker/);
  });

  it("worker configured but the bearer env is missing/blank → in-process store and a warning naming the env var", () => {
    const warnings: string[] = [];
    const store = buildMemoryStore(
      { enabled: true, worker: { baseUrl: "https://memory.example", tokenEnv: "MEM_TOK" } },
      { MEM_TOK: "   " },
      (m) => warnings.push(m),
    );
    expect(store).toBeInstanceOf(InMemoryMemoryStore);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("MEM_TOK");
  });
});
