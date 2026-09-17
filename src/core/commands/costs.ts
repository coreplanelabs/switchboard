import {
  CommandError,
  commandDefiner,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";
import { COSTS_OFF_MESSAGE, type CostsService } from "../costsService.js";

// `costs.snapshot` (docs/reference/specs/costs.md item 6): take the costs
// snapshot now — both billing sources and the run history read once over the
// page's widest range, stored, and served to every reader from then on. The
// refresh loop takes one on its interval by itself; this is the on-demand
// take, the same single-flighted read (a caller arriving while one runs shares
// it). Derived forms: `costs snapshot` in chat and on the CLI,
// `/api/costs.snapshot` (what the page's button posts), the `costs_snapshot`
// MCP tool. Action `costs:write`: held by the admins' `all` and by whoever a
// `grants` entry names — a take costs two provider reads and replaces what
// every viewer sees, so it is never a baseline.

export interface CostsCommandDeps {
  costs: {
    /** The service; a process without cost reporting hands the Null Object, whose take is `unavailable`. */
    service(): Promise<CostsService>;
  };
}

const defineCommand = commandDefiner<CostsCommandDeps>();

/** What a take answers: the stamp, and where the next scheduled one falls. */
export interface CostsSnapshotTaken {
  takenAt: string;
  takenBy: string;
  durationMs: number;
  nextAt: string | null;
}

/** Who a take is credited to in the stamp: the linked person's name (a dashboard session), else the
 *  name the caller's adapter resolved (a Slack profile name), else the caller's id — never `slack:U…`
 *  when Slack knew the person's name. */
export function takerLabel(caller: { id: string; name?: string; actor: { asUser?: { name?: string } } }): string {
  return caller.actor.asUser?.name ?? caller.name ?? caller.id;
}

function renderTaken(output: JsonValue): string {
  const o = output as JsonObject;
  const seconds = (Number(o.durationMs) / 1000).toFixed(1);
  const next = typeof o.nextAt === "string" ? ` · next scheduled ${o.nextAt.slice(0, 16).replace("T", " ")} UTC` : "";
  return `Costs snapshot taken ${String(o.takenAt).slice(0, 16).replace("T", " ")} UTC by ${String(o.takenBy)} in ${seconds} s${next}`;
}

export const costsSnapshot = defineCommand({
  id: "costs.snapshot",
  action: "costs:write",
  effect: "write",
  enabledWhen: (caps) => caps.costs,
  describe:
    "Take the costs snapshot now: read both billing sources and the run history once over the page's widest range, store the result, and serve it to every reader of the costs page from then on.",
  render: renderTaken,
  handler: async ({ caller, deps }) => {
    const service = await deps.costs.service();
    try {
      const stamp = await service.snapshot(takerLabel(caller));
      const taken: CostsSnapshotTaken = { ...stamp, nextAt: service.status().nextAt };
      return taken as unknown as JsonValue;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Off is `unavailable`; a take that failed is `busy` — the same 503 over
      // HTTP, but the code tells a caller "retry" from "not here": the previous
      // snapshot keeps serving and the loop's next tick retries by itself.
      if (message === COSTS_OFF_MESSAGE) throw new CommandError("unavailable", message);
      throw new CommandError(
        "busy",
        `costs snapshot not taken: ${message} — the previous snapshot still serves; try again`,
      );
    }
  },
});

export const costsCommands: readonly CommandDef<CostsCommandDeps>[] = [
  costsSnapshot,
] as unknown as CommandDef<CostsCommandDeps>[];

export function registerCostsCommands<D extends CostsCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of costsCommands) registry.register(cmd as unknown as CommandDef<D>);
}
