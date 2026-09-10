import {
  commandDefiner,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";

// `status.show`: which build this process is. The facts already existed — the
// bot's `/healthz` serves `build.commit`, `startedAt`, `inFlight`, `draining`
// (src/channels/health.ts) and the deploy's live gate reads them — but nothing
// put them on the command surface, so a person in Slack asking "what build are
// you running?" reached the general agent, which has no way to know (the
// 1.16.0 release smoke). One typed command, derived everywhere: `status show`
// in chat, `switchboard status show` on the CLI, `/api/status.show`, the
// `status_show` MCP tool; every Slack user holds `status:read`
// (CHAT_OPEN_ACTIONS). The same facts ride the About block of every agent's
// prompt (src/core/selfDescription.ts), so the conversational ask is answered too.

/** What the process knows about itself. The bot fills it from the same state
 *  `/healthz` serves; the CLI from its package version and no stamp. */
export interface StatusSnapshot {
  /** The package version this code runs as (`package.json`). */
  version: string;
  /** The commit the running code was built from — `unknown` when nothing stamped it
   *  (a checkout, `wrangler dev`, an image built without `build.json`). Never guessed. */
  commit: string;
  /** When the image was built (ISO 8601), when the stamp carries it. */
  builtAt?: string;
  /** Epoch ms of the process start, when known. */
  startedAt?: number;
  /** Runs (and the writes that trail them) the process is holding right now. */
  inFlight: number;
  /** Whether the process is refusing new work while it hands off (a deploy or restart in progress). */
  draining: boolean;
}

export interface StatusCommandDeps {
  status: { snapshot(): StatusSnapshot };
}

const defineCommand = commandDefiner<StatusCommandDeps>();

/** The commit a person reads: the short form, or the honest word for none. */
export function shortCommit(commit: string): string {
  return commit === "unknown" ? "unknown (nothing stamped this process)" : commit.slice(0, 8);
}

function renderStatus(output: JsonValue): string {
  const o = output as JsonObject;
  const built = typeof o.builtAt === "string" ? ` (built ${o.builtAt})` : "";
  const started = typeof o.startedAt === "string" ? `started ${o.startedAt} · ` : "";
  const n = Number(o.inFlight);
  const inFlight = `${n} run${n === 1 ? "" : "s"} in flight`;
  return [
    `Switchboard ${String(o.version)} · build ${shortCommit(String(o.commit))}${built}`,
    `${started}${inFlight} · ${o.draining === true ? "draining" : "not draining"}`,
  ].join("\n");
}

export const statusShow = defineCommand({
  id: "status.show",
  action: "status:read",
  effect: "read",
  describe: "Which build this process runs: version, commit, when it was built and started, runs in flight, draining.",
  render: renderStatus,
  handler: async ({ deps }) => {
    const s = deps.status.snapshot();
    return {
      version: s.version,
      commit: s.commit,
      ...(s.builtAt !== undefined ? { builtAt: s.builtAt } : {}),
      ...(s.startedAt !== undefined ? { startedAt: new Date(s.startedAt).toISOString() } : {}),
      inFlight: s.inFlight,
      draining: s.draining,
    };
  },
});

export const statusCommands: readonly CommandDef<StatusCommandDeps>[] = [statusShow];

export function registerStatusCommands<D extends StatusCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of statusCommands) registry.register(cmd as unknown as CommandDef<D>);
}
