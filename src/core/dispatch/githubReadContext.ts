import { capToolResultContent } from "../chatMessage.js";
import { githubRepositoryDependencies, type ContextDependencies } from "../references/contextDependencies.js";
import { sourceHash } from "../references/receipts.js";
import { isSourceResultReceipt, type SourceResultReceipt } from "../references/sourceResultContext.js";
import type { RunnableTool } from "../../tools/runnableTool.js";

/** Applied to the declared GitHub read tools by the controller. Source names
 * come from the read capability, never parsed from a model's result prose. */
export function githubReadWithContext(
  tool: RunnableTool,
  input: {
    runId: string;
    commit(receipt: SourceResultReceipt, dependencies: ContextDependencies): Promise<boolean>;
  },
): RunnableTool {
  return {
    ...tool,
    async run(args, ctx) {
      if (!ctx.github) return tool.run(args, ctx);
      const repositories = new Set<string>();
      const github = {
        ...ctx.github,
        recordRead: (repo: string) => {
          repositories.add(repo.toLowerCase());
          ctx.github?.recordRead?.(repo);
        },
      };
      const result = capToolResultContent(await tool.run(args, { ...ctx, github }));
      if (!ctx.callId || repositories.size === 0) return result;
      let readable: Set<string>;
      try {
        readable = new Set((await github.readableRepos?.([...repositories]))?.map((r) => r.fullName.toLowerCase()));
      } catch {
        readable = new Set();
      }
      const repos = [...repositories].sort();
      if (repos.some((repo) => !readable.has(repo)))
        return ctx.agentName === "orchestrator"
          ? "GitHub result unavailable: current repository access could not be verified."
          : result;
      const receipt: SourceResultReceipt = {
        version: 1,
        runId: input.runId,
        callId: ctx.callId,
        tool: tool.name,
        repos,
        resultHash: await sourceHash(result),
      };
      const context = githubRepositoryDependencies(repos);
      if (!isSourceResultReceipt(receipt) || context.status !== "known" || !(await input.commit(receipt, context)))
        return "GitHub result unavailable: its source context could not be durably recorded.";
      return result;
    },
  };
}
