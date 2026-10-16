import {
  CommandError,
  commandDefiner,
  type Caller,
  type CommandDef,
  type CommandRegistry,
  type JsonValue,
} from "../commandRegistry.js";

export type IdentityCommand = "challenge" | "list" | "link" | "unlink" | "recover";
export interface IdentityCommandDeps {
  /** A verified adapter binds fresh proofs and its HttpOnly challenge here.
   * Registry input cannot supply an identity, person, proof or session secret. */
  identityOperations?: { execute(caller: Caller, command: IdentityCommand): Promise<JsonValue> };
}
const defineCommand = commandDefiner<IdentityCommandDeps>();
export const identityCommands: readonly CommandDef<IdentityCommandDeps>[] = (
  ["challenge", "list", "link", "unlink", "recover"] as const
).map((command) =>
  defineCommand({
    id: `identity.${command}`,
    surfaces: { chat: false, mcp: false, cli: false },
    action: command === "list" ? "identity:read" : "identity:exec",
    resource: (_input, caller) => ({ type: "identity", id: caller.actor.id }),
    effect: command === "list" ? "read" : "write",
    annotations: { destructive: false, idempotent: command !== "challenge", openWorld: false },
    describe:
      command === "list"
        ? "Read your verified identity operation."
        : `Complete ${command} through fresh two-sided account verification.`,
    handler: async ({ caller, deps }) => {
      if (caller.actor.viewingAs || typeof deps.identityOperations?.execute !== "function")
        throw new CommandError("unavailable", "Fresh account verification is required in Settings → Identities.");
      return deps.identityOperations.execute(caller, command);
    },
  }),
);
export function registerIdentityCommands<D extends IdentityCommandDeps>(registry: CommandRegistry<D>): void {
  for (const command of identityCommands) registry.register(command as unknown as CommandDef<D>);
}
