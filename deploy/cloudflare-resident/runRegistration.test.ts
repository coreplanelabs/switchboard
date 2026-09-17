import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

// A deploy's preflight promises to refuse while a resident has a run in
// flight (docs/reference/specs/resident-repos.md item 44) — but a harness
// run's process lives in the CONTAINER between the bot's operator calls, so
// the in-memory op counters read 0 while it runs and a deploy could roll the
// resident under it. The resident therefore holds a durable registration per
// run, written by the attach and cleared by the binding's eviction (detach,
// sweep, disk pressure — every release path ends in `evictBinding`), and the
// preflight-facing counts (`GET /residents` live view, `GET /status`,
// `/debug info`) add the registrations the op counters do not already see.
// Plain Node, the entry read as text, never loaded (deploy/* convention).

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));

function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

describe("a run's registration is held from attach to release", () => {
  it("registrations are durable rows under their own prefix — a fresh isolate still counts the process that survived in the container", () => {
    expect(source).toMatch(/const RUN_REG_KEY_PREFIX = "runReg:";/);
    expect(source).toMatch(/const runRegKey = \(threadKey: string\) => `\$\{RUN_REG_KEY_PREFIX\}\$\{threadKey\}`;/);
    const register = method("registerRun");
    expect(register).toMatch(/this\.ctx\.storage\.put\(runRegKey\(threadKey\)/);
    expect(register).toMatch(/registeredAt/);
  });

  it("a successful attach registers the run; a refused attach does not", () => {
    const attach = method("attachThreadTraced");
    expect(attach).toMatch(/if \(!\("error" in res\)\) await this\.registerRun\(threadKey\);/);
  });

  it("the binding's eviction clears the registration — detach, sweep and disk pressure all end there", () => {
    const evict = method("evictBinding");
    expect(evict).toMatch(/await this\.ctx\.storage\.delete\(runRegKey\(binding\.threadKey\)\);/);
    // The delete sits on the success path, after the evicted write — a
    // give-way (re-attached during eviction) keeps the registration.
    const put = evict.indexOf("evicted: true");
    const del = evict.indexOf("storage.delete(runRegKey(");
    expect(put).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(put);
  });
});

describe("the preflight-facing counts see registered runs the op counters miss", () => {
  it("registeredRunsBeyondOps counts registrations whose thread has no op in flight, so a run is never counted twice", () => {
    const count = method("registeredRunsBeyondOps");
    expect(count).toMatch(/this\.ctx\.storage\.list<RunRegistration>\(\{ prefix: RUN_REG_KEY_PREFIX \}\)/);
    expect(count).toMatch(/this\.threadOpsInFlight\.get\(r\.threadKey\) \?\? 0\) === 0/);
  });

  it("GET /status adds the registrations (getInFlightCount), so the preflight and a person see the same number", () => {
    const status = method("getInFlightCount");
    expect(status).toMatch(/this\.inFlightCount\(\) \+ \(await this\.registeredRunsBeyondOps\(\)\)/);
  });

  it("the live view's inFlight and runsInFlight (GET /residents, /debug info) both carry the registrations", () => {
    expect(source).toMatch(/inFlight: this\.inFlightCount\(\) \+ registeredRuns,/);
    expect(source).toMatch(/runsInFlight: this\.runsInFlightCount\(\) \+ registeredRuns,/);
  });

  it("the container-lifecycle predicates (isIdle, reconcileImage) keep the in-memory count alone — a stale registration must not pin a container awake", () => {
    const idle = method("isIdle");
    expect(idle).toMatch(/return this\.inFlightCount\(\) === 0;/);
    expect(idle).not.toMatch(/registeredRunsBeyondOps/);
  });
});
