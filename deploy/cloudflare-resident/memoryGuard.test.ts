import { describe, expect, it } from "vitest";
import {
  CGROUP_FILE_SEPARATOR,
  CGROUP_READ_ARGV,
  MEMORY_HARD_LIMIT_PCT,
  MEMORY_PRESSURE_REASON,
  MEMORY_SOFT_LIMIT_PCT,
  MemoryGuard,
  MemorySampleUnavailable,
  gateMemory,
  memoryLogLine,
  parseCgroupOutput,
  type CgroupReader,
} from "./memoryGuard";

// Feature: docs/reference/specs/resident-repos.md item 70 — the resident
// guards its own memory: one cgroup v2 reading per /exec and /attach start
// (and on the existing refresh tick), one structured log line per sample, and
// a two-threshold gate that refuses NEW work by name while running commands
// always finish. Plain Node with a fake reader; the Worker's wiring is
// memoryGate.test.ts's scan.

const AT = "2026-09-18T05:00:00.000Z";
const GIB = 1024 ** 3;

/** Raw reader output for a used/cap pair, in CGROUP_READ_ARGV's shape. */
function raw(usedBytes: number, capBytes: number | "max", usageUsec = 123456): string {
  return `${usedBytes}\n${CGROUP_FILE_SEPARATOR}\n${capBytes}\n${CGROUP_FILE_SEPARATOR}\nusage_usec ${usageUsec}\nuser_usec 100\n`;
}

/** A guard over a scripted reader; each sample() consumes the next entry. */
function guard(outputs: Array<string | Error>): { guard: MemoryGuard; lines: string[]; reads: () => number } {
  let calls = 0;
  const reader: CgroupReader = {
    read: () => {
      const next = outputs[calls++];
      if (next === undefined) throw new Error("reader called past its script");
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  const lines: string[] = [];
  return { guard: new MemoryGuard(reader, (l) => lines.push(l)), lines, reads: () => calls };
}

describe("parseCgroupOutput — one exec's output into one reading", () => {
  it("reads used, cap, percent and the cpu counter", () => {
    const r = parseCgroupOutput(raw(6 * GIB, 12 * GIB, 987654), AT);
    expect(r).toEqual({ at: AT, usedBytes: 6 * GIB, capBytes: 12 * GIB, percent: 50, cpuUsageUsec: 987654 });
  });

  it("memory.max reading `max` is an uncapped cgroup: no cap, no percent — nothing to gate on", () => {
    const r = parseCgroupOutput(raw(6 * GIB, "max"), AT);
    expect(r.capBytes).toBeNull();
    expect(r.percent).toBeNull();
    expect(gateMemory("attach", r)).toBeNull();
    expect(gateMemory("exec", r)).toBeNull();
  });

  it("malformed output throws by name: a short split, a non-numeric current, a non-numeric max", () => {
    expect(() => parseCgroupOutput("12345\n", AT)).toThrow(/expected 3 cgroup sections/);
    expect(() => parseCgroupOutput(raw(NaN, 12 * GIB), AT)).toThrow(/memory\.current/);
    expect(() =>
      parseCgroupOutput(`1\n${CGROUP_FILE_SEPARATOR}\nwhat\n${CGROUP_FILE_SEPARATOR}\nusage_usec 1`, AT),
    ).toThrow(/memory\.max/);
  });

  it("the reader command is one exec over the three cgroup v2 files, failing loud on a missing one (&&)", () => {
    expect(CGROUP_READ_ARGV[0]).toBe("sh");
    const script = CGROUP_READ_ARGV[2];
    expect(script).toContain("/sys/fs/cgroup/memory.current");
    expect(script).toContain("/sys/fs/cgroup/memory.max");
    expect(script).toContain("/sys/fs/cgroup/cpu.stat");
    expect(script.split("&&").length).toBe(5); // three cats chained with the two separators
  });
});

describe("the two-threshold gate over one reading", () => {
  it("below both thresholds nothing changes: attach and exec both pass", () => {
    const r = parseCgroupOutput(raw(0.5 * 12 * GIB, 12 * GIB), AT);
    expect(gateMemory("attach", r)).toBeNull();
    expect(gateMemory("exec", r)).toBeNull();
  });

  it("between the thresholds a new attach queues (refused like mirror-busy, the percent in the words) and exec still runs", () => {
    const r = parseCgroupOutput(raw(0.85 * 12 * GIB, 12 * GIB), AT);
    const attach = gateMemory("attach", r);
    expect(attach).not.toBeNull();
    expect(attach!.reason).toBe(MEMORY_PRESSURE_REASON);
    expect(attach!.message).toContain("resident near its memory cap, 85% used");
    expect(attach!.message).toContain("queued");
    expect(attach!.percent).toBe(85);
    expect(gateMemory("exec", r)).toBeNull();
  });

  it("above the hard threshold a new exec is refused with the numbers in its error (and attach stays refused)", () => {
    const used = Math.round(0.93 * 12 * GIB);
    const r = parseCgroupOutput(raw(used, 12 * GIB), AT);
    const exec = gateMemory("exec", r);
    expect(exec).not.toBeNull();
    expect(exec!.reason).toBe(MEMORY_PRESSURE_REASON);
    expect(exec!.message).toContain("93% of its memory cap");
    expect(exec!.message).toContain(`${used} of ${12 * GIB} bytes`);
    expect(exec!.message).toContain("already running finish");
    expect(gateMemory("attach", r)).not.toBeNull();
  });

  it("the thresholds are the named constants, soft below hard", () => {
    expect(MEMORY_SOFT_LIMIT_PCT).toBe(80);
    expect(MEMORY_HARD_LIMIT_PCT).toBe(90);
    const soft = parseCgroupOutput(raw((MEMORY_SOFT_LIMIT_PCT / 100) * 100, 100), AT);
    expect(gateMemory("attach", soft)).not.toBeNull();
    const hard = parseCgroupOutput(raw((MEMORY_HARD_LIMIT_PCT / 100) * 100, 100), AT);
    expect(gateMemory("exec", hard)).not.toBeNull();
  });

  it("no reading gates nothing", () => {
    expect(gateMemory("attach", null)).toBeNull();
    expect(gateMemory("exec", null)).toBeNull();
  });
});

describe("MemoryGuard — sample, log, remember, disable", () => {
  it("each sample logs ONE structured line carrying used bytes, cap bytes and percent, and keeps the reading", async () => {
    const g = guard([raw(6 * GIB, 12 * GIB)]);
    const reading = await g.guard.sample(AT);
    expect(reading?.percent).toBe(50);
    expect(g.lines).toEqual([`memory: used ${6 * GIB} bytes of ${12 * GIB} bytes cap (50%) — cpu usage_usec 123456`]);
    expect(g.guard.lastReading).toEqual(reading);
    expect(memoryLogLine(reading!)).toBe(g.lines[0]);
  });

  it("an unreadable cgroup logs once and disables the gate rather than refusing everything", async () => {
    const g = guard([new Error("cgroup read exit 1: cat: /sys/fs/cgroup/memory.current: No such file or directory")]);
    expect(await g.guard.sample(AT)).toBeNull();
    expect(g.guard.disabled).toBe(true);
    expect(g.lines).toEqual([
      "memory: cgroup unreadable — the memory gate is disabled for this incarnation " +
        "(cgroup read exit 1: cat: /sys/fs/cgroup/memory.current: No such file or directory)",
    ]);
    // Disabled: no refusals, no further reads, no further log lines.
    expect(g.guard.gate("attach")).toBeNull();
    expect(g.guard.gate("exec")).toBeNull();
    expect(await g.guard.sample(AT)).toBeNull();
    expect(g.reads()).toBe(1);
    expect(g.lines.length).toBe(1);
  });

  it("unparsable output disables the same way, naming what failed to parse", async () => {
    const g = guard(["OOMKilled\n"]);
    expect(await g.guard.sample(AT)).toBeNull();
    expect(g.guard.disabled).toBe(true);
    expect(g.lines[0]).toContain("expected 3 cgroup sections");
    expect(g.guard.gate("exec")).toBeNull();
  });

  it("a MemorySampleUnavailable (the container busy under the probe) keeps the last reading and the gate — never a disable", async () => {
    const g = guard([raw(0.95 * 12 * GIB, 12 * GIB), new MemorySampleUnavailable("runtime-busy"), raw(GIB, 12 * GIB)]);
    await g.guard.sample(AT);
    expect(g.guard.gate("exec")?.percent).toBe(95);
    expect(await g.guard.sample(AT)).toBeNull();
    expect(g.guard.disabled).toBe(false);
    expect(g.guard.gate("exec")?.percent).toBe(95); // the last reading still gates
    const recovered = await g.guard.sample(AT);
    expect(recovered?.percent).toBe(8);
    expect(g.guard.gate("exec")).toBeNull();
  });

  it("a MemorySampleUnavailable that invalidates (the runtime replaced under the probe) forgets the reading — a dead container's numbers never gate the work that replaces it", async () => {
    const g = guard([
      raw(0.95 * 12 * GIB, 12 * GIB),
      new MemorySampleUnavailable("runtime-replaced: spawn", true),
      raw(GIB, 12 * GIB),
    ]);
    await g.guard.sample(AT);
    expect(g.guard.gate("exec")?.percent).toBe(95);
    expect(await g.guard.sample(AT)).toBeNull();
    // The stale reading is gone and the gate stays enabled: the route falls
    // through to its own runtime-replaced answer, never `memory-pressure`.
    expect(g.guard.lastReading).toBeNull();
    expect(g.guard.gate("exec")).toBeNull();
    expect(g.guard.gate("attach")).toBeNull();
    expect(g.guard.disabled).toBe(false);
    expect((await g.guard.sample(AT))?.percent).toBe(8); // a fresh sample gates again
  });

  it("invalidate() forgets the reading of a container that went inactive: nothing gates until a fresh sample, and the gate is not disabled", async () => {
    const g = guard([raw(0.85 * 12 * GIB, 12 * GIB), raw(0.85 * 12 * GIB, 12 * GIB)]);
    await g.guard.sample(AT);
    expect(g.guard.gate("attach")?.percent).toBe(85);
    g.guard.invalidate();
    expect(g.guard.lastReading).toBeNull();
    expect(g.guard.gate("attach")).toBeNull();
    expect(g.guard.disabled).toBe(false);
    expect((await g.guard.sample(AT))?.percent).toBe(85); // and a fresh reading gates again
  });

  it("the gate refuses only NEW work by construction: it exposes verdicts alone — no kill, no signal, no process handle", () => {
    const members = Object.getOwnPropertyNames(MemoryGuard.prototype);
    expect(members.sort()).toEqual(
      ["constructor", "disable", "gate", "invalidate", "lastReading", "disabled", "sample"].sort(),
    );
  });
});
