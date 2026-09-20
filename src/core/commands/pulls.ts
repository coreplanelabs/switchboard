import { z } from "zod";
import {
  CommandError,
  commandDefiner,
  type CommandDef,
  type CommandRegistry,
  type JsonValue,
} from "../commandRegistry.js";
import type { PullSweepService, SweepReport } from "../pullSweep.js";

// `pulls rebase` (record 0071, mechanism two; docs/reference/specs/agent-ship.md
// item 20): the sweep a person runs. One named pull request — a number, `#N`,
// `owner/name#N` or a GitHub URL — or every open pull request the pipeline owns
// in the repository, each rebased onto its base with the two-rung resolver
// (src/core/pullSweep.ts): git alone first (the repository's own merge drivers,
// rerere, an empty range-diff carrying the approval), then one bounded model
// round for a conflict git leaves. The answer is one line per pull request in
// user words. The command starts no agent run itself — the model rung is the
// service's seam, filled by the wiring (invariant 3); on every surface the
// registry serves. Needs the `github` capability: the sweep reads and pushes
// the pipeline's pull requests over the App credential.

export interface PullsCommandDeps {
  /** Absent where no sweep is wired (a bare test registry): the command answers `unavailable`. */
  pulls?: {
    service(): Promise<PullSweepService>;
  };
}

const defineCommand = commandDefiner<PullsCommandDeps>();

const REPO_SLUG = /^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/;
/** A pull request as a person spells it: `42`, `#42`, `owner/name#42`, or its URL. */
const PR_REF = /^(#?\d+|[\w.-]+\/[\w.-]+#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)$/;

/** The repo (when the reference names one) and the number out of a `PR_REF`. */
export function parsePullReference(ref: string): { repo?: string; number: number } {
  const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(ref);
  if (url) return { repo: url[1]!, number: Number(url[2]) };
  const slug = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref);
  if (slug) return { repo: slug[1]!, number: Number(slug[2]) };
  return { number: Number(ref.replace(/^#/, "")) };
}

const renderReport = (output: JsonValue): string => {
  const report = output as unknown as SweepReport;
  const head = `Swept ${report.repo}: ${report.results.length} pull request${report.results.length === 1 ? "" : "s"}`;
  return [head, ...report.results.map((r) => r.line)].join("\n");
};

export const pullsRebase = defineCommand({
  id: "pulls.rebase",
  args: [
    {
      name: "pr",
      schema: z.string().regex(PR_REF).optional(),
      describe:
        "one pull request — a number, `#N`, `owner/name#N` or its GitHub URL; absent: every open pull request the pipeline owns",
    },
  ] as const,
  options: z.object({
    repo: z
      .string()
      .regex(REPO_SLUG)
      .optional()
      .describe("the repository (`owner/name`); default: the pull request's own, else the thread's bound repository"),
  }),
  action: "pulls:write",
  effect: "write",
  enabledWhen: (caps) => caps.github,
  annotations: {
    // A force-push rewrites a published head, and a conflict may start one paid
    // model round: not undone by any command here.
    destructive: true,
    risk: (input) => {
      const pr = Array.isArray(input.args) ? input.args[0] : undefined;
      return typeof pr === "string" && pr !== ""
        ? `rebases pull request ${pr} onto its base and force-pushes; a conflict starts one bounded fix round`
        : "rebases every open pull request the pipeline owns onto its base and force-pushes; a conflict starts one bounded fix round";
    },
  },
  describe:
    "Rebase the pipeline's open pull requests (or one named) onto their bases: git alone first — the repository's own merge drivers, rerere, an unchanged patch carries its approval — then one bounded fix round for a conflict git leaves; one line per pull request.",
  render: renderReport,
  handler: async ({ args, options, caller, deps }) => {
    const ref = args.pr === undefined ? undefined : parsePullReference(args.pr);
    const repo = ref?.repo ?? options.repo ?? (await caller.origin?.repo?.());
    if (repo === undefined)
      throw new CommandError(
        "invalid_input",
        "name a repository: `--repo owner/name`, a full pull request reference, or ask from a thread bound to one",
      );
    if (deps.pulls === undefined)
      throw new CommandError("unavailable", "no sweep service is wired in this process — ask the bot to run it");
    const service = await deps.pulls.service();
    try {
      const report = await service.sweep({ repo, ...(ref ? { number: ref.number } : {}) });
      return report as unknown as JsonValue;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CommandError("unavailable", `the sweep is unavailable: ${message}`);
    }
  },
});

export const pullsCommands: readonly CommandDef<PullsCommandDeps>[] = [
  pullsRebase,
] as unknown as CommandDef<PullsCommandDeps>[];

export function registerPullsCommands<D extends PullsCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of pullsCommands) registry.register(cmd as unknown as CommandDef<D>);
}
