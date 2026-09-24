import { describe, expect, it } from "vitest";
import { secretsFrom } from "../../secrets.js";
import { capThreadEvent, type CoordinatorInstance, type CoordinatorUnit, type ThreadEvent } from "./contract.js";
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
  const events = new Map<string, ThreadEvent[]>();
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
    if (path === "/runs/coordinator/replace") {
      const inst = body.instance as CoordinatorInstance;
      rows.set(inst.id, JSON.stringify(inst));
      for (const key of [...units.keys()]) if (key.startsWith(`${inst.id}/`)) units.delete(key);
      return Response.json({ ok: true });
    }
    if (path === "/runs/coordinator/get") {
      const text = rows.get(body.id as string);
      return Response.json({ instance: text ? JSON.parse(text) : null });
    }
    if (path === "/runs/coordinator/stop") {
      const text = rows.get(body.instanceId as string);
      if (text === undefined) return Response.json({ ok: false, reason: "unknown_instance" }, { status: 409 });
      const inst = JSON.parse(text) as CoordinatorInstance;
      if (inst.stop === undefined)
        rows.set(body.instanceId as string, JSON.stringify({ ...inst, stop: { at: body.at as number } }));
      return Response.json({ ok: true });
    }
    if (path === "/runs/coordinator/units/put") {
      for (const u of body.units as CoordinatorUnit[]) units.set(`${u.instanceId}/${u.unit}`, JSON.stringify(u));
      return Response.json({ ok: true });
    }
    if (path === "/runs/coordinator/units/claim-legacy-continuation") {
      const expected = body.expected as CoordinatorUnit;
      const recovered = body.recovered as CoordinatorUnit;
      const key = `${expected.instanceId}/${expected.unit}`;
      if (
        recovered.instanceId !== expected.instanceId ||
        recovered.unit !== expected.unit ||
        units.get(key) !== JSON.stringify(expected)
      )
        return Response.json({ ok: false, reason: "stale" }, { status: 409 });
      units.set(key, JSON.stringify(recovered));
      return Response.json({ ok: true });
    }
    if (path === "/runs/coordinator/units/list") {
      const out = [...units.entries()]
        .filter(([k]) => k.startsWith(`${body.instanceId as string}/`))
        .map(([, text]) => JSON.parse(text) as CoordinatorUnit);
      return Response.json({ units: out });
    }
    const eventKey = `${body.instanceId as string}/${body.unit as string}`;
    if (path === "/runs/coordinator/events/append") {
      const list = events.get(eventKey) ?? [];
      const event = body.event as Omit<ThreadEvent, "seq">;
      const existing = event.id !== undefined ? list.find((e) => e.id === event.id) : undefined;
      if (existing !== undefined) return Response.json({ ok: true, seq: existing.seq });
      const seq = (list[list.length - 1]?.seq ?? 0) + 1;
      list.push(capThreadEvent({ ...event, seq }));
      events.set(eventKey, list);
      return Response.json({ ok: true, seq });
    }
    if (path === "/runs/coordinator/events/list") {
      const list = events.get(eventKey) ?? [];
      return Response.json({ events: list.filter((e) => body.unconsumedOnly !== true || e.consumedBy === undefined) });
    }
    if (path === "/runs/coordinator/events/mark-consumed") {
      const list = events.get(eventKey) ?? [];
      for (const e of list)
        if ((body.seqs as number[]).includes(e.seq) && e.consumedBy === undefined) e.consumedBy = body.by as string;
      return Response.json({ ok: true });
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

    // A re-issue over the leftover of an attempt whose create failed: the
    // record is written over whatever the id holds, once the shim said no
    // instance exists — the one write that is never `exists`.
    it("replace writes the record over whatever the id holds — a different record, or none — drops the id's unit rows and no other instance's, and get reads the new one back", async () => {
      const store = make();
      expect(await store.put(instance)).toEqual({ ok: true });
      await store.putUnits([unitRow("U12"), unitRow("U13"), { ...unitRow("U12"), instanceId: "ship_other" }]);
      const again = { ...instance, runId: "run-s2", createdAt: 2_000 };
      expect(await store.replace(again)).toEqual({ ok: true });
      expect(await store.get(instance.id)).toEqual(again);
      expect(await store.listUnits(instance.id)).toEqual([]);
      expect((await store.listUnits("ship_other")).map((u) => u.unit)).toEqual(["U12"]);
      expect(await store.replace({ ...again, id: "ship_fresh" })).toEqual({ ok: true });
      expect(await store.get("ship_fresh")).toEqual({ ...again, id: "ship_fresh" });
    });

    // Record 0060 / issue 1924: the hard stop's mark on the instance row —
    // written when the hosted parent is sealed, read back by the runner's
    // routes; idempotent, keeping the first mark; unknown ids answer by name.
    it("markStopped writes the stop mark on the instance row and get reads it back; a second mark keeps the first `at`; an id no record holds is unknown_instance", async () => {
      const store = make();
      expect(await store.put(instance)).toEqual({ ok: true });
      expect(await store.markStopped(instance.id, 5_000)).toEqual({ ok: true });
      expect(await store.get(instance.id)).toEqual({ ...instance, stop: { at: 5_000 } });
      expect(await store.markStopped(instance.id, 9_000)).toEqual({ ok: true });
      expect(await store.get(instance.id)).toEqual({ ...instance, stop: { at: 5_000 } });
      expect(await store.markStopped("ship_none", 5_000)).toEqual({ ok: false, reason: "unknown_instance" });
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

    it("claimLegacyContinuation replaces only the exact expected row, so one caller wins and stale state is never overwritten", async () => {
      const store = make();
      const legacy = unitRow("U12", {
        pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
        ending: { kind: "merge_ready", report: "ready", at: 2_000 },
      });
      const recovered = {
        ...legacy,
        lastPush: "1".repeat(40),
        publication: {
          repo: "acme/api",
          pr: 7,
          headRef: legacy.branch,
          baseRef: "main",
          expectedHeadSha: "1".repeat(40),
          publicationRef: legacy.branch,
          owner: { instanceId: instance.id, unit: "U12" },
        },
      } satisfies CoordinatorUnit;
      await store.putUnits([legacy]);

      expect(await store.claimLegacyContinuation(legacy, recovered)).toEqual({ ok: true });
      expect(await store.claimLegacyContinuation(legacy, recovered)).toEqual({ ok: false, reason: "stale" });
      expect(await store.claimLegacyContinuation({ ...legacy, unit: "U13" }, recovered)).toEqual({
        ok: false,
        reason: "stale",
      });
      expect(await store.listUnits(instance.id)).toEqual([recovered]);
    });

    // record 0051's reply-as-event rule: the unit's thread events — a sibling of the row,
    // appended in arrival order, consumed once, untouched by a row's put.
    it("appendEvent assigns sequences in order and caps per event; listEvents filters unconsumed; markConsumed is idempotent; a put of the unit row leaves the events untouched", async () => {
      const store = make();
      const key = { instanceId: instance.id, unit: "U12" };
      const event = (
        text: string,
        over: Partial<Parameters<CoordinatorInstanceStore["appendEvent"]>[1]> = {},
      ): Parameters<CoordinatorInstanceStore["appendEvent"]>[1] => ({
        sender: "slack:UALICE",
        text,
        mode: "steer",
        at: 5_000,
        ...over,
      });
      const seeded = event("first", { id: `${instance.id}:U12:ship-request` });
      expect(await store.appendEvent(key, seeded)).toEqual({ ok: true, seq: 1 });
      // The hand-off can be re-issued after its Workflow create failed. The
      // stable seed id returns its original row instead of appending the file twice.
      expect(await store.appendEvent(key, seeded)).toEqual({ ok: true, seq: 1 });
      expect(await store.appendEvent(key, event("second"))).toEqual({ ok: true, seq: 2 });
      // Over the cap: attachments dropped whole, the row saying how many.
      const heavy = {
        ...event("third"),
        attachments: [{ mediaType: "image/png", data: "x".repeat(500 * 1024) }],
      };
      expect(await store.appendEvent(key, heavy)).toEqual({ ok: true, seq: 3 });
      const all = await store.listEvents(key);
      expect(all.map((e) => [e.seq, e.text])).toEqual([
        [1, "first"],
        [2, "second"],
        [3, "third"],
      ]);
      expect(all[2]!.attachments).toBeUndefined();
      expect(all[2]!.attachmentsDropped).toBe(1);
      // Consumed once: a second mark keeps the first consumer, list filters.
      expect(await store.markConsumed(key, [1, 2], "spawn:U12/1/fix")).toEqual({ ok: true });
      expect(await store.markConsumed(key, [1], "spawn:U12/2/fix")).toEqual({ ok: true });
      const unconsumed = await store.listEvents(key, true);
      expect(unconsumed.map((e) => e.seq)).toEqual([3]);
      expect((await store.listEvents(key)).map((e) => e.consumedBy)).toEqual([
        "spawn:U12/1/fix",
        "spawn:U12/1/fix",
        undefined,
      ]);
      // A put of the unit row leaves the events untouched.
      await store.putUnits([unitRow("U12", { threadKey: "slack:C1:2.0" })]);
      expect((await store.listEvents(key)).map((e) => e.seq)).toEqual([1, 2, 3]);
      // Another unit's list is its own.
      expect(await store.listEvents({ instanceId: instance.id, unit: "U13" })).toEqual([]);
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
  it("caps an attachment event before the Worker's request-body fence, so accepted over-cap media becomes a dropped-count row instead of HTTP 413", async () => {
    let sent: Record<string, unknown> | undefined;
    const store = new WorkerCoordinatorInstanceStore({
      baseUrl: "https://memory.test",
      token: "secret-token",
      storeKey: "runs:default",
      fetch: async (_input, init) => {
        const raw = String(init?.body);
        if (new TextEncoder().encode(raw).byteLength > 512 * 1024)
          return Response.json({ error: "request body too large" }, { status: 413 });
        sent = JSON.parse(raw) as Record<string, unknown>;
        return Response.json({ ok: true, seq: 1 });
      },
    });

    await expect(
      store.appendEvent(
        { instanceId: instance.id, unit: "U12" },
        {
          sender: "slack:UALICE",
          text: "Attachments from the ship request.",
          attachments: [{ mediaType: "image/png", data: "x".repeat(1024 * 1024), name: "brief.png" }],
          mode: "steer",
          at: 5_000,
        },
      ),
    ).resolves.toEqual({ ok: true, seq: 1 });
    expect(sent?.event).toMatchObject({
      text: "Attachments from the ship request.",
      attachmentsDropped: 1,
    });
    expect(sent?.event).not.toHaveProperty("attachments");
  });

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
    await store.replace({ ...instance, runId: "run-s2" });
    expect(w.calls).toEqual([
      { path: "/runs/coordinator/put", body: { storeKey: "runs:default", instance }, auth: "Bearer secret-token" },
      {
        path: "/runs/coordinator/get",
        body: { storeKey: "runs:default", id: instance.id },
        auth: "Bearer secret-token",
      },
      {
        path: "/runs/coordinator/replace",
        body: { storeKey: "runs:default", instance: { ...instance, runId: "run-s2" } },
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
    expect(await store.replace(instance)).toEqual({ ok: false, reason: "unavailable" });
    expect(await store.listUnits(instance.id)).toEqual([]);
    expect(await store.putUnits([unitRow("U12")])).toEqual({ ok: false, reason: "unavailable" });
    expect(await store.claimLegacyContinuation(unitRow("U12"), unitRow("U12"))).toEqual({
      ok: false,
      reason: "unavailable",
    });
    const key = { instanceId: instance.id, unit: "U12" };
    expect(await store.appendEvent(key, { sender: "slack:UALICE", text: "x", mode: "steer", at: 1 })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await store.listEvents(key)).toEqual([]);
    expect(await store.markConsumed(key, [1], "run:r1")).toEqual({ ok: false, reason: "unavailable" });
    expect(await store.markStopped(instance.id, 1)).toEqual({ ok: false, reason: "unavailable" });
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
