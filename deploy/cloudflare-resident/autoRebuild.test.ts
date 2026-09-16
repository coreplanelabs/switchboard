import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

// Item 36 (docs/reference/specs/resident-repos.md): a resident `down` on a
// reason only a rebuild can escape is rebuilt on the `goDown` transition,
// under the budget `residentAutoRebuild.ts` decides; the watchdog is the
// backstop with the same decision over the same history row, and the strike
// counter it used to keep is gone. Plain Node, the entry read as text, never
// loaded — like runtimeUnreachable.test.ts.

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));

function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

describe("the down transition is the trigger", () => {
  it("goDown persists `down`, then judges the auto-rebuild before it hands the error back — and a failure inside the judgement is logged, so the caller still gets its ResidentDownError", () => {
    const body = method("goDown");
    const down = body.indexOf('await this.setResidentState("down", reason)');
    const judge = body.indexOf('await this.autoRebuildFromDown(reason, "transition")');
    const back = body.indexOf("return new ResidentDownError(reason)");
    expect(down).toBeGreaterThan(-1);
    expect(judge).toBeGreaterThan(down);
    expect(back).toBeGreaterThan(judge);
    expect(body).toMatch(/autoRebuildFromDown\(reason, "transition"\)\.catch\(\(err\) =>\s*console\.log\(/);
  });

  it("autoRebuildFromDown is the one reader and writer of the history row, decides through the pure module, rebuilds as `auto` so the history survives, and records the instant only once the rebuild has started", () => {
    const body = method("autoRebuildFromDown");
    expect(body).toMatch(/autoRebuildDecision\(\{ reason, history, now: systemClock\(\) \}\)/);
    const rebuild = body.search(
      /this\.rebuild\(resource, record\.defaultRef, record\.provisioningTimeoutMs, false, \{\s*auto: true,?\s*\}\)/,
    );
    const refused = body.indexOf('if ("error" in result)');
    const recorded = body.lastIndexOf("await this.ctx.storage.put(AUTO_REBUILDS_KEY, decision.history)");
    expect(rebuild).toBeGreaterThan(-1);
    expect(refused).toBeGreaterThan(rebuild);
    // A refused rebuild spends no budget: the write comes after the refusal check.
    expect(recorded).toBeGreaterThan(refused);
    // A spent budget is written to the reason (once — the pure decision
    // refuses a stamped reason), and the resident stays down.
    expect(body).toMatch(/await this\.setResidentState\("down", decision\.reason\)/);
    const others = residentDO.replace(body, "").replace(method("rebuild"), "").replace(method("getResidentInfo"), "");
    expect(others).not.toMatch(/AUTO_REBUILDS_KEY/);
  });

  it("a person's rebuild clears the history; the automatic one keeps it — the history IS the budget's count", () => {
    const body = method("rebuild");
    expect(body).toMatch(/if \(!opts\.auto\) await this\.ctx\.storage\.delete\(AUTO_REBUILDS_KEY\)/);
    expect(body).toMatch(/opts: \{ auto\?: boolean \} = \{\}/);
  });
});

describe("the watchdog is the backstop, never a strike counter", () => {
  it("the down branch takes the same decision through autoRebuildFromDown and reports `auto-rebuilt` when it acted", () => {
    const body = method("watchdogCheckLifecycle");
    const down = body.slice(body.indexOf('if (status.state === "down")'));
    expect(down).toMatch(/await this\.autoRebuildFromDown\(status\.reason, "watchdog"\)/);
    expect(down).toMatch(/action: "auto-rebuilt"/);
  });

  it("no strike counter survives in the entry: the retired row is deleted on a serving pass and written nowhere", () => {
    expect(source).toMatch(/^const RETIRED_REBUILD_STRIKES_KEY = "resident:rebuildStrikes";$/m);
    expect(source).not.toMatch(/AUTO_REBUILD_AFTER_STRIKES|(?<!RETIRED_)REBUILD_STRIKES_KEY/);
    expect(method("watchdogCheckLifecycle")).toMatch(/storage\.delete\(RETIRED_REBUILD_STRIKES_KEY\)/);
    expect(residentDO).not.toMatch(/storage\.put\(RETIRED_REBUILD_STRIKES_KEY/);
  });

  it("a serving pass does not clear the auto-rebuild history — a resident that flaps is judged with its earlier rebuilds in view", () => {
    expect(method("watchdogCheckLifecycle")).not.toMatch(/storage\.delete\(AUTO_REBUILDS_KEY\)/);
  });
});

describe("the fault injection and the read view", () => {
  it("`force-down` fires the transition itself when asked (`transition: true`) and stays bare otherwise, so both the transition and the backstop are provable live", () => {
    const body = method("debugForceDown");
    expect(body).toMatch(/if \(transition\) \{\s*await this\.goDown\(reason\);/);
    expect(body).toMatch(/await this\.setResidentState\("down", reason\)/);
    expect(source).toMatch(/stub\.debugForceDown\(reason, body\.transition === true\)/);
  });

  it("`/debug info` carries the auto-rebuild instants", () => {
    expect(method("getResidentInfo")).toMatch(
      /autoRebuilds: \(map\.get\(AUTO_REBUILDS_KEY\) as string\[\] \| undefined\) \?\? \[\]/,
    );
  });
});

describe("the wake path reads a killed extract the way the instance step does", () => {
  it("restoreCheckout asks the runtime whether the container is still there and hands the disposition both facts; an interruption travels on the error as its reason", () => {
    const body = method("restoreCheckout");
    expect(body).toMatch(/const runtimeReplaced = isRuntimeReplacement\(err\)/);
    expect(body).toMatch(/runtimeReplaced \? false : await this\.isRuntimeActive\(\)\.catch\(\(\) => null\)/);
    expect(body).toMatch(
      /restoreFailureDisposition\(errMsg\(err\), \{\s*runtimeReplaced,\s*runtimeActive: runtimeActive \?\? undefined,\s*\}\)/,
    );
    expect(body).toMatch(
      /throw new StepError\(err instanceof StepError \? err\.step : "restore", disposition\.reason\)/,
    );
  });
});
