import { describe, expect, it } from "vitest";
import { CommandRegistry, bindCommands, renderText, type Caller } from "../commandRegistry.js";
import { InMemoryScheduleStore } from "../scheduleStore.js";
import { SCHEDULES, type ScheduleDef } from "../schedules.js";
import { registerScheduleCommands, scheduleList, type ScheduleCommandDeps } from "./schedule.js";

// Feature: features/live-view.md item 14 (#244) / features/command-registry.md
// (phase 4b): `schedule list` — the schedule registry, next firing (UTC), and
// the newest firing per schedule from the ScheduleStore; the text twin of the
// /runs "Scheduled" panel.

const NOW = Date.UTC(2026, 7, 30, 12, 0); // Sunday 2026-08-30 12:00 UTC
const chat: Caller = { kind: "chat", id: "slack:UX", scopes: new Set(), chatGate: (g) => g === "open" };
const mcp = (...scopes: string[]): Caller => ({ kind: "mcp", id: "mcp:alice", scopes: new Set(scopes) });

function bind(deps: Partial<ScheduleCommandDeps["schedule"]> = {}) {
  const registry = new CommandRegistry<ScheduleCommandDeps>({ audit: () => {} });
  registerScheduleCommands(registry);
  return bindCommands(registry, { schedule: { schedules: SCHEDULES, now: () => NOW, ...deps } });
}

describe("schedule.list", () => {
  it("lists every non-internal registry schedule with its worker, cron, command/identity, and next firing; no store → says firing history is unavailable", async () => {
    const commands = bind();
    const res = await commands.invoke("schedule.list", {}, chat);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const v = res.value as { schedules: Array<Record<string, unknown>>; firingsUnavailable?: string };
    // the `internal` keep-alive is plumbing: hidden here as on the /runs panel (#307)
    expect(v.schedules.map((s) => s.name)).toEqual(SCHEDULES.filter((s) => !s.internal).map((s) => s.name));
    expect(v.schedules.map((s) => s.name)).not.toContain("keep-alive");
    const weekly = v.schedules.find((s) => s.name === "self-improvement")!;
    expect(weekly).toMatchObject({ worker: "bot", action: "run", cron: "0 14 * * 1", command: "friction propose", identity: "cron", nextFireAt: Date.UTC(2026, 7, 31, 14, 0) });
    expect(v.schedules.find((s) => s.name === "resident-watchdog")).toMatchObject({ worker: "resident", action: "watchdog", cron: "*/10 * * * *" });
    expect(weekly.last).toBeUndefined();
    expect(v.firingsUnavailable).toBe("no `schedules.worker` configured");
    const text = renderText(commands.get("schedule.list")!, res.value);
    expect(text).toContain("• `self-improvement` — `0 14 * * 1` · bot · `friction propose` as `cron` · next 2026-08-31 14:00 UTC · no firing recorded");
    expect(text).toContain("• `resident-watchdog` — `*/10 * * * *` · resident · resident watchdog — not a run · next 2026-08-30 12:10 UTC");
    expect(text).not.toContain("keep-alive");
    expect(text).toContain("⚠️ firing history unavailable: no `schedules.worker` configured");
  });

  it("with a store, each schedule carries its newest firing (outcome, run id); a failing store is reported, not thrown; a never-firing cron says so", async () => {
    const store = new InMemoryScheduleStore();
    await store.record({ schedule: "self-improvement", firedAt: NOW - 86_400_000, outcome: "failed", runId: "run-old" });
    await store.record({ schedule: "self-improvement", firedAt: NOW - 3600_000, outcome: "completed", runId: "run-abcdef01", detail: "3 filed" });
    const never: ScheduleDef = { name: "leap", cron: "0 0 30 2 *", worker: "bot", action: { type: "healthz" }, description: "never" };
    const commands = bind({ store, schedules: [...SCHEDULES, never] });
    const res = await commands.invoke("schedule.list", {}, chat);
    if (!res.ok) throw new Error(res.message);
    const v = res.value as { schedules: Array<Record<string, unknown>>; firingsUnavailable?: string };
    expect(v.schedules.find((s) => s.name === "self-improvement")!.last).toEqual({ schedule: "self-improvement", firedAt: NOW - 3600_000, outcome: "completed", runId: "run-abcdef01", detail: "3 filed" });
    expect(v.firingsUnavailable).toBeUndefined();
    const text = renderText(commands.get("schedule.list")!, res.value);
    expect(text).toContain("last 2026-08-30 11:00 UTC → completed (run run-abcd)");
    expect(text).toContain("• `leap` — `0 0 30 2 *` · bot · keep-alive — not a run · never fires");
    const failing = new InMemoryScheduleStore();
    failing.latest = async () => {
      throw new Error("state Worker 503");
    };
    const degraded = await bind({ store: failing }).invoke("schedule.list", {}, chat);
    expect(degraded.ok && (degraded.value as { firingsUnavailable?: string }).firingsUnavailable).toBe("state Worker 503");
  });

  it("is open in chat and schedule:read on machine surfaces", async () => {
    const commands = bind();
    expect(scheduleList).toMatchObject({ scope: "schedule:read", chatGate: "open", effect: "read" });
    expect(await commands.invoke("schedule.list", {}, mcp("runs:read"))).toMatchObject({ ok: false, error: "unauthorized" });
    expect((await commands.invoke("schedule.list", {}, mcp("schedule:read"))).ok).toBe(true);
  });
});
