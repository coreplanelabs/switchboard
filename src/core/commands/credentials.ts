import { z } from "zod";
import { authorize } from "../authz/authorize.js";
import { CommandError, commandDefiner, type CommandDef, type CommandRegistry } from "../commandRegistry.js";
import type { CredentialInspectionBinding } from "../credentialInspection.js";
import {
  emptyCredentialInspection,
  parseCredentialInspection,
  type CredentialInspection,
} from "../../execution/credentialInspection.js";
import { RUN_ID_PATTERN } from "../runRecord.js";
import { runResource, type RunsService } from "../runsService.js";

export interface CredentialsCommandDeps {
  credentials: {
    runs(): Promise<RunsService>;
    inspect?(runId: string, expected: CredentialInspectionBinding): Promise<CredentialInspection>;
  };
}
const defineCommand = commandDefiner<CredentialsCommandDeps>();
const inspect = defineCommand({
  id: "credentials.inspect",
  args: [{ name: "id", schema: z.string().regex(RUN_ID_PATTERN), describe: "id of an existing live run" }],
  options: z.object({
    backend: z.enum(["resident", "sandbox"]).describe("expected live execution backend"),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .describe("expected repository"),
    ref: z.string().min(1).max(255).describe("expected branch"),
    head: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .describe("expected checkout commit"),
  }),
  action: "credentials:exec",
  effect: "write",
  annotations: {
    destructive: false,
    idempotent: true,
    risk: () => "inspects bounded credential locations in a live workspace",
  },
  describe:
    "Inspect a live run's credential boundary; reports only counts and booleans, never credential contents. Does not test publication or revocation.",
  render: (output) => JSON.stringify(output),
  handler: async ({ args, options, caller, deps }) => {
    const result = await (await deps.credentials.runs()).getRun(args.id);
    if (!result.ok || !authorize(caller.actor, "runs:read", runResource(result.value)).allow)
      throw new CommandError("not_found", "no run found");
    if (result.value.finished || result.value.repo !== options.repo)
      throw new CommandError("conflict", "the live run does not match the requested inspection");
    try {
      return parseCredentialInspection(await deps.credentials.inspect?.(args.id, options));
    } catch {
      return emptyCredentialInspection();
    }
  },
});

export function registerCredentialsCommands<D extends CredentialsCommandDeps>(registry: CommandRegistry<D>): void {
  registry.register(inspect as unknown as CommandDef<D>);
}
