import {
  commandDefiner,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";
import type { ScheduleStore } from "../scheduleStore.js";
import { nextFire, type ScheduleDef, type ScheduleFiring } from "../schedules.js";

// `schedule.list` (#244, phase 4b): the schedule registry as a command — what
// is armed (`SCHEDULES`, the one catalog every Worker fires from, #307), which
// Worker runs it, when each fires next (UTC, from the cron expression), and the
// newest firing of each from the `ScheduleStore` when one is configured.
// `internal` plumbing (the per-minute container keep-alive) is hidden here
// exactly as on the /runs "Scheduled" panel — this is that panel's text twin.

export interface ScheduleCommandDeps {
  schedule: {
    schedules: readonly ScheduleDef[];
    /** Absent → no firing history (the output says so). */
    store?: ScheduleStore;
    now(): number;
  };
}

const defineCommand = commandDefiner<ScheduleCommandDeps>();

/** Human label for the non-run actions (a `run` shows its command + identity). */
const ACTION_LABEL: Record<string, string> = { healthz: "keep-alive", watchdog: "resident watchdog" };

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export const scheduleList = defineCommand({
  id: "schedule.list",
  action: "schedule:read",
  effect: "read",
  describe: "Every scheduled job (cron, UTC), which Worker fires it, its next firing, and what its last firing did.",
  render: (output) => {
    const o = output as JsonObject;
    const rows = (Array.isArray(o.schedules) ? o.schedules : []).map((s) => s as JsonObject);
    const lines = rows.map((s) => {
      const last = s.last && typeof s.last === "object" && !Array.isArray(s.last) ? (s.last as JsonObject) : undefined;
      const next = typeof s.nextFireAt === "number" ? `next ${utc(s.nextFireAt)}` : "never fires";
      const lastText = last
        ? `last ${utc(Number(last.firedAt))} → ${String(last.outcome)}${last.runId ? ` (run ${String(last.runId).slice(0, 8)})` : ""}`
        : "no firing recorded";
      const what =
        s.action === "run"
          ? `\`${String(s.command)}\` as \`${String(s.identity)}\``
          : `${ACTION_LABEL[String(s.action)] ?? String(s.action)} — not a run`;
      return `• \`${String(s.name)}\` — \`${String(s.cron)}\` · ${String(s.worker)} · ${what} · ${next} · ${lastText}`;
    });
    if (typeof o.firingsUnavailable === "string") lines.push(`⚠️ firing history unavailable: ${o.firingsUnavailable}`);
    return lines.join("\n");
  },
  handler: async ({ deps }) => {
    const now = deps.schedule.now();
    let firings: ScheduleFiring[] = [];
    let firingsUnavailable: string | undefined;
    if (!deps.schedule.store) firingsUnavailable = "no `schedules.worker` configured";
    else {
      try {
        firings = await deps.schedule.store.latest();
      } catch (err) {
        firingsUnavailable = err instanceof Error ? err.message : String(err);
      }
    }
    const byName = new Map(firings.map((f) => [f.schedule, f]));
    return {
      schedules: deps.schedule.schedules
        .filter((s) => !s.internal)
        .map((s) => {
          const last = byName.get(s.name);
          const next = nextFire(s.cron, now);
          return {
            name: s.name,
            worker: s.worker,
            action: s.action.type,
            cron: s.cron,
            description: s.description,
            ...(s.action.type === "run" ? { command: s.action.command, identity: s.action.identity } : {}),
            ...(next !== undefined ? { nextFireAt: next } : {}),
            ...(last ? { last: last as unknown as JsonValue } : {}),
          };
        }),
      ...(firingsUnavailable !== undefined ? { firingsUnavailable } : {}),
    };
  },
});

export const scheduleCommands: readonly CommandDef<ScheduleCommandDeps>[] = [
  scheduleList,
] as unknown as CommandDef<ScheduleCommandDeps>[];

export function registerScheduleCommands<D extends ScheduleCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of scheduleCommands) registry.register(cmd as unknown as CommandDef<D>);
}
