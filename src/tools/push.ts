// The child's typed push command (record 0074, the push unit). This tool names an
// intent only: it accepts no remote, URL, refspec, flags or arbitrary git
// arguments. The runner-bound RunEffects capability resolves and performs the
// operation from current facts.

import type { EffectEnvelope } from "../core/runEffects.js";
import type { RunnableTool } from "./runnableTool.js";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^(?!-)(?!.*\.\.)(?!.*[~^:?*[\]\\\s])[^/]+(?:\/[^/]+)*$/;
const SHA = /^[0-9a-f]{40}$/;
const EFFECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEYS = new Set(["effectId", "repository", "branch", "expectedHead", "base", "gateSet"]);

function parse(input: Record<string, unknown>): { ok: true; envelope: EffectEnvelope } | { ok: false; reason: string } {
  const extra = Object.keys(input).find((key) => !KEYS.has(key));
  if (extra) return { ok: false, reason: `unknown field ${extra}` };
  const { effectId, repository, branch, expectedHead, base, gateSet } = input;
  if (typeof effectId !== "string" || !EFFECT_ID.test(effectId))
    return {
      ok: false,
      reason: "effectId must be a stable caller-minted id (1–128 letters, digits, dot, underscore, colon or dash)",
    };
  if (typeof repository !== "string" || !REPOSITORY.test(repository))
    return { ok: false, reason: "repository must be one owner/name identifier" };
  if (typeof branch !== "string" || !REF.test(branch)) return { ok: false, reason: "branch must be one branch name" };
  if (typeof expectedHead !== "string" || !SHA.test(expectedHead))
    return { ok: false, reason: "expectedHead must be one full lowercase commit sha" };
  if (typeof base !== "string" || !REF.test(base)) return { ok: false, reason: "base must be one branch name" };
  if (gateSet !== "changed-set") return { ok: false, reason: "gateSet must be changed-set" };
  return {
    ok: true,
    envelope: {
      effectId,
      command: { kind: "push", repository, branch, expectedHead, base, gateSet },
    },
  };
}

export const pushTool: RunnableTool = {
  name: "push",
  failsInText: true,
  description:
    "Ask the runner to publish one exact tree. The runner resolves the admitted repository and run-owned branch, rebases first, runs the repository's changed-set gates on the resulting clean tree, lease-publishes it, and records the receipt. The caller mints effectId before the first call and reuses it on every retry. No remote, URL, refspec, flags or extra git arguments are accepted.",
  inputSchema: {
    type: "object",
    properties: {
      effectId: { type: "string", description: "Stable caller-minted id, reused on retry or resume" },
      repository: { type: "string", description: "The admitted owner/name repository" },
      branch: { type: "string", description: "The run-owned destination branch" },
      expectedHead: { type: "string", description: "Full lowercase sha currently expected in the checkout" },
      base: { type: "string", description: "The admitted base branch to rebase onto before gates" },
      gateSet: { type: "string", enum: ["changed-set"], description: "The repository-declared changed-set gates" },
    },
    required: ["effectId", "repository", "branch", "expectedHead", "base", "gateSet"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const parsed = parse(input);
    if (!parsed.ok) return `error: push refused: ${parsed.reason}`;
    if (!ctx.effects) return "error: push refused: runner effects are unavailable for this run";
    try {
      return JSON.stringify(await ctx.effects.execute(parsed.envelope));
    } catch (err) {
      return `error: push refused: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
