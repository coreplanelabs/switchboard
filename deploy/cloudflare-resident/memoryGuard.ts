// The resident guards its own memory (docs/reference/specs/resident-repos.md
// item 70) — the PURE half, kept free of the Sandbox SDK and DO storage so it
// runs under plain-Node vitest (memoryGuard.test.ts) like gc.ts and drain.ts.
// The Worker owns the one real reader (a single exec of CGROUP_READ_ARGV via
// its exec choke point) and feeds this module the raw output; tests feed a
// fake. A container at its cgroup memory cap wedges its own control port and
// every run on it loses its work, so the resident refuses NEW work by name
// while it still can: above the soft threshold a new attach is refused like
// `mirror-busy` (the bot falls back cold or waits, the card says why), above
// the hard threshold a new exec is refused with the numbers — and a command
// already running is never touched: the gate sits at each route's start and
// kills nothing.
import { MEMORY_PRESSURE_REASON } from "../../src/execution/sandboxErrors.js";

export { MEMORY_PRESSURE_REASON };

/** Above this percent of the cgroup memory cap a NEW `/attach` is refused —
 *  new runs go elsewhere while the ones already here finish. */
export const MEMORY_SOFT_LIMIT_PCT = 80;

/** Above this percent a NEW `/exec` is refused too — the resident answers
 *  nothing but the work already in flight, which always runs to completion. */
export const MEMORY_HARD_LIMIT_PCT = 90;

/** One reading of the container's cgroup v2 accounting. */
export interface MemoryReading {
  /** ISO timestamp the caller supplied (the resident's clock seam). */
  at: string;
  /** memory.current — bytes charged to the cgroup now. */
  usedBytes: number;
  /** memory.max — the cap in bytes, or null when the file reads `max` (no cap). */
  capBytes: number | null;
  /** used/cap rounded to whole percent; null without a cap (nothing to gate on). */
  percent: number | null;
  /** cpu.stat's usage_usec, for the same log line; null when absent. */
  cpuUsageUsec: number | null;
}

/** The reader seam: one call returns the raw output of `CGROUP_READ_ARGV`.
 *  A throw of `MemorySampleUnavailable` means "no reading this time" (the
 *  container busy or replaced under the probe) and never disables the gate;
 *  any other throw is an unreadable cgroup and disables it (one log line). */
export interface CgroupReader {
  read(): Promise<string>;
}

/** The one transient escape: the reader could not run at all right now.
 *  `invalidates` says the container the last reading came from is gone (a
 *  runtime replacement under the probe), so the guard forgets that reading —
 *  a dead container's numbers must not gate the work that replaces it. */
export class MemorySampleUnavailable extends Error {
  constructor(
    message: string,
    readonly invalidates = false,
  ) {
    super(message);
  }
}

/** The separator `CGROUP_READ_ARGV` prints between the three files. */
export const CGROUP_FILE_SEPARATOR = ":::";

/** One exec, three files: memory.current, memory.max, cpu.stat from the
 *  container's own cgroup v2 root. `&&` so a missing file is a non-zero exit
 *  (an unreadable cgroup), never a silently short output. */
export const CGROUP_READ_ARGV: readonly string[] = [
  "sh",
  "-c",
  `cat /sys/fs/cgroup/memory.current && echo ${CGROUP_FILE_SEPARATOR} && ` +
    `cat /sys/fs/cgroup/memory.max && echo ${CGROUP_FILE_SEPARATOR} && cat /sys/fs/cgroup/cpu.stat`,
];

/** Parses one reader output into a reading; throws on anything malformed. */
export function parseCgroupOutput(raw: string, at: string): MemoryReading {
  const parts = raw.split(CGROUP_FILE_SEPARATOR).map((p) => p.trim());
  if (parts.length !== 3) throw new Error(`expected 3 cgroup sections, got ${parts.length}`);
  const usedBytes = Number(parts[0]);
  if (!Number.isFinite(usedBytes) || usedBytes < 0) throw new Error(`memory.current is not a byte count: ${parts[0]}`);
  let capBytes: number | null = null;
  if (parts[1] !== "max") {
    capBytes = Number(parts[1]);
    if (!Number.isFinite(capBytes) || capBytes <= 0) throw new Error(`memory.max is not a byte count: ${parts[1]}`);
  }
  const usage = /(?:^|\n)usage_usec (\d+)/.exec(parts[2]);
  const cpuUsageUsec = usage ? Number(usage[1]) : null;
  const percent = capBytes === null ? null : Math.round((usedBytes / capBytes) * 100);
  return { at, usedBytes, capBytes, percent, cpuUsageUsec };
}

/** The one structured line Workers Logs gets per sample: used bytes, cap
 *  bytes, percent (and the cpu counter beside them). */
export function memoryLogLine(r: MemoryReading): string {
  const cap = r.capBytes === null ? "uncapped" : `${r.capBytes} bytes cap`;
  const pct = r.percent === null ? "" : ` (${r.percent}%)`;
  const cpu = r.cpuUsageUsec === null ? "" : ` — cpu usage_usec ${r.cpuUsageUsec}`;
  return `memory: used ${r.usedBytes} bytes of ${cap}${pct}${cpu}`;
}

/** Which route asks the gate. */
export type MemoryGateRoute = "attach" | "exec";

/** A refusal with the numbers on it — the message is the whole story. */
export interface MemoryRefusal {
  reason: typeof MEMORY_PRESSURE_REASON;
  percent: number;
  usedBytes: number;
  capBytes: number;
  message: string;
}

/** The pure gate over one reading: below both thresholds nothing changes; at
 *  or above the soft one a new attach is refused (queued — the caller waits or
 *  falls back, like `mirror-busy`); at or above the hard one a new exec is
 *  refused too. No reading, or no cap, gates nothing. */
export function gateMemory(route: MemoryGateRoute, reading: MemoryReading | null): MemoryRefusal | null {
  if (!reading || reading.percent === null || reading.capBytes === null) return null;
  const { percent, usedBytes, capBytes } = reading;
  const refusal = (message: string): MemoryRefusal => ({
    reason: MEMORY_PRESSURE_REASON,
    percent,
    usedBytes,
    capBytes,
    message,
  });
  if (route === "exec" && percent >= MEMORY_HARD_LIMIT_PCT) {
    return refusal(
      `${MEMORY_PRESSURE_REASON}: resident at ${percent}% of its memory cap (${usedBytes} of ${capBytes} bytes) — ` +
        `a new command is refused above ${MEMORY_HARD_LIMIT_PCT}% while the commands already running finish`,
    );
  }
  if (route === "attach" && percent >= MEMORY_SOFT_LIMIT_PCT) {
    return refusal(
      `${MEMORY_PRESSURE_REASON}: resident near its memory cap, ${percent}% used (${usedBytes} of ${capBytes} bytes), ` +
        `queued — a new attach is refused above ${MEMORY_SOFT_LIMIT_PCT}% until the runs here release memory`,
    );
  }
  return null;
}

/** The message of whatever was thrown (local: this module stays dependency-free). */
const causeText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The guard one resident holds: samples through the reader, keeps the last
 *  reading, gates the two routes — and on an unreadable cgroup logs ONCE and
 *  disables itself for the incarnation instead of refusing everything. */
export class MemoryGuard {
  private disabledWhy: string | null = null;
  private last: MemoryReading | null = null;

  constructor(
    private readonly reader: CgroupReader,
    private readonly log: (line: string) => void,
  ) {}

  /** The last reading taken this incarnation, for `/status` and `/residents`. */
  get lastReading(): MemoryReading | null {
    return this.last;
  }

  /** Whether an unreadable cgroup turned the gate off (the why is logged once). */
  get disabled(): boolean {
    return this.disabledWhy !== null;
  }

  /** Forgets the last reading: the container it measured no longer runs (it
   *  went inactive, or was replaced under the probe), so nothing gates on it
   *  until a fresh sample lands. The gate's disabled state is untouched. */
  invalidate(): void {
    this.last = null;
  }

  /** One reader call, one log line. A `MemorySampleUnavailable` keeps the last
   *  reading and the gate as they were — unless it `invalidates` (the runtime
   *  was replaced under the probe), which forgets the reading so a stale one
   *  never masks the route's own runtime-replaced answer; any other failure
   *  disables the gate. */
  async sample(at: string): Promise<MemoryReading | null> {
    if (this.disabledWhy !== null) return null;
    let raw: string;
    try {
      raw = await this.reader.read();
    } catch (err) {
      if (err instanceof MemorySampleUnavailable) {
        if (err.invalidates) this.last = null;
        return null;
      }
      this.disable(causeText(err));
      return null;
    }
    let reading: MemoryReading;
    try {
      reading = parseCgroupOutput(raw, at);
    } catch (err) {
      this.disable(causeText(err));
      return null;
    }
    this.last = reading;
    this.log(memoryLogLine(reading));
    return reading;
  }

  /** The route's verdict over the last reading; a disabled gate refuses nothing. */
  gate(route: MemoryGateRoute): MemoryRefusal | null {
    if (this.disabledWhy !== null) return null;
    return gateMemory(route, this.last);
  }

  private disable(why: string): void {
    this.disabledWhy = why;
    this.log(`memory: cgroup unreadable — the memory gate is disabled for this incarnation (${why})`);
  }
}
