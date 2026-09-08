import { ALL_CAPABILITIES, NO_CAPABILITIES, type Capabilities } from "./capabilities.js";
import type { CommandDef } from "./commandRegistry.js";

// What a command's `enabledWhen` (src/core/capabilities.ts, command-registry.md
// item 28) means, derived, so no surface, test or doc has to read the predicate
// twice: whether a command is visible under one `Capabilities` value, and WHICH
// axes decide that. The axes are read off the contract's own all-on value, so a
// capability added there is an axis here with no edit. Pure: definitions in,
// names out.

export type CapabilityKey = keyof Capabilities;

/** Every axis of the contract, in declaration order. */
export const CAPABILITY_KEYS: readonly CapabilityKey[] = Object.keys(ALL_CAPABILITIES) as CapabilityKey[];

/** Whether the command is on under `caps`: an absent `enabledWhen` is always on. */
export function isEnabled(cmd: Pick<CommandDef<unknown>, "enabledWhen">, caps: Capabilities): boolean {
  return cmd.enabledWhen?.(caps) ?? true;
}

/** Everything on, except `key` at its off value. */
export function withOff(key: CapabilityKey, caps: Capabilities = ALL_CAPABILITIES): Capabilities {
  return { ...caps, [key]: NO_CAPABILITIES[key] };
}

/** Everything off, except `key` at its on value. */
export function withOn(key: CapabilityKey, caps: Capabilities = NO_CAPABILITIES): Capabilities {
  return { ...caps, [key]: ALL_CAPABILITIES[key] };
}

/**
 * The axes a command's visibility depends on: each one whose value changes what
 * `enabledWhen` answers in at least one of the two reference worlds — turned off
 * alone against everything else on, or turned on alone against everything else
 * off. Both directions matter: `repo test` is on with residents OR local
 * execution, so from all-on only residents hides it, while from all-off only a
 * sandbox execution hides it — it depends on both. Empty for a command without
 * a predicate — always on.
 */
export function dependsOn(cmd: Pick<CommandDef<unknown>, "enabledWhen">): CapabilityKey[] {
  if (!cmd.enabledWhen) return [];
  const allOn = isEnabled(cmd, ALL_CAPABILITIES);
  const allOff = isEnabled(cmd, NO_CAPABILITIES);
  return CAPABILITY_KEYS.filter(
    (key) => isEnabled(cmd, withOff(key)) !== allOn || isEnabled(cmd, withOn(key)) !== allOff,
  );
}

/** The commands on under `caps`, in the order given. */
export function visibleUnder<C extends Pick<CommandDef<unknown>, "enabledWhen">>(
  cmds: readonly C[],
  caps: Capabilities,
): C[] {
  return cmds.filter((cmd) => isEnabled(cmd, caps));
}
