import { describe, expect, it } from "vitest";
import { buildMemoryStore } from "./buildStore.js";
import { InMemoryMemoryStore } from "./stores.js";
import { WorkerMemoryStore } from "./workerStore.js";

// Feature: features/memory.md — process-startup store selection (PR3, #85):
// the durable Worker store when memory.worker is configured and its bearer is
// present, otherwise the in-process store WITH a loud durability warning;
// nothing at all when memory is disabled.

describe("buildMemoryStore", () => {
  it("memory disabled/absent → undefined (the dispatcher then uses NullMemoryStore)", () => {
    const warnings: string[] = [];
    expect(buildMemoryStore(undefined, {}, (m) => warnings.push(m))).toBeUndefined();
    expect(buildMemoryStore({ enabled: false, worker: { baseUrl: "https://m" } }, { MEMORY_TOKEN: "t" }, (m) => warnings.push(m))).toBeUndefined();
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
