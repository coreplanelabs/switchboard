import { predicateFor } from "../authz/predicate.js";
import {
  commandDefiner,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";
import { formatDuration } from "../time/formatDuration.js";
import type { PlaneService } from "../planeService.js";
import type { PlanePullRequestRow, PlaneRunRow, PlaneTable, PlaneUnitRow } from "../plane/table.js";
import { runDurationMs } from "../runDuration.js";

// `plane show` (docs/reference/specs/orchestration-plane.md item 4; docs/decisions/0064,
// "The table"): what is happening — every live and recently ended run, every
// tracked pull request and every unit, each with its owner and its health, as
// the plane's table. One typed read, so chat, the CLI, `GET /api/plane.show`
// and the `plane_show` MCP tool answer the same rows the `/plane` panel paints,
// and the operator of record 0057 has one command to bind "what is happening"
// to. Action `runs:read`: the table is run facts under the caller's own
// predicate, nothing more; a reader sees exactly the rows `runs list` would show.

export interface PlaneCommandDeps {
  plane: {
    service(): Promise<PlaneService>;
  };
}

const defineCommand = commandDefiner<PlaneCommandDeps>();

const shortId = (id: string) => id.slice(0, 8);

/** A row's health in the user's words (record 0066, "The collapse"): the
 *  `owner-gap` flag reads "unmerged" beside the `merge-ready` it always rides
 *  with — so the line says "merge-ready, unmerged" — and the flags are joined
 *  as a phrase, never the raw flag join. Every other flag is an outcome value
 *  and prints as it is. */
function healthWords(health: readonly string[]): string {
  return health.map((h) => (h === "owner-gap" ? "unmerged" : h)).join(", ");
}

function ownerText(row: PlaneRunRow): string {
  const who = row.owner.name ?? row.owner.id;
  if (who !== undefined) return row.owner.generation ? `${who} (on ${row.owner.generation})` : who;
  return row.owner.generation ? `on ${row.owner.generation}` : "-";
}

function runLine(row: PlaneRunRow, now: number, surface: "chat" | "text"): string {
  const r = row.run;
  const status = r.finished ? (r.provisional ? "unfinished" : (r.status ?? "finished")) : "live";
  const ms = runDurationMs({ startedAt: r.startedAt, receivedAt: r.receivedAt, finishedAt: r.finishedAt }, now);
  const duration = formatDuration(ms, "clock");
  const unit = row.unit ? row.unit.key : "";
  const health = healthWords(row.health);
  if (surface === "chat") {
    const tail = [ownerText(row), unit, health].filter((s) => s !== "").join(" · ");
    return `• \`${shortId(r.id)}\` — ${r.agent ?? "-"} · ${status} · ${duration}${tail ? ` · ${tail}` : ""}`;
  }
  return `${shortId(r.id).padEnd(8)}  ${(r.agent ?? "-").padEnd(8)}  ${status.padEnd(12)}  ${duration.padEnd(8)}  ${ownerText(row).padEnd(24)}  ${unit.padEnd(28)}  ${health}`.trimEnd();
}

function prLine(row: PlanePullRequestRow, surface: "chat" | "text"): string {
  const name = `${row.pr.repo}#${row.pr.number}`;
  const owner = row.owner.unitKey ?? (row.owner.runId ? `run ${shortId(row.owner.runId)}` : "a person");
  const health = healthWords(row.health) || "-";
  if (surface === "chat") return `• ${name} — ${health} · ${owner}`;
  return `${name.padEnd(32)}  ${health.padEnd(24)}  ${owner}`.trimEnd();
}

function unitLine(row: PlaneUnitRow, surface: "chat" | "text"): string {
  const title = row.unit.title ?? row.unit.id;
  const pr = row.unit.pr ? `#${row.unit.pr.number}` : "-";
  const health = healthWords(row.health);
  if (surface === "chat") return `• ${row.unit.unit} — ${title} · ${health} · ${pr}`;
  return `${row.unit.unit.padEnd(40)}  ${health.padEnd(20)}  ${pr.padEnd(8)}  ${title}`.trimEnd();
}

/** The table as text: three sections, each a header and one line per row. */
export function renderPlaneTable(output: JsonValue, surface: "chat" | "text"): string {
  const table = output as unknown as PlaneTable;
  const live = table.runs.filter((r) => !r.run.finished).length;
  const head = `Plane · ${live} live · ${table.runs.length - live} recent · ${table.units.length} units · ${table.pullRequests.length} pull requests`;
  const section = (title: string, lines: string[]) => [
    surface === "chat" ? `*${title}*` : title,
    ...(lines.length ? lines : ["(none)"]),
  ];
  return [
    head,
    ...section(
      "Runs",
      table.runs.map((r) => runLine(r, table.at, surface)),
    ),
    ...section(
      "Units",
      table.units.map((u) => unitLine(u, surface)),
    ),
    ...section(
      "Pull requests",
      table.pullRequests.map((p) => prLine(p, surface)),
    ),
  ].join("\n");
}

export const planeShow = defineCommand({
  id: "plane.show",
  action: "runs:read",
  effect: "read",
  describe:
    "What is happening: every live and recently ended run, every tracked pull request and every ship unit, each with its owner and its health — the plane's table, as text or JSON; nothing written.",
  render: (output) => renderPlaneTable(output, "text"),
  renderChat: (output) => renderPlaneTable(output, "chat"),
  handler: async ({ caller, deps }) => {
    const service = await deps.plane.service();
    const table = await service.table(predicateFor(caller.actor, "runs:read", "run"));
    return table as unknown as JsonObject;
  },
});

export const planeCommands: readonly CommandDef<PlaneCommandDeps>[] = [
  planeShow,
] as unknown as CommandDef<PlaneCommandDeps>[];

export function registerPlaneCommands<D extends PlaneCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of planeCommands) registry.register(cmd as unknown as CommandDef<D>);
}
