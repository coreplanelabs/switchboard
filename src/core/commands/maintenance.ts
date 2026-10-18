import { z } from "zod";
import {
  CommandError,
  commandDefiner,
  flag,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";
import {
  MaintenanceConflict,
  type MaintenanceService,
  type MaintenanceStore,
  type MaintenanceSnapshot,
  maintenanceScopeSchema,
} from "../maintenance.js";

export interface MaintenanceCommandDeps {
  maintenance?: {
    store: MaintenanceStore;
    service: Pick<MaintenanceService, "announce" | "start" | "end" | "update">;
    inFlight?: () => number;
  };
}
const defineCommand = commandDefiner<MaintenanceCommandDeps>();
const idOption = z.string().uuid().describe("exact maintenance episode ID from announce or status");
const creationOptions = {
  scopes: z
    .string()
    .regex(/^(?:all|(?:agents|residents|web)(?:,(?:agents|residents|web))*)$/)
    .max(64)
    .optional()
    .describe("comma-separated all, agents, residents, web (default all)"),
  reason: z.string().max(500).optional().describe("public reason for the maintenance"),
  channel: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Slack announcement channel name or ID (default switchboard-dev)"),
};
function scopes(value?: string) {
  const values = (value ?? "all").split(",").map((s) => maintenanceScopeSchema.safeParse(s.trim()));
  if (values.some((v) => !v.success))
    throw new CommandError("invalid_input", "Use all, agents, residents, or web as comma-separated scopes.");
  const result = [...new Set(values.map((v) => v.data!))];
  if (result.includes("all") && result.length !== 1) throw new CommandError("invalid_input", "Use all alone.");
  return result;
}
function render(output: JsonValue): string {
  const value = output as JsonObject;
  const episode = value.episode as JsonObject | null;
  const lines = [
    episode
      ? `Maintenance ${String(episode.id)}: ${String(episode.phase)} (${(episode.scopes as string[]).join(", ")}).`
      : "No maintenance episode is recorded.",
  ];
  if (episode) {
    lines.push(`Notice: ${String((episode.notice as JsonObject).status)}.`);
    const thread = episode.thread as JsonObject | undefined;
    if (thread) lines.push(`Updates: ${String(thread.url)}`);
    if (episode.phase === "announced")
      lines.push(`No timer is installed. Have your client run: ${String(value.activationCommand)}`);
  }
  if (value.inFlight !== undefined)
    lines.push(
      `${String(value.inFlight)} work item(s) in flight. This does not prove residents are idle. Read repo workload before resident repair.`,
    );
  return lines.join("\n");
}
function result(state: MaintenanceSnapshot, deps: MaintenanceCommandDeps): JsonObject {
  return {
    ...(state as unknown as JsonObject),
    ...(deps.maintenance?.inFlight ? { inFlight: deps.maintenance.inFlight() } : {}),
    ...(state.episode?.phase === "announced"
      ? {
          activationCommand: `switchboard maintenance start --id ${state.episode.id}`,
          activationTool: { name: "maintenance_start", arguments: { id: state.episode.id } },
          schedule: {
            owner: "client",
            installed: false,
            startsAt: state.episode.startsAt ?? null,
            timing: state.episode.timing,
          },
        }
      : {}),
  };
}
async function execute(
  deps: MaintenanceCommandDeps,
  action: (service: NonNullable<MaintenanceCommandDeps["maintenance"]>) => Promise<MaintenanceSnapshot>,
): Promise<JsonValue> {
  if (!deps.maintenance)
    throw new CommandError(
      "unavailable",
      "Maintenance needs the durable state Worker. Connect the CLI to the hosted service or configure its state Worker.",
    );
  try {
    return result(await action(deps.maintenance), deps);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    if (error instanceof MaintenanceConflict) throw new CommandError("conflict", error.message);
    throw new CommandError(
      "unavailable",
      "Maintenance state could not be verified. Read status before retrying. Notice delivery can have an unknown outcome.",
    );
  }
}
const annotations = {
  destructive: false,
  idempotent: true,
  openWorld: true,
  risk: () => "changes access to Switchboard and posts a public maintenance notice",
};
export const maintenanceCommands: readonly CommandDef<MaintenanceCommandDeps>[] = [
  defineCommand({
    id: "maintenance.status",
    action: "maintenance:read",
    effect: "read",
    describe:
      "Read the durable maintenance episode, notice result, and work in flight. Does not prove resident idleness.",
    render,
    handler: ({ deps }) => execute(deps, (m) => m.store.read()),
  }),
  defineCommand({
    id: "maintenance.announce",
    action: "maintenance:write",
    effect: "write",
    annotations,
    options: z.object({
      ...creationOptions,
      startsAt: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("start timestamp with UTC offset; the client must schedule the returned activation call"),
      timing: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe("notice timing when no timestamp is set (default in a few minutes)"),
    }),
    describe:
      "Announce scoped maintenance in Slack and return the exact activation call for the client's scheduler. Installs no timer.",
    render,
    handler: ({ deps, options, caller }) =>
      execute(deps, (m) => m.service.announce({ ...options, scopes: scopes(options.scopes) }, caller.id)),
  }),
  defineCommand({
    id: "maintenance.start",
    action: "maintenance:write",
    effect: "write",
    annotations,
    options: z.object({ id: idOption.optional(), ...creationOptions }),
    describe:
      "Close access for new requests for an announced episode by ID, or start immediate maintenance. Existing work is not killed. No automatic expiry.",
    render,
    handler: ({ deps, options, caller }) => {
      if (options.id && (options.scopes !== undefined || options.reason !== undefined || options.channel !== undefined))
        throw new CommandError(
          "invalid_input",
          "An episode ID uses its saved scope, reason, and channel. Do not supply replacements.",
        );
      const { scopes: scopeText, ...input } = options;
      return execute(deps, (m) =>
        m.service.start({ ...input, ...(options.id ? {} : { scopes: scopes(scopeText) }) }, caller.id),
      );
    },
  }),
  defineCommand({
    id: "maintenance.end",
    action: "maintenance:write",
    effect: "write",
    annotations,
    options: z.object({
      id: idOption,
      withoutNotice: flag
        .optional()
        .describe(
          "restore access without posting; the operator owns Slack correction, and a prior notice can still arrive",
        ),
    }),
    describe:
      "Restore access for exactly one maintenance episode, or cancel its announcement, and post in its notice thread.",
    render,
    handler: ({ deps, options, caller }) =>
      execute(deps, (m) => m.service.end(options.id, caller.id, options.withoutNotice)),
  }),
  defineCommand({
    id: "maintenance.update",
    action: "maintenance:write",
    effect: "write",
    annotations: { ...annotations, idempotent: false },
    options: z.object({
      id: idOption,
      message: z.string().min(1).max(2000).describe("public progress update; omit recovery estimates"),
    }),
    describe:
      "Post one explicit update in the verified maintenance thread. A repeat posts another update; do not retry an unknown delivery.",
    render,
    handler: ({ deps, options, caller }) =>
      execute(deps, (m) => m.service.update(options.id, options.message, caller.id)),
  }),
] as unknown as CommandDef<MaintenanceCommandDeps>[];
export function registerMaintenanceCommands<D extends MaintenanceCommandDeps>(registry: CommandRegistry<D>): void {
  for (const command of maintenanceCommands) registry.register(command as unknown as CommandDef<D>);
}
