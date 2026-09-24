import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

// Feature: docs/reference/specs/resident-repos.md item 70 — the memory guard's
// Worker wiring: one sample at every /exec and /attach start and on the
// measure tick (the instance the watchdog cron creates — the watchdog's own
// pass reads storage alone), the refusal as the mirror-busy 503 shape, and the
// gauges on /status, /residents and the watchdog answer. Plain Node, the entry
// read as text, never loaded — like runtimeBusy.test.ts; the gate's decisions
// are memoryGuard.test.ts's, over the loaded pure module.

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));

/** One method of `ResidentDO`, asserting the entry declares it. */
function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

describe("the reader is the exec choke point, one exec per sample, never on a sleeping container", () => {
  it("readCgroup runs CGROUP_READ_ARGV through run(); a transport throw is the transient word, a runtime replacement invalidates the reading, a non-zero exit disables", () => {
    const body = method("readCgroup");
    expect(body).toMatch(/await this\.run\(\[\.\.\.CGROUP_READ_ARGV\]\)/);
    // A replaced runtime forgets the reading it came from: the route's own
    // gate answers `runtime-replaced`, never `memory-pressure` off a dead
    // container's numbers.
    expect(body).toMatch(/throw new MemorySampleUnavailable\(errMsg\(err\), err instanceof RuntimeReplacedError\)/);
    expect(body).toMatch(/if \(r\.exitCode !== 0\) throw new Error\(`cgroup read exit /);
  });

  it("sampleMemory samples only an active runtime (item 55: never wake to measure), forgets the reading of an inactive one, and persists the reading for the gauges", () => {
    const body = method("sampleMemory");
    // An inactive container holds no memory: the guard's reading is forgotten
    // so no attach or exec is refused on a container that no longer runs.
    expect(body).toMatch(
      /if \(!\(await this\.isRuntimeActive\(\)\.catch\(\(\) => false\)\)\) \{[\s\S]*?this\.memoryGuard\.invalidate\(\);\s*\n\s*return null;/,
    );
    expect(body).toMatch(/this\.memoryGuard\.sample\(new Date\(systemClock\(\)\)\.toISOString\(\)\)/);
    expect(body).toMatch(/this\.ctx\.storage\.put\(MEMORY_KEY, reading\)/);
  });

  it("no polling loop was added: the sample sites are the two route gates and the measure step, and none arms a timer", () => {
    const sites = residentDO.match(/this\.(?:sampleMemory|memoryGate)\(/g) ?? [];
    // memoryGate's own sampleMemory call + the exec gate + the attach gate +
    // the measure step's sample: four call sites, nothing else.
    expect(sites.length).toBe(4);
    const guard = method("memoryGate") + method("sampleMemory") + method("readCgroup");
    expect(guard).not.toMatch(/setInterval|setTimeout|schedule\(/);
  });
});

describe("the two route gates refuse NEW work as the mirror-busy 503 shape and touch nothing running", () => {
  it("memoryGate samples, asks the pure gate, and answers the typed 503 with the lifecycle pair and the memory-pressure reason — a registered run is sampled but never refused", () => {
    const body = method("memoryGate");
    expect(body).toMatch(/await this\.sampleMemory\(\);/);
    // The exemption sits AFTER the sample (every route start still logs the
    // line) and BEFORE the verdict (a run in flight re-attaches through, as
    // it passes the drain).
    expect(body).toMatch(
      /await this\.sampleMemory\(\);[\s\S]*?if \(exemptRegisteredRun\) return null;[\s\S]*?this\.memoryGuard\.gate\(route\)/,
    );
    expect(body).toMatch(/const refusal = this\.memoryGuard\.gate\(route\);/);
    expect(body).toMatch(/error: refusal\.message/);
    expect(body).toMatch(/status: 503/);
    expect(body).toMatch(/reason: MEMORY_PRESSURE_REASON/);
    expect(body).toMatch(/stateReason: s\.reason/);
    expect(body).not.toMatch(/kill/);
  });

  it("execThreadBody asks the exec gate FIRST — before the preflight, so a refused command starts nothing and a running one is untouched", () => {
    const body = method("execThreadBody");
    const gate = body.indexOf('await this.memoryGate("exec")');
    const preflight = body.indexOf("await this.threadPreflight(threadKey)");
    expect(gate, "the exec gate exists").toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(gate);
    expect(body).toMatch(/const memory = await this\.memoryGate\("exec"\);\s*\n\s*if \(memory\) return memory;/);
  });

  it("attachThreadTraced asks Registry DO drain admission before the attach gate and image reconcile — a refused attach never restarts a container, and a registered run's re-attach passes both gates", () => {
    const body = method("attachThreadTraced");
    const admission = body.indexOf("await this.registry().admitDrainSeed(admissionKey)");
    const gate = body.indexOf('await this.memoryGate("attach"');
    const reconcile = body.indexOf('this.reconcileImage("attach")');
    expect(admission).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(admission);
    expect(reconcile).toBeGreaterThan(gate);
    // ONE registration read decides both gates: the drain's exemption and the
    // memory gate's are the same fact (item 44's row), so they cannot drift.
    expect(body).toMatch(
      /const registered = \(await this\.ctx\.storage\.get\(runRegKey\(threadKey\)\)\) !== undefined;/,
    );
    expect(body).toMatch(/if \(!registered\) \{[\s\S]*?admitDrainSeed\(admissionKey\)[\s\S]*?drainRefusal/);
    expect(body).toMatch(
      /const memory = await this\.memoryGate\("attach", registered\);\s*\n\s*if \(memory\) return memory;/,
    );
  });
});

describe("the last reading is carried where the bot and the pages read", () => {
  it("memoryGauge answers this incarnation's reading or the persisted one — storage only, never an exec", () => {
    const body = method("memoryGauge");
    expect(body).toMatch(
      /this\.memoryGuard\.lastReading \?\? \(await this\.ctx\.storage\.get<MemoryReading>\(MEMORY_KEY\)\) \?\? null/,
    );
    expect(body).not.toMatch(/this\.run\(/);
  });

  it("GET /status carries `memory` from the gauge, in the same flight as the other probes", () => {
    const start = source.indexOf("async function handleStatus(");
    const handler = source.slice(start, source.indexOf("\n}\n", start));
    expect(handler).toMatch(/stub\.memoryGauge\(\)/);
    expect(handler).toMatch(/\n\s*memory,\n/);
  });

  it("the watchdog answer and /residents carry the gauge (storage only — the watchdog never touches the container)", () => {
    const check = method("watchdogCheck");
    expect(check).toMatch(/this\.memoryGauge\(\)/);
    expect(check).toMatch(/memory: MemoryReading \| null/);
    const info = method("getResidentInfo");
    expect(info).toMatch(/memory: \(map\.get\(MEMORY_KEY\) as MemoryReading \| undefined\) \?\? null/);
    const watchdog = source.slice(source.indexOf("async function runWatchdog("));
    expect(watchdog).toMatch(/memory: s\.value\.memory/);
  });

  it("the measure tick samples memory beside the disk — the existing cadence, no new schedule", () => {
    const body = method("refreshInstanceMeasure");
    expect(body).toMatch(/await this\.sampleMemory\(\);/);
    expect(body).toMatch(/this\.measureDisk\(\)/);
  });
});
