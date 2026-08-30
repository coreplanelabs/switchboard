import { z } from "zod";
import { DEFAULT_MANIFEST_PATH, type BootstrapResult } from "../../agentEnv/bootstrap.js";
import { CommandError, commandDefiner, flag, type CommandDef, type CommandRegistry, type JsonObject, type JsonValue } from "../commandRegistry.js";

// `env.bootstrap` (phase 4b, CLI only): materialize a downstream service's UAT
// env vars into the agent's execution environment from 1Password — the former
// `agent-env-bootstrap` script as a registry command. Dry-run by default (plan
// only: names + op:// refs, nothing read, nothing written); `--apply` resolves
// each ref through `op read` and writes ONE chmod-600 env file. Values never
// appear in the output — names, counts, and the path only. Not exposed to chat,
// MCP, or HTTP: it shells out on the operator's own machine.

export interface EnvCommandDeps {
  env: {
    bootstrap(opts: { env: string; service: string; apply: boolean; out?: string; manifest: string }, log: (line: string) => void): Promise<BootstrapResult>;
  };
}

const defineCommand = commandDefiner<EnvCommandDeps>();

export const envBootstrap = defineCommand({
  id: "env.bootstrap",
  options: z.object({
    env: z.string().min(1).describe("environment to materialize (UAT only; anything else is refused)"),
    service: z.string().min(1).describe("which downstream service's toolchain env to fill"),
    apply: flag.optional().describe("resolve the refs and WRITE the chmod-600 env file (default: dry-run)"),
    out: z.string().min(1).optional().describe("env-file path (default .agent-env/<service>.<env>.env)"),
    manifest: z.string().min(1).optional().describe(`manifest path (default ${DEFAULT_MANIFEST_PATH})`),
  }),
  scope: "env:write",
  chatGate: "operator",
  effect: "write",
  surfaces: { chat: false, mcp: false, http: false },
  describe: "Populate the agent's execution environment with a downstream service's UAT env vars from 1Password (dry-run unless --apply).",
  render: (output) => ((output as JsonObject).lines as string[]).join("\n"),
  handler: async ({ options, deps }) => {
    const lines: string[] = [];
    let result: BootstrapResult;
    try {
      result = await deps.env.bootstrap(
        { env: options.env, service: options.service, apply: options.apply ?? false, ...(options.out !== undefined ? { out: options.out } : {}), manifest: options.manifest ?? DEFAULT_MANIFEST_PATH },
        (line) => lines.push(line),
      );
    } catch (err) {
      // A refused env, a missing token, an unreadable manifest, a failed `op read`:
      // every one is the host not being ready, named by bootstrap.ts's own text.
      throw new CommandError("unavailable", err instanceof Error ? err.message : String(err));
    }
    // `envMap` (the resolved values) never leaves the handler.
    return { applied: result.applied, entries: result.entries.map((e) => ({ name: e.name, ref: e.ref })) as unknown as JsonValue, lines };
  },
});

export const envCommands: readonly CommandDef<EnvCommandDeps>[] = [envBootstrap] as unknown as CommandDef<EnvCommandDeps>[];

export function registerEnvCommands<D extends EnvCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of envCommands) registry.register(cmd as unknown as CommandDef<D>);
}
