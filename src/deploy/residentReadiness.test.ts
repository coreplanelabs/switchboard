import { describe, expect, it } from "vitest";
import { reconciledResources, residentRegistryProblem, residentWorkerProblem } from "./residentReadiness.js";

const HEAD = "a".repeat(40);
const row = { resource: "repo:acme/api", live: { imageReport: "current" } };
const ready = { draining: null, count: 1, residents: [row] };

describe("resident readiness evidence", () => {
  it("requires exact healthy Worker identity, not a short or missing commit", () => {
    expect(residentWorkerProblem({ status: 200, body: { ok: true, build: { commit: HEAD } } }, HEAD)).toBeUndefined();
    for (const commit of [undefined, "unknown", HEAD.slice(0, 7), "b".repeat(40)])
      expect(residentWorkerProblem({ status: 200, body: { ok: true, build: { commit } } }, HEAD)).toBeDefined();
    expect(residentWorkerProblem({ status: 503, body: { ok: true, build: { commit: HEAD } } }, HEAD)).toBeDefined();
    expect(residentWorkerProblem({ error: "unreachable" }, HEAD)).toContain("unreachable");
  });

  it("accepts a complete current registry including an explicitly empty fleet", () => {
    expect(residentRegistryProblem({ status: 200, body: ready }, [row.resource])).toBeUndefined();
    expect(residentRegistryProblem({ status: 200, body: { draining: null, count: 0, residents: [] } })).toBeUndefined();
  });

  it.each([
    null,
    [],
    {},
    { ...ready, draining: undefined },
    { ...ready, draining: { holds: [row.resource] } },
    { ...ready, count: 2 },
    { ...ready, count: 2, residents: [row, row] },
    { ...ready, residents: [{ live: row.live }] },
    { ...ready, residents: [{ ...row, live: { imageReport: "pending" } }] },
    { ...ready, residents: [{ ...row, live: { imageReport: "stale" } }] },
    { ...ready, residents: [{ ...row, live: { error: "unreachable" } }] },
    { ...ready, residents: [{ ...row, live: { imageReport: "current", error: "unreachable" } }] },
  ])("rejects incomplete, held, stale and unreadable registry evidence: %j", (body) => {
    expect(residentRegistryProblem({ status: 200, body })).toBeDefined();
  });

  it("names missing affected residents and refuses HTTP or transport failure", () => {
    expect(residentRegistryProblem({ status: 200, body: ready }, ["repo:acme/web"])).toContain("repo:acme/web");
    expect(
      residentRegistryProblem({ status: 200, body: { ...ready, draining: { holds: ["repo:acme/held"] } } }),
    ).toContain("repo:acme/held");
    expect(residentRegistryProblem({ status: 401, body: ready })).toContain("HTTP 401");
    expect(residentRegistryProblem({ error: "timeout" })).toContain("timeout");
  });

  it("a malformed or failed reconcile cannot establish the affected fleet", () => {
    expect(
      reconciledResources({
        status: 200,
        body: { reconciled: [{ resource: row.resource, result: "restarted", verified: false }] },
      }),
    ).toEqual([row.resource]);
    expect(reconciledResources({ status: 200, body: { reconciled: [] } })).toEqual([]);
    expect(reconciledResources({ status: 200, body: {} })).toBeUndefined();
    expect(
      reconciledResources({
        status: 200,
        body: { reconciled: [{ resource: row.resource, result: "error", verified: false }] },
      }),
    ).toBeUndefined();
    expect(reconciledResources({ error: "lost answer" })).toBeUndefined();
  });
});
