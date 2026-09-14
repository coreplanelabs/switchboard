// Which loop drives a run (docs/reference/specs/harness-pi.md item 1): the
// preset's own declaration, unless the deployment's `harness:` block names
// another for that preset. One pure question the run stage asks once, so the
// seam between the native loop and the pi harness is a single branch on a
// single word — and a deployment that sets nothing runs every preset exactly
// as the registry declares it.

import type { AgentDef, Harness } from "../../agents/registry.js";

export function effectiveHarness(
  agent: Pick<AgentDef, "name" | "harness">,
  block: Record<string, Harness> | undefined,
): Harness {
  return block?.[agent.name] ?? agent.harness ?? "native";
}
