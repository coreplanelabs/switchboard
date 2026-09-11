import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

// The refresh instance counts its cycle in flight only past the entry gates
// (docs/reference/specs/resident-repos.md item 16c): `inFlightCount()` is what
// `isIdle`, `reconcileImage("refresh")` and the gate's disk-full recycle read,
// and a cycle that counted itself before its own gates would never park, never
// restart a stale image and never recycle a full disk — every gate would see
// one operation in flight: the probing cycle. The instance runs the gates
// inside its fetch step, so the step callback is handed the count and calls it
// once `refreshGate` has answered go — every other step first thing. Plain
// Node, the entry read as text, never loaded — like refresh.test.ts.

const source = readSource("worker.ts");

/** One method of `ResidentDO`, asserting the entry declares it. */
function method(name: string): string {
  const body = methodOf(source, name);
  expect(body, `worker.ts declares ${name}`).not.toBeNull();
  return body!;
}

describe("the refresh instance counts its cycle in flight only past the entry gates", () => {
  it("runInstanceStep hands the step its count instead of counting before the step runs — the one increment sits inside that closure", () => {
    const body = method("runInstanceStep");
    expect(body.match(/refreshesInFlight\+\+/g)?.length, "exactly one increment").toBe(1);
    expect(body).toMatch(/const count = \(\) => \{[\s\S]{0,160}?this\.refreshesInFlight\+\+;/);
    expect(body).toMatch(/if \(counted\) this\.refreshesInFlight--;/);
  });

  it("a failure is excluded from the disk-full recovery's in-flight count only when the cycle counted itself — a failure inside the gates contributed nothing", () => {
    const body = method("runInstanceStep");
    expect(body).toMatch(/refreshFailed\(failure, counted \? 1 : 0\)/);
    expect(body).not.toMatch(/refreshFailed\(failure, 1\)/);
  });

  it("the fetch step counts only once refreshGate has answered go — the gates see the cycle as not in flight", () => {
    const body = method("refreshInstanceFetch");
    const gate = body.indexOf("await this.refreshGate(");
    const count = body.indexOf("cycle.count();");
    expect(gate, "the fetch step runs the gates").toBeGreaterThan(-1);
    expect(count, "the fetch step counts its cycle").toBeGreaterThan(-1);
    expect(count, "the count follows the gates").toBeGreaterThan(gate);
    expect(body.slice(gate, count)).toMatch(/if \(!gate\.go\) return/);
  });

  it.each([
    "refreshInstanceInstall",
    "refreshInstanceBuild",
    "refreshInstanceSnapshot",
    "refreshInstanceSweep",
    "refreshInstanceMeasure",
  ])("%s counts its cycle first thing — no gate runs there", (name) => {
    const body = method(name);
    expect(body).toMatch(/async \(cycle\) => \{\n\s*cycle\.count\(\);/);
  });
});
