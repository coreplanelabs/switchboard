import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Secret } from "../secrets.js";
import { handlePlaneEffects, type PlaneEffectsDeps } from "./planeEffects.js";
import type { PlaneAckOutcome, PlaneEffect } from "../core/plane/decide.js";

// `POST /plane/effects` — the plane transport's push half (record 0064, "Where
// it lives"): the state Worker's committed effects, forwarded by the shim,
// run through the SAME executor the heartbeat answers use and are acked on
// the object; a failed ack leaves the offer standing to ride the next answer.

const TOKEN = new Secret("memory-token", "MEMORY_TOKEN");

function effect(runId = "q-run-1"): PlaneEffect {
  return { id: `admit:${runId}`, kind: "admit", runId, threadKey: "slack:C1:1.0", request: { text: "queued ask" } };
}

function request(body: unknown, over: { method?: string; bearer?: string } = {}) {
  const writes: { status?: number; body?: string } = {};
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = {
    method: over.method ?? "POST",
    headers: over.bearer === undefined ? {} : { authorization: `Bearer ${over.bearer}` },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(raw, "utf8");
    },
  } as unknown as IncomingMessage;
  const res = {
    headersSent: false,
    writeHead: (status: number) => void (writes.status = status),
    end: (b: string) => void (writes.body = b),
  } as unknown as ServerResponse;
  return { req, res, writes };
}

function harness(over: Partial<PlaneEffectsDeps> = {}) {
  const acked: { id: string; outcome: PlaneAckOutcome }[] = [];
  const admitted: PlaneEffect[] = [];
  const warnings: string[] = [];
  const deps: PlaneEffectsDeps = {
    token: TOKEN,
    execute: {
      draining: () => false,
      admit: async (e) => {
        admitted.push(e);
        return "done";
      },
    },
    ack: async (id, outcome) => void acked.push({ id, outcome }),
    warn: (l) => void warnings.push(l),
    log: () => {},
    ...over,
  };
  return { deps, acked, admitted, warnings };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("POST /plane/effects — the push transport (record 0064)", () => {
  it("runs each pushed effect through the wired executor and acks its word on the object", async () => {
    const h = harness();
    const { req, res, writes } = request({ effects: [effect()] }, { bearer: "memory-token" });
    handlePlaneEffects(req, res, h.deps);
    await settle();
    expect(h.admitted.map((e) => e.id)).toEqual(["admit:q-run-1"]);
    expect(h.acked).toEqual([{ id: "admit:q-run-1", outcome: "done" }]);
    expect(writes.status).toBe(200);
    expect(JSON.parse(writes.body!)).toEqual({ ok: true, acks: [{ id: "admit:q-run-1", outcome: "done" }] });
  });

  it("a draining generation defers, and no wired executor defers too — the offer stays for a bot that can run it", async () => {
    const draining = harness({ execute: { draining: () => true, admit: async () => "done" } });
    let r = request({ effects: [effect()] }, { bearer: "memory-token" });
    handlePlaneEffects(r.req, r.res, draining.deps);
    await settle();
    expect(draining.acked).toEqual([{ id: "admit:q-run-1", outcome: "deferred" }]);
    const unwired = harness({ execute: undefined });
    r = request({ effects: [effect()] }, { bearer: "memory-token" });
    handlePlaneEffects(r.req, r.res, unwired.deps);
    await settle();
    expect(unwired.acked).toEqual([{ id: "admit:q-run-1", outcome: "deferred" }]);
  });

  it("an effect whose execution or ack throws is one warning and stays offered — it rides the next heartbeat answer; the rest of the push still acks", async () => {
    const h = harness({
      execute: {
        draining: () => false,
        admit: async (e) => {
          if (e.runId === "boom") throw new Error("executor failed");
          return "done";
        },
      },
    });
    const { req, res, writes } = request({ effects: [effect("boom"), effect("fine")] }, { bearer: "memory-token" });
    handlePlaneEffects(req, res, h.deps);
    await settle();
    expect(h.acked).toEqual([{ id: "admit:fine", outcome: "done" }]);
    expect(h.warnings[0]).toContain("admit:boom");
    expect(h.warnings[0]).toContain("rides the next heartbeat");
    expect(writes.status).toBe(200);
    expect(JSON.parse(writes.body!).acks).toEqual([{ id: "admit:fine", outcome: "done" }]);
  });

  it("refuses a wrong or missing bearer, and everything when the token is unset (fail closed); refuses non-POST", async () => {
    const h = harness();
    let r = request({ effects: [] }, { bearer: "wrong" });
    handlePlaneEffects(r.req, r.res, h.deps);
    expect(r.writes.status).toBe(401);
    r = request({ effects: [] });
    handlePlaneEffects(r.req, r.res, h.deps);
    expect(r.writes.status).toBe(401);
    const unset = harness({ token: undefined });
    r = request({ effects: [] }, { bearer: "memory-token" });
    handlePlaneEffects(r.req, r.res, unset.deps);
    expect(r.writes.status).toBe(401);
    r = request({ effects: [] }, { bearer: "memory-token", method: "GET" });
    handlePlaneEffects(r.req, r.res, h.deps);
    expect(r.writes.status).toBe(405);
    expect(h.acked).toEqual([]);
  });

  it("a non-JSON body, a body without an effects array and a malformed effect are 400 — nothing runs", async () => {
    for (const body of ["not json", { effects: "nope" }, { effects: [{ kind: "admit", id: "x" }] }]) {
      const h = harness();
      const { req, res, writes } = request(body, { bearer: "memory-token" });
      handlePlaneEffects(req, res, h.deps);
      await settle();
      expect(writes.status).toBe(400);
      expect(h.admitted).toEqual([]);
      expect(h.acked).toEqual([]);
    }
  });
});
