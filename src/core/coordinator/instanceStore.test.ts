import { describe, expect, it } from "vitest";
import { secretsFrom } from "../../secrets.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import {
  buildCoordinatorInstanceStore,
  InMemoryCoordinatorInstanceStore,
  NullCoordinatorInstanceStore,
  WorkerCoordinatorInstanceStore,
  type CoordinatorInstanceStore,
} from "./instanceStore.js";

// Feature: docs/reference/specs/run-history.md item 49 — the parent ship record
// store: one seam, two implementations (the state Worker's table behind an
// HTTPS client, and the in-memory double), plus the null store of a process
// without a durable state Worker. The same contract runs against both.

const instance: CoordinatorInstance = {
  id: "ship_acme_api_1",
  kind: "ship",
  userId: "slack:UALICE",
  channelId: "slack:C1",
  threadKey: "slack:C1:1.0",
  repo: "acme/api",
  branch: "plan/orchestration/u12",
  createdAt: 1_000,
};

/** A state Worker double: the two routes over an in-memory table, recording every request. */
function workerDouble() {
  const rows = new Map<string, string>();
  const units = new Map<string, string>();
  const calls: Array<{ path: string; body: Record<string, unknown>; auth: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path, body, auth: new Headers(init?.headers).get("authorization") });
    if (path === "/runs/coordinator/put") {
      const inst = body.instance as CoordinatorInstance;
      const text = JSON.stringify(inst);
      const existing = rows.get(inst.id);
      if (existing !== undefined && existing !== text)
        return Response.json({ ok: false, reason: "exists" }, { status: 409 });
      rows.set(inst.id, text);
      return Response.json({ ok: true });
    }
    if (path === "/runs/coordinator/get") {
      const text = rows.get(body.id as string);
      return Response.json({ instance: text ? JSON.parse(text) : null });
    }
    if (path === "/runs/coordinator/units/put") {
      for (const u of body.units as CoordinatorUnit[]) units.set(`${u.instanceId}/${u.unit}`, JSON.stringify(u));
      return Response.json({ ok: true });
    }
    if (path === "/runs/coordinator/units/list") {
      const out = [...units.entries()]
        .filter(([k]) => k.startsWith(`${body.instanceId as string}/`))
        .map(([, text]) => JSON.parse(text) as CoordinatorUnit);
      return Response.json({ units: out });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
  return { fetchImpl, calls };
}

const unitRow = (unit: string, over: Partial<CoordinatorUnit> = {}): CoordinatorUnit => ({
  instanceId: instance.id,
  unit,
  slug: unit.toLowerCase(),
  branch: `plan/orchestration/${unit.toLowerCase()}`,
  dependsOn: [],
  rounds: [],
  ...over,
});

const contract = (name: string, make: () => CoordinatorInstanceStore) => {
  describe(name, () => {
    it("put stores the record and get reads it back; an identical put is idempotent; a different record under the same id is refused as exists; an unknown id is null", async () => {
      const store = make();
      expect(await store.put(instance)).toEqual({ ok: true });
      expect(await store.get(instance.id)).toEqual(instance);
      expect(await store.put(instance)).toEqual({ ok: true });
      expect(await store.put({ ...instance, branch: "other" })).toEqual({ ok: false, reason: "exists" });
      expect(await store.get(instance.id)).toEqual(instance);
      expect(await store.get("ship_none")).toBeNull();
    });

    // run-history item 50: the unit rows — written at creation, replaced whole
    // as the runner reaches a unit, listed in the order first written.
    it("putUnits writes the rows and listUnits reads an instance's back in first-written order; a row is replaced whole and keeps its place; another instance's rows never appear", async () => {
      const store = make();
      expect(await store.putUnits([unitRow("U12"), unitRow("U13", { dependsOn: ["U12"] })])).toEqual({ ok: true });
      expect(await store.putUnits([{ ...unitRow("U99"), instanceId: "ship_other" }])).toEqual({ ok: true });
      expect((await store.listUnits(instance.id)).map((u) => u.unit)).toEqual(["U12", "U13"]);
      const reached = unitRow("U12", {
        threadKey: "slack:C1:2.0",
        pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      });
      expect(await store.putUnits([reached])).toEqual({ ok: true });
      expect(await store.listUnits(instance.id)).toEqual([reached, unitRow("U13", { dependsOn: ["U12"] })]);
      expect(await store.listUnits("ship_none")).toEqual([]);
    });
  });
};

contract("InMemoryCoordinatorInstanceStore", () => new InMemoryCoordinatorInstanceStore());
contract(
  "WorkerCoordinatorInstanceStore (over a state Worker double)",
  () =>
    new WorkerCoordinatorInstanceStore({
      baseUrl: "https://memory.test/",
      token: "secret-token",
      storeKey: "runs:default",
      fetch: workerDouble().fetchImpl,
    }),
);

describe("WorkerCoordinatorInstanceStore — the wire", () => {
  it("posts the store key and the record with the bearer; a Worker answer it cannot read is thrown, never guessed", async () => {
    const w = workerDouble();
    const store = new WorkerCoordinatorInstanceStore({
      baseUrl: "https://memory.test",
      token: "secret-token",
      storeKey: "runs:default",
      fetch: w.fetchImpl,
    });
    await store.put(instance);
    await store.get(instance.id);
    expect(w.calls).toEqual([
      { path: "/runs/coordinator/put", body: { storeKey: "runs:default", instance }, auth: "Bearer secret-token" },
      {
        path: "/runs/coordinator/get",
        body: { storeKey: "runs:default", id: instance.id },
        auth: "Bearer secret-token",
      },
    ]);
    const broken = new WorkerCoordinatorInstanceStore({
      baseUrl: "https://memory.test",
      token: "t",
      storeKey: "runs:default",
      fetch: async () => new Response("nope", { status: 500 }),
    });
    await expect(broken.get(instance.id)).rejects.toThrow(/HTTP 500/);
    const malformed = new WorkerCoordinatorInstanceStore({
      baseUrl: "https://memory.test",
      token: "t",
      storeKey: "runs:default",
      fetch: async () => Response.json({ instance: { id: "x", kind: "nope" } }),
    });
    await expect(malformed.get(instance.id)).rejects.toThrow(/not a coordinator instance/);
  });
});

describe("NullCoordinatorInstanceStore and the builder", () => {
  it("the null store knows no instance and no unit, and refuses a put as unavailable", async () => {
    const store = new NullCoordinatorInstanceStore();
    expect(await store.get(instance.id)).toBeNull();
    expect(await store.put(instance)).toEqual({ ok: false, reason: "unavailable" });
    expect(await store.listUnits(instance.id)).toEqual([]);
    expect(await store.putUnits([unitRow("U12")])).toEqual({ ok: false, reason: "unavailable" });
  });

  it("the builder answers the Worker store for a Worker-backed run history and the null store otherwise (no config, a file store, a missing bearer)", () => {
    const secrets = secretsFrom({ MEMORY_TOKEN: "tok" });
    expect(buildCoordinatorInstanceStore({ worker: { baseUrl: "https://memory.test" } }, secrets)).toBeInstanceOf(
      WorkerCoordinatorInstanceStore,
    );
    expect(buildCoordinatorInstanceStore(undefined, secrets)).toBeInstanceOf(NullCoordinatorInstanceStore);
    expect(buildCoordinatorInstanceStore({ store: "file" }, secrets)).toBeInstanceOf(NullCoordinatorInstanceStore);
    expect(
      buildCoordinatorInstanceStore({ worker: { baseUrl: "https://memory.test" } }, secretsFrom({})),
    ).toBeInstanceOf(NullCoordinatorInstanceStore);
  });
});
