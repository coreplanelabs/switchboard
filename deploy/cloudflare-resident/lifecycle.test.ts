import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

// No lifecycle timer drives a resident (docs/reference/specs/resident-repos.md
// item 7; docs/decisions/0029-durable-objects-store-workflows-schedule.md): the
// refresh cycle, the worktree sweep and the disk measurement are steps of the
// Workflow instance the cron creates, and the watchdog re-arms nothing — the
// engine records that a cycle is in progress, so a dead chain and its
// `alarm-missed` stamp cannot exist. The one timer left is provisioning's
// (`initResident`: the run at +1 s and its fail-closed deadline), until that
// cycle becomes an instance too. This scan over the sources holds the line:
// plain Node, the files read as text, never loaded — like refresh.test.ts.

const WORKER_FILES = ["worker.ts", "refresh.ts", "shared.ts"].map((name) => [name, readSource(name)] as const);
const PURE_DIR = fileURLToPath(new URL("../../src/execution/", import.meta.url));
const PURE_FILES = readdirSync(PURE_DIR)
  .filter((name) => /^resident.*\.ts$/.test(name) && !/\.test\.ts$/.test(name))
  .sort()
  .map((name) => [`src/execution/${name}`, readFileSync(`${PURE_DIR}${name}`, "utf8")] as const);
const ALL_FILES = [...WORKER_FILES, ...PURE_FILES];

/** The one place a retired callback's name may appear: the list the
 *  constructor deletes rows for (worker.ts RETIRED_SCHEDULE_CALLBACKS). */
const RETIRED_LIST = /const RETIRED_SCHEDULE_CALLBACKS = \[[^\]]*\] as const;/;
const withoutRetiredList = (source: string): string => source.replace(RETIRED_LIST, "");

/** The one alarm the sources may arm: the registry DO's one-shot drain-lift
 *  alarm (record 0064; levels.test.ts pins its shape) — a fleet drain nobody
 *  lifts posts its own expiry to the plane. It lives on ResidentRegistryDO,
 *  never on the resident's own lifecycle code (ResidentDO, the refresh cycle),
 *  so the scan excises that class body and holds the ban over everything else;
 *  a dedicated test below pins that the excised block arms the alarm only at
 *  the drain's `until`. */
const REGISTRY_CLASS_START = "export class ResidentRegistryDO";
const registryClassBody = (source: string): string => {
  const start = source.indexOf(REGISTRY_CLASS_START);
  if (start === -1) return "";
  return source.slice(start, source.indexOf("\nexport ", start + REGISTRY_CLASS_START.length));
};
const withoutRegistryDO = (source: string): string => source.replace(registryClassBody(source), "");

describe("no lifecycle timer — the resident's cycles are Workflow instances, never a self-rearming alarm", () => {
  it("scans the entry, the instance module, the shared tunables and every pure resident module", () => {
    expect(WORKER_FILES.map(([name]) => name)).toEqual(["worker.ts", "refresh.ts", "shared.ts"]);
    expect(PURE_FILES.map(([name]) => name)).toContain("src/execution/residentInstanceId.ts");
    expect(PURE_FILES.map(([name]) => name)).toContain("src/execution/residentRefresh.ts");
    expect(PURE_FILES.map(([name]) => name)).toContain("src/execution/residentState.ts");
  });

  it.each(ALL_FILES)(
    "%s never arms the Durable Object alarm slot outside the registry's drain-lift: no `setAlarm`",
    (_name, source) => {
      expect(withoutRegistryDO(source)).not.toMatch(/setAlarm/);
    },
  );

  it("worker.ts arms the alarm slot only in ResidentRegistryDO, at the drain record's own ends — `until`, the hold's cycle bound, or the earlier of the two — the one-shot drain-lift, never a re-arming cycle", () => {
    const [, source] = WORKER_FILES[0];
    const registry = registryClassBody(source);
    const calls = registry.match(/setAlarm\(/g) ?? [];
    // Every alarm is one-shot at a timestamp the drain record itself carries:
    // `until` (the last resort), `holdsUntil` (the hold's cycle bound, issue
    // 2044), or the earlier of the two when the alarm handler re-arms a
    // replaced record — never a computed "now plus interval" cycle.
    const drainLifts =
      registry.match(
        /setAlarm\(Date\.parse\(\w+\.(?:until|holdsUntil)\)\)|setAlarm\(Math\.min\(\.\.\.ends\.filter\(Number\.isFinite\)\)\)/g,
      ) ?? [];
    expect(calls.length, "the registry arms the drain-lift alarm").toBeGreaterThan(0);
    expect(drainLifts.length, "every registry setAlarm is the drain-lift at `until`").toBe(calls.length);
  });

  it.each(ALL_FILES)(
    "%s has no refresh alarm handler: `onRefreshAlarm` names nothing but a retired row",
    (_name, source) => {
      expect(withoutRetiredList(source)).not.toMatch(/onRefreshAlarm/);
    },
  );

  it("worker.ts declares the retired alarm chain's callbacks — the refresh alarm, the worktree sweep, the disk measure — and no method by those names", () => {
    const [, source] = WORKER_FILES[0];
    const declaration = source.match(RETIRED_LIST);
    expect(declaration, "worker.ts declares RETIRED_SCHEDULE_CALLBACKS").not.toBeNull();
    const names = [...declaration![0].matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(["onRefreshAlarm", "onWorktreeSweep", "onDiskMeasure"]);
    for (const name of names) {
      expect(withoutRetiredList(source), `${name} is declared as a method`).not.toMatch(
        new RegExp(`^ {2}(?:private |public )?(?:async )?${name}\\(`, "m"),
      );
    }
  });

  it("ResidentDO's constructor deletes every retired callback's rows before the first event — the SDK's alarm loop skips a row whose callback is gone without deleting it", () => {
    const [, source] = WORKER_FILES[0];
    const residentDO = source.slice(source.indexOf("export class ResidentDO"));
    const body = methodOf(residentDO, "constructor");
    expect(body, "ResidentDO declares a constructor").not.toBeNull();
    expect(body).toMatch(/super\(/);
    expect(body).toMatch(/for \(const name of RETIRED_SCHEDULE_CALLBACKS\) this\.deleteSchedules\(name\)/);
    expect(body).not.toMatch(/blockConcurrencyWhile|await /);
  });

  it.each(ALL_FILES)("%s has no `alarm-missed` reason — nothing can stamp it", (_name, source) => {
    expect(source).not.toMatch(/alarm-missed/);
  });

  it("worker.ts schedules a callback only inside `initResident` — the provisioning run and its fail-closed deadline, the one timer left", () => {
    const [, source] = WORKER_FILES[0];
    const body = methodOf(source, "initResident");
    expect(body, "worker.ts declares initResident").not.toBeNull();
    const start = source.indexOf(body!);
    const end = start + body!.length;
    const calls = [...source.matchAll(/\bschedule\(/g)].map((m) => m.index);
    expect(calls.length).toBeGreaterThan(0);
    for (const at of calls) {
      const line = source.slice(0, at).split("\n").length;
      expect(at >= start && at < end, `worker.ts:${line} schedules a callback outside initResident`).toBe(true);
    }
    expect(body).toMatch(/schedule\([^;]*PROVISIONING_CALLBACK/);
    expect(body).toMatch(/schedule\([^;]*PROVISION_RUN_CALLBACK/);
  });

  it.each([...WORKER_FILES.slice(1), ...PURE_FILES])("%s schedules no callback at all", (_name, source) => {
    expect(source).not.toMatch(/\bschedule\(/);
  });
});
