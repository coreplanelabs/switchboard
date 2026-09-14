// The coding preset's tool rules under pi (docs/reference/specs/harness-pi.md):
// what a coding run may ask of pi's built-in tools and of the harness's own,
// judged per call from the call alone — the push target (the run's repository
// and branch), a merge or an approval, the executor's credential store, an
// environment dump, a path outside the checkout, a tool outside the preset's
// reach. Pure: it executes nothing and reads nothing. The load harness previews
// every call against it for the spike's receipt; the pi harness's gate refuses
// with it. Each rule cites the rule it stands in for; the policy table's
// tool-level rows (the authorization spec's open gap) are the follow-up.

import { isAbsolute, relative, resolve } from "node:path";

/** pi's built-in tools (packages/coding-agent/src/core/tools) and the harness
 *  extension's, each on the capability-profile bundle it exercises (the
 *  capability profiles record: `shell`, `files`, `write-files`, `web`,
 *  `search`, `github-read`, `github-write`, `pr`, `verdict`). */
export const PI_TOOL_BUNDLES: Readonly<Record<string, string>> = {
  bash: "shell",
  read: "files",
  grep: "files",
  find: "files",
  ls: "files",
  write: "write-files",
  edit: "write-files",
  submit_pr_description: "pr",
  submit_verdict: "verdict",
};

/** The coding preset's reach: the record's `full` toolset is the first eight
 *  bundles less `search` and `verdict`. */
export const CODING_REACH: ReadonlySet<string> = new Set([
  "shell",
  "files",
  "write-files",
  "web",
  "github-read",
  "github-write",
  "pr",
]);

/** One call's verdict: allowed; refused by a rule the reason names; or a tool
 *  outside the coding preset's reach altogether (`outside-profile`). */
export type ToolVerdict = { verdict: "allowed" } | { verdict: "refused" | "outside-profile"; reason: string };

export interface ToolRuleContext {
  /** The checkout pi runs in: the files bundles are this tree and nothing outside it. */
  checkout: string;
  /** The run's branch — the one push target a coding child may use. */
  branch: string;
}

const allowed: ToolVerdict = { verdict: "allowed" };
const refused = (reason: string): ToolVerdict => ({ verdict: "refused", reason });
const outside = (reason: string): ToolVerdict => ({ verdict: "outside-profile", reason });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The executor's credential store beside the worktree
 *  (`<worktree>/.git/github-credentials`, src/execution/residentCredentials.ts)
 *  and git's global equivalent — a coding run never reads either. */
const CREDENTIAL_FILE = /(^|[\s/'"`])(\.git\/)?(github-credentials|\.git-credentials)($|[\s'"`|;&])/;
/** A dump of the whole environment, where every key would be: `env` or
 *  `printenv` standing alone (flags at most), `export -p`, `declare -p`/`-x`,
 *  a bare `set`, the kernel's copy, or Node's `process.env` as a whole.
 *  `env VAR=x cmd` runs a command and `process.env.NAME` reads one variable;
 *  neither is a dump. */
const ENV_DUMP =
  /(^|[;&|(]\s*)((printenv|env)(\s+-[A-Za-z0-9-]+)*|export\s+-p|declare\s+-[a-zA-Z]*[px][a-zA-Z]*|set)\s*($|[|;&>)])|\/proc\/(self|\d+)\/environ|process\.env(?![.[\w])/;
/** A variable named like a credential, expanded or printed: a coding run
 *  holds no model key, token or bearer to reach for — the executor's GitHub
 *  credential is a git helper, never a variable. */
const CREDENTIAL_VAR =
  /\$\{?[A-Z][A-Z0-9_]*(_API_KEY|_TOKEN|_SECRET|_BEARER|_PASSWORD)\b|printenv\s+[A-Z][A-Z0-9_]*(_API_KEY|_TOKEN|_SECRET|_BEARER|_PASSWORD)\b/;
/** Merging or approving a pull request, by the GitHub CLI or the REST API —
 *  the ship pipeline's rule for every coding child, and the review agent's
 *  read-only rule. */
const MERGE_OR_APPROVE = /\bgh\s+pr\s+(merge|review)\b|\/pulls\/\d+\/(merge|reviews)\b/;
/** Each `git push` and what follows it up to the next shell operator. */
const GIT_PUSH = /\bgit\s+push\b([^;&|]*)/g;

export function judgeToolCall(tool: string, input: unknown, ctx: ToolRuleContext): ToolVerdict {
  const bundle = PI_TOOL_BUNDLES[tool];
  if (bundle === undefined) return outside(`${tool} is not in any bundle the coding preset reaches`);
  if (!CODING_REACH.has(bundle)) {
    return outside(`${tool} is the \`${bundle}\` bundle; the coding preset's reach does not include it`);
  }
  const args = isRecord(input) ? input : {};
  if (tool === "bash") return judgeBash(args.command, ctx);
  if (bundle === "files" || bundle === "write-files") return judgePath(args.path, ctx);
  return allowed;
}

function judgeBash(command: unknown, ctx: ToolRuleContext): ToolVerdict {
  if (typeof command !== "string") return refused("malformed — bash without a string command");
  if (CREDENTIAL_FILE.test(command)) return refused("credential — reads the executor's credential store");
  if (ENV_DUMP.test(command)) return refused("credential — dumps the process environment");
  if (CREDENTIAL_VAR.test(command)) return refused("credential — expands a credential variable");
  if (MERGE_OR_APPROVE.test(command)) {
    return refused("merge/approve — a coding run never merges or approves a pull request");
  }
  for (const match of command.matchAll(GIT_PUSH)) {
    const verdict = judgePush(match[1], ctx);
    if (verdict.verdict !== "allowed") return verdict;
  }
  return allowed;
}

/** `git push [flags] [remote [refspec]]`: the run's repository is `origin`
 *  and its one branch is the run's; anything else is a `repo:use` the grant
 *  set does not carry. A destination of `HEAD` is the branch the driver
 *  checked out — the run's — so `git push origin HEAD` is the same push as
 *  naming it. */
function judgePush(tail: string, ctx: ToolRuleContext): ToolVerdict {
  const words = tail.split(/\s+/).filter((w) => w.length > 0 && !w.startsWith("-"));
  const [remote, refspec] = words;
  if (remote !== undefined && remote !== "origin") {
    return refused(`repo:use — push to remote \`${remote}\`, not the run's repository (origin)`);
  }
  if (refspec !== undefined) {
    const destination = refspec.replace(/^\+/, "").split(":").pop() ?? refspec;
    const branch = destination === "HEAD" ? ctx.branch : destination.replace(/^refs\/heads\//, "");
    if (branch !== ctx.branch) return refused(`repo:use — push to \`${branch}\`, not the run's branch ${ctx.branch}`);
  }
  return allowed;
}

function judgePath(path: unknown, ctx: ToolRuleContext): ToolVerdict {
  if (path === undefined) return allowed; // the search tools default to the checkout
  if (typeof path !== "string") return refused("malformed — a path tool without a string path");
  if (CREDENTIAL_FILE.test(path)) return refused("credential — reads the executor's credential store");
  const rel = relative(ctx.checkout, resolve(ctx.checkout, path));
  if (rel.startsWith("..") || isAbsolute(rel)) return refused(`path — \`${path}\` resolves outside the checkout`);
  return allowed;
}
