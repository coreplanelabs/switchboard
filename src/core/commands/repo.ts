import { z } from "zod";
import { CommandError, commandDefiner, type CommandDef, type CommandRegistry, type JsonValue } from "../commandRegistry.js";
import { renderResidentList, type ResidentAdminClient } from "../repoCommands.js";

// The `repo.*` registrations (#157 R13): today only `repo.list` — the live view
// of the resident registry (every onboarded repo, its lifecycle state, ref,
// sha, last refresh), read from the resident Worker's admin `/residents` route
// on every call (the bot never caches membership). Open in chat as it always
// was; `repo:read` on machine surfaces so no existing token gains it silently.
// The JSON output is the route's body; `render` is the text `repo list` has
// always replied with. The mutating verbs (onboard/offboard/reconfigure/
// rebuild) stay with the legacy parser in repoCommands.ts, behind
// `canManageRepos`; `repo test/build` stay with the operations fast path.

/** Resolves the admin client per call (config can reload); `unavailable`
 *  carries the operator-facing reason when the resident is not configured. */
export interface RepoCommandDeps {
  repo: {
    admin(): ResidentAdminClient | { unavailable: string };
  };
}

const defineCommand = commandDefiner<RepoCommandDeps>();

export const repoList = defineCommand({
  id: "repo.list",
  input: z.object({}),
  scope: "repo:read",
  chatGate: "open",
  effect: "read",
  describe: "Every onboarded resident repo with its live state, ref, sha, and last refresh.",
  render: (output) => renderResidentList(output as Record<string, unknown>),
  handler: async ({ deps }) => {
    const api = deps.repo.admin();
    if ("unavailable" in api) throw new CommandError("unavailable", api.unavailable);
    let res;
    try {
      res = await api.residents();
    } catch (err) {
      throw new CommandError("unavailable", err instanceof Error ? err.message : String(err));
    }
    if (res.status !== 200) throw new CommandError("unavailable", `repo list failed (HTTP ${res.status}): ${String(res.data.error ?? "unknown error")}`);
    return res.data as JsonValue;
  },
});

export const repoCommands: readonly CommandDef<RepoCommandDeps, z.ZodType>[] = [repoList];

export function registerRepoCommands<D extends RepoCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of repoCommands) registry.register(cmd as unknown as CommandDef<D, z.ZodType>);
}
