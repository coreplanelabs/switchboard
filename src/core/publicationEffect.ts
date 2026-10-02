// Model shell commands cannot own a Git Door write slot: a program may spawn
// Git without naming it in its input. Publication is one runner-owned tool
// whose credential and source/destination/head are bound before execution.
import type { Executor } from "../execution/executor.js";
import { shellQuote } from "../execution/shellQuote.js";
import type { RunnableTool } from "../tools/runnableTool.js";
import type { GitBindings } from "./modelProxy/gitBindings.js";
import { bearerHashOf, type RunBearerStore } from "./modelProxy/runBearers.js";
import { redactSecrets } from "./runEvents.js";

export interface PublicationEffectBinding {
  runId: string;
  repo: string;
  doorUrl: string;
  branch?: string;
  /** Trusted selected checkout, reread after a same-run workspace reattach. */
  checkout: () => string | undefined;
  protectedBranches: readonly string[];
  bindings: GitBindings;
  bearers: RunBearerStore;
}

function safeBranch(branch: string): boolean {
  return (
    branch.length > 0 &&
    !branch.startsWith("-") &&
    !branch.includes("..") &&
    !branch.endsWith("/") &&
    [...branch].every(
      (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || "_/.-".includes(c),
    )
  );
}

function fullSha(sha: string): boolean {
  return sha.length === 40 && [...sha].every((c) => (c >= "0" && c <= "9") || (c >= "a" && c <= "f"));
}

/** This effect, not a shell program, selects the credential for receive-pack.
 * The Git Door verifies its hash beside the ref/source/old-head tuple and
 * persists the outcome before any tool result can be credited as a receipt. */
export function publicationEffectTool(binding: PublicationEffectBinding): RunnableTool {
  return {
    name: "publish_branch",
    description:
      "Publish one owned branch through a runner-owned Git Door effect. Use after scoped checks and rebase; shell pushes cannot acquire a Door grant. The branch must be checked out and named explicitly.",
    inputSchema: {
      type: "object",
      properties: { branch: { type: "string", description: "The checked-out owned source and destination branch." } },
      required: ["branch"],
    },
    failsInText: true,
    async run(input, ctx) {
      const branch = input.branch;
      if (typeof branch !== "string" || !safeBranch(branch) || binding.protectedBranches.includes(branch))
        return "error: publication requires one valid non-protected branch";
      if (binding.branch !== undefined && branch !== binding.branch)
        return "error: publication requires the run's owned branch";
      const authority = binding.bindings.publicationOf(binding.runId);
      if (authority && ("blocked" in authority || authority.ref !== branch))
        return "error: existing-PR publication is blocked or belongs to another ref";
      const executor: Executor = ctx.executor;
      if (!executor.execResult || !executor.publishBranchResult)
        return "error: this workspace has no structured publication transport";
      const checkout = binding.checkout();
      if (
        checkout !== "/workspace/checkout" &&
        (!checkout?.startsWith("/workspace/threads/") || checkout.split("/").includes(".."))
      )
        return "error: the selected checkout is unavailable for publication";
      const git = (args: string) => `git -C ${shellQuote(checkout)} ${args}`;
      const inspect = async (command: string): Promise<string | undefined> => {
        const result = await executor.execResult!(command, { signal: ctx.signal });
        return result.exitCode === 0 && !result.truncated ? result.stdout.trim() : undefined;
      };
      const sourceRef = `refs/heads/${branch}`;
      const quotedRef = shellQuote(sourceRef);
      const checkedOut = await inspect(git("symbolic-ref --quiet --short HEAD"));
      if (checkedOut !== branch) return "error: the owned branch is not checked out";
      if ((await inspect(git("status --porcelain -uno"))) !== "")
        return "error: the tracked tree is not clean and cannot be published";
      if ((await inspect(git(`check-ref-format --branch ${shellQuote(branch)}`))) !== branch)
        return "error: invalid branch ref";
      const next = await inspect(git(`rev-parse --verify ${shellQuote(`${sourceRef}^{commit}`)}`));
      if (!next || !fullSha(next)) return "error: the owned source commit cannot be read";
      const remote = await inspect(git("remote get-url origin"));
      const expectedRemote = `${new URL(binding.doorUrl).origin}/git/${binding.repo}`;
      if (remote !== expectedRemote && remote !== `${expectedRemote}.git`)
        return "error: origin does not name the bound Git Door repository";
      const issued = binding.bearers.issue(binding.runId);
      const hash = issued && bearerHashOf(issued.token);
      if (!issued || !hash || !ctx.callId) return "error: a run-bound publication credential is unavailable";
      const old = authority && "expectedHeadSha" in authority ? authority.expectedHeadSha : undefined;
      if (
        !binding.bindings.allowToolPush(
          binding.runId,
          ctx.callId,
          { ref: sourceRef, next, ...(old ? { old } : {}) },
          hash,
        )
      )
        return "error: the Git Door did not admit this source, ref and head";
      try {
        if (old)
          ctx.publish?.({ type: "publication_push_authorized", callId: ctx.callId, ref: branch, expectedHeadSha: old });
        // The immutable commit travels through a privileged, fixed-argv
        // transport; the model shell never shares its effect credential.
        const result = await executor.publishBranchResult({
          repo: binding.repo,
          doorOrigin: new URL(binding.doorUrl).origin,
          branch,
          next,
          ...(old ? { old } : {}),
          bearer: issued.token,
          signal: ctx.signal,
        });
        if (result.exitCode !== 0 || result.truncated)
          return `error: publication refused: ${redactSecrets(result.stderr || result.stdout || "unverified result")}`;
        // A clean exit is not itself the durable receipt. The Door must have
        // committed the exact accepted transition, and the remote must agree.
        const after = binding.bindings.publicationOf(binding.runId);
        if (
          (old && (!after || "blocked" in after || after.expectedHeadSha !== next)) ||
          (!old && after && "blocked" in after)
        )
          return "error: the Git Door did not commit an accepted publication outcome";
        const remoteHead = await inspect(git(`ls-remote --exit-code origin ${quotedRef}`));
        if (remoteHead?.split("\t")[0] !== next) return "error: the remote head cannot be verified after publication";
        return redactSecrets(
          [result.stdout, result.stderr].filter(Boolean).join("\n--- stderr ---\n") || "(no output)",
        );
      } finally {
        binding.bindings.clearToolPush(binding.runId, ctx.callId);
      }
    },
  };
}
