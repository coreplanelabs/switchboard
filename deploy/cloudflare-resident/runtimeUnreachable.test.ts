import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  runtimeUnreachableReason,
  SDK_PORT_READY_ENV,
  WAKE_PORT_READY_MS,
} from "../../src/execution/residentRefresh.js";
import { methodOf, readSource } from "./testing/sourceScan";

// A container whose runtime never answers heals itself
// (docs/reference/specs/resident-repos.md item 64): the SDK's connect abort is
// named `runtime-unreachable` at the one exec choke point, counted in DO
// storage (never in memory — the count must outlive the isolate), and the
// refresh instance escalates on the count: re-arm, stop, destroy and restore
// from the snapshot, then down with a strike-eligible reason. The production
// incident this guards against sat `degraded(refresh-failed: The operation was
// aborted)` for forty minutes while the watchdog re-created an instance every
// bucket and nothing escalated. Plain Node, the entry read as text, never
// loaded — like lifecycle.test.ts and instanceStep.test.ts.

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));

/** One method of `ResidentDO`, asserting the entry declares it. */
function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

/** One top-level function of the entry: from its declaration to the first
 *  line that is a lone closing brace at column 0. */
function functionOf(name: string): string {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  expect(start, `worker.ts declares function ${name}`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 3);
}

/** A top-level `const NAME = /…/;` regex literal of the entry, as a RegExp. */
function regexConst(name: string): RegExp {
  const m = new RegExp(`^const ${name} = /(.*)/([a-z]*);$`, "m").exec(source);
  expect(m, `worker.ts declares the regex ${name}`).not.toBeNull();
  return new RegExp(m![1], m![2]);
}

describe("the unreachable probe is named and counted at the exec choke point", () => {
  it("the counter lives in DO storage under one key, written by noteRuntimeUnreachable and deleted by clearRuntimeUnreachable alone", () => {
    expect(source).toMatch(/^const RUNTIME_UNREACHABLE_KEY = "resident:runtimeUnreachable";$/m);
    expect(method("noteRuntimeUnreachable")).toMatch(/this\.ctx\.storage\.put\(RUNTIME_UNREACHABLE_KEY,/);
    expect(method("clearRuntimeUnreachable")).toMatch(/this\.ctx\.storage\.delete\(RUNTIME_UNREACHABLE_KEY\)/);
    // No other member writes or deletes the row: the count is one fact with one writer.
    const others = residentDO
      .replace(method("noteRuntimeUnreachable"), "")
      .replace(method("clearRuntimeUnreachable"), "");
    expect(others).not.toMatch(/storage\.(?:put|delete)\(RUNTIME_UNREACHABLE_KEY/);
  });

  it("the row carries the count and both instants — first and last — so the fleet watch sees how long the runtime has been silent", () => {
    expect(source).toMatch(
      /interface RuntimeUnreachableRow \{[\s\S]*?count: number;[\s\S]*?firstAt: string;[\s\S]*?lastAt: string;[\s\S]*?\}/,
    );
    const note = method("noteRuntimeUnreachable");
    expect(note).toMatch(/count: (?:\(?prev\??\.count \?\? 0\)? \+ 1|prev \? prev\.count \+ 1 : 1)/);
    expect(note).toMatch(/firstAt: prev\?\.firstAt \?\? /);
    expect(note).toMatch(/lastAt: /);
  });

  it("run() asks about a replacement first, then the unreachable signal — a replaced runtime is never counted — and a successful spawn clears the count", () => {
    const run = method("run");
    const spawnCatch = run.indexOf("} catch (err) {");
    const collect = run.indexOf("await proc.output(");
    expect(spawnCatch).toBeGreaterThan(-1);
    expect(collect).toBeGreaterThan(spawnCatch);
    const inSpawnCatch = run.slice(spawnCatch, collect);
    const replacement = inSpawnCatch.indexOf("isRuntimeReplacement(err)");
    const unreachable = inSpawnCatch.indexOf("isRuntimeUnreachable(err)");
    expect(replacement, "the spawn catch classifies a replacement").toBeGreaterThan(-1);
    expect(unreachable, "the spawn catch classifies the unreachable signal").toBeGreaterThan(replacement);
    expect(inSpawnCatch).toMatch(
      /throw new RuntimeUnreachableError\(\(await this\.noteRuntimeUnreachable\(\)\)\.count, err\)/,
    );
    // The clear sits after the spawn and before the collect: the spawn is the proof the port answered.
    const clear = run.indexOf("await this.clearRuntimeUnreachable()");
    expect(clear, "a successful spawn clears the count").toBeGreaterThan(spawnCatch);
    expect(clear).toBeLessThan(collect);
  });

  it("the signal is read off the error and its cause chain with the pure predicate, and the SDK's message never reaches a state reason raw", () => {
    const fn = functionOf("isRuntimeUnreachable");
    expect(fn).toMatch(
      /for \(const link of selfAndCauses\(err\)\) if \(isRuntimeUnreachableSignal\(link\)\) return true;/,
    );
    expect(source).toMatch(/class RuntimeUnreachableError extends Error \{[\s\S]*?readonly count: number/);
    expect(source).toMatch(/super\(runtimeUnreachableReason\(count\)\)/);
  });

  it("the classifier and the refresh step route a RuntimeUnreachableError before any disk probe — no second 30 s abort for a `df`", () => {
    const classify = method("classifyCycleError");
    const typed = classify.indexOf("instanceof RuntimeUnreachableError");
    expect(typed).toBeGreaterThan(-1);
    expect(typed).toBeLessThan(classify.indexOf("classifyFailure("));
    expect(classify).toMatch(/runtimeUnreachable: \{ count: err\.count \}/);
    const step = method("runInstanceStep");
    const routed = step.indexOf("instanceof RuntimeUnreachableError");
    expect(routed).toBeGreaterThan(-1);
    expect(routed).toBeLessThan(step.indexOf("await this.classifyCycleError(err)"));
    expect(step).toMatch(/await this\.escalateRuntimeUnreachable\(instance, step, err\)/);
  });

  it("the housekeeping steps skip a resident whose runtime is unreachable — nothing to sweep or measure, and no third abort per instance", () => {
    for (const name of ["refreshInstanceSweep", "refreshInstanceMeasure"]) {
      const body = method(name);
      const gate = body.indexOf("await this.runtimeUnreachableRow()");
      expect(gate, `${name} reads the row`).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(body.indexOf("this.housekeeping("));
      expect(body).toMatch(/return \{ status: "stopped", why: "runtime-unreachable" \};/);
    }
  });
});

describe("the ladder — each rung acts once, logs once and hands the step back to the engine", () => {
  const escalate = () => method("escalateRuntimeUnreachable");

  it("decides the rung from the pure ladder over the persisted count and records the rung's reason as the degraded reason", () => {
    const body = escalate();
    expect(body).toMatch(/const rung = runtimeUnreachableRung\(err\.count\);/);
    expect(body).toMatch(/const reason = runtimeUnreachableReason\(err\.count, rung\);/);
    expect(body).toMatch(/await this\.recordRefreshError\(reason\);/);
    expect(body.match(/console\.log\(/g)?.length, "one log line per rung, naming it").toBeGreaterThanOrEqual(1);
    expect(body).toMatch(/rung \$\{rung\}/);
  });

  it("rung 1 (re-arm): degraded with the reason, then the error is thrown so the engine's retry re-enters the step", () => {
    const body = escalate();
    const arm = body.slice(body.indexOf('case "re-arm"'), body.indexOf('case "stop"'));
    expect(arm).toMatch(/await this\.setResidentState\("degraded", reason\);/);
    expect(arm).toMatch(/throw err;/);
    expect(arm).not.toMatch(/this\.stop\(\)|this\.destroy\(\)|goDown\(/);
  });

  it("rung 2 (stop): the incarnation swaps, stop() is sent, degraded with the reason, the step is thrown to the engine", () => {
    const body = escalate();
    const stop = body.slice(body.indexOf('case "stop"'), body.indexOf('case "recreate"'));
    expect(stop).toMatch(/this\.swapIncarnation\(\);/);
    expect(stop).toMatch(/await this\.stop\(\)/);
    expect(stop).toMatch(/await this\.setResidentState\("degraded", reason\);/);
    expect(stop).toMatch(/throw err;/);
    expect(stop).not.toMatch(/this\.destroy\(\)|goDown\(/);
  });

  it("rung 3 (recreate): recreateContainer destroys the VM and keeps every snapshot, then the step is thrown so the retry's wake path restores", () => {
    const body = escalate();
    const recreate = body.slice(body.indexOf('case "recreate"'), body.indexOf('case "down"'));
    expect(recreate).toMatch(/await this\.recreateContainer\(reason\);/);
    expect(recreate).toMatch(/throw err;/);
    const impl = method("recreateContainer");
    expect(impl).toMatch(/this\.swapIncarnation\(\);/);
    const forget = impl.indexOf("await this.forgetRuntimeIdentity()");
    const destroy = impl.indexOf("await this.destroy()");
    expect(forget, "the SDK's runtime identity is forgotten").toBeGreaterThan(-1);
    expect(destroy, "the VM is destroyed").toBeGreaterThan(forget);
    expect(impl).toMatch(/await this\.setResidentState\("degraded", reason\);/);
    expect(impl).not.toMatch(
      /deleteBackupObjects|dropDepsBackups|SNAPSHOT_KEY|DEPS_BACKUP_KEY_PREFIX|initResident|deleteAll/,
    );
    expect(method("forgetRuntimeIdentity")).toMatch(/this\.ctx\.storage\.delete\(SDK_RUNTIME_RECORD_KEY\)/);
  });

  it("rung 4 (down): the VM is destroyed and the resident goes down through goDown with the reason — the step ends failed, never thrown", () => {
    const body = escalate();
    const down = body.slice(body.indexOf('case "down"'));
    expect(down).toMatch(/await this\.destroy\(\)/);
    expect(down).toMatch(/await this\.goDown\(reason\)/);
    expect(down).toMatch(/return \{ status: "failed", reason/);
    expect(down).not.toMatch(/throw err;/);
  });

  it("the down reason is strike-eligible for the watchdog's auto-rebuild, and no rung's reason ever counts toward the park streak or serves an attach", () => {
    const rehydration = regexConst("REHYDRATION_FAILURE_RE");
    expect(rehydration.test(runtimeUnreachableReason(6, "down"))).toBe(true);
    expect(rehydration.test("provision-failed: exit 1")).toBe(false);
    const nonEvidence = regexConst("NON_EVIDENCE_REASON");
    for (const rung of ["re-arm", "stop", "recreate", "down"] as const) {
      expect(nonEvidence.test(runtimeUnreachableReason(2, rung))).toBe(true);
    }
    expect(nonEvidence.test("refresh-failed: The operation was aborted")).toBe(false);
  });
});

describe("the admin op and the read view", () => {
  it("`recreate-container` is admin-scoped by construction: absent from READ_DEBUG_OPS, dispatched by handleDebug, listed among the ops", () => {
    const readOps = /^const READ_DEBUG_OPS = new Set\(\[([^\]]*)\]\);$/m.exec(source);
    expect(readOps, "worker.ts declares READ_DEBUG_OPS").not.toBeNull();
    expect(readOps![1]).not.toMatch(/recreate-container/);
    const debug = functionOf("handleDebug");
    expect(debug).toMatch(/case "recreate-container":/);
    expect(debug).toMatch(/await stub\.debugRecreateContainer\(\)/);
    expect(debug).toMatch(/\(ops: [^)]*recreate-container/);
    // stop-container stays as it was: a SIGTERM, the incarnation swapped.
    expect(debug).toMatch(/case "stop-container":\s*return json\(await stub\.debugStopContainer\(\)\);/);
    expect(method("debugStopContainer")).toMatch(/await this\.stop\(\);/);
  });

  it("debugRecreateContainer refuses a mid-flight or down resident by name, otherwise destroys through recreateContainer and starts the restore", () => {
    const body = method("debugRecreateContainer");
    expect(body).toMatch(/recreate-refused/);
    expect(body).toMatch(/"onboarding" \|\| [\s\S]*?"refreshing" \|\| [\s\S]*?"restoring"/);
    expect(body).toMatch(/=== "down"/);
    expect(body).toMatch(/await this\.recreateContainer\(/);
    expect(body).toMatch(/this\.ensureHydrated\(\)/);
    expect(body).toMatch(/recreated: true/);
    expect(body).toMatch(/restoreStartedAt/);
  });

  it("/debug info answers the counter and its rung under `runtimeUnreachable` (read scope sees it)", () => {
    const info = method("getResidentInfo");
    expect(info).toMatch(/RUNTIME_UNREACHABLE_KEY,/);
    expect(info).toMatch(/runtimeUnreachable: /);
    expect(info).toMatch(/rung: runtimeUnreachableRung\(/);
  });
});

describe("the escape hatches start on a fresh container and leave the object able to serve again", () => {
  it("rebuild forgets the SDK's runtime identity and destroys the container before it reprovisions — the incident's rebuild reprovisioned onto the same wedged VM", () => {
    const body = method("rebuild");
    const dry = body.indexOf("if (dryRun) return plan;");
    const forget = body.indexOf("await this.forgetRuntimeIdentity()");
    const destroy = body.indexOf("await this.destroy()");
    const init = body.indexOf("await this.initResident(");
    expect(dry).toBeGreaterThan(-1);
    expect(forget, "the identity is forgotten past the dry run").toBeGreaterThan(dry);
    expect(destroy, "the destroy follows the forget").toBeGreaterThan(forget);
    expect(init, "provisioning starts on the fresh container").toBeGreaterThan(destroy);
    expect(body.slice(dry, init)).toMatch(/this\.swapIncarnation\(\);/);
  });

  it("teardown deletes every stored key but never drops the SDK's tables — a same-isolate onboard after an offboard must find `container_schedules`", () => {
    const body = method("teardown");
    expect(body).not.toMatch(/storage\.deleteAll\(/);
    expect(body).toMatch(/await this\.ctx\.storage\.list\(\)/);
    expect(body).toMatch(/storage\.delete\(keys\.slice\(i, i \+ 128\)\)/);
    expect(body).toMatch(/await this\.ctx\.storage\.deleteAlarm\(\);/);
    expect(residentDO).not.toMatch(/storage\.deleteAll\(/);
  });

  it("initResident rolls the state row back when arming fails, so no resident is left `onboarding` with nothing scheduled", () => {
    const body = method("initResident");
    const schedule = body.indexOf("await this.schedule(");
    const rollback = body.indexOf(
      "await this.ctx.storage.delete([RESOURCE_KEY, STATE_KEY, REASON_KEY, UPDATED_KEY, DEADLINE_AT_KEY]);",
    );
    expect(schedule).toBeGreaterThan(-1);
    expect(rollback, "the arming failure deletes what the onboard wrote").toBeGreaterThan(schedule);
    expect(body.slice(schedule, rollback)).toMatch(/\} catch \(err\) \{/);
    expect(body.slice(rollback)).toMatch(/throw err;/);
  });
});

describe("the wake budget — the first connect after a start waits for the control port through the SDK's knob", () => {
  it(`wrangler.template.jsonc sets ${SDK_PORT_READY_ENV} to WAKE_PORT_READY_MS`, () => {
    const template = readFileSync(fileURLToPath(new URL("./wrangler.template.jsonc", import.meta.url)), "utf8");
    const m = new RegExp(`"${SDK_PORT_READY_ENV}": "(\\d+)"`).exec(template);
    expect(m, `the template declares ${SDK_PORT_READY_ENV}`).not.toBeNull();
    expect(Number(m![1])).toBe(WAKE_PORT_READY_MS);
  });
});
