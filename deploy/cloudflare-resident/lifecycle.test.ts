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

describe("no lifecycle timer — the resident's cycles are Workflow instances, never a self-rearming alarm", () => {
  it("scans the entry, the instance module, the shared tunables and every pure resident module", () => {
    expect(WORKER_FILES.map(([name]) => name)).toEqual(["worker.ts", "refresh.ts", "shared.ts"]);
    expect(PURE_FILES.map(([name]) => name)).toContain("src/execution/residentInstanceId.ts");
    expect(PURE_FILES.map(([name]) => name)).toContain("src/execution/residentRefresh.ts");
    expect(PURE_FILES.map(([name]) => name)).toContain("src/execution/residentState.ts");
  });

  it.each(ALL_FILES)("%s never arms the Durable Object alarm slot: no `setAlarm`", (_name, source) => {
    expect(source).not.toMatch(/setAlarm/);
  });

  it.each(ALL_FILES)("%s has no refresh alarm handler: no `onRefreshAlarm`", (_name, source) => {
    expect(source).not.toMatch(/onRefreshAlarm/);
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
