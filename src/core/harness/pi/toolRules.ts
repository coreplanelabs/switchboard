// A preset's tool rules under pi (docs/reference/specs/harness-pi.md items 7
// and 10): what a run may ask of pi's built-in tools and of the harness's own,
// judged per call from the call alone — the push target (the run's repository
// and branch), a merge or an approval, the executor's credential store, an
// environment dump, a path outside the checkout, a tool outside the reach the
// run's identity gives it. A write run's reach is the coding preset's; a read
// run's holds no write bundle, and its shell never pushes and never writes to
// GitHub — the read-only rule the resident enforces with a read-only worktree
// and no write token, said once more in pi's terms. Pure: it executes nothing
// and reads nothing. The load harness previews every call against it for the
// spike's receipt; the pi harness's gate refuses with it. Each rule cites the
// rule it stands in for; the policy table's tool-level rows (the authorization
// spec's open gap) are the follow-up.

import { isAbsolute, relative, resolve } from "node:path";
import type { Identity } from "../../../agents/registry.js";

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

/** A read-identity preset's reach — the `readonly` and `explore` toolsets'
 *  bundles: a shell and the files to read the change with, the web, the
 *  GitHub reads and the verdict; never `write-files`, `github-write` or `pr`. */
export const READ_REACH: ReadonlySet<string> = new Set(["shell", "files", "web", "search", "github-read", "verdict"]);

/** A run without an identity's reach for pi's own tools: none of them. Such a
 *  run has no workspace (machine class `none`) and its pi is a child of the
 *  bot, so a shell or a file tool would run on the bot host; every tool it has
 *  is a relayed one, allowed by name before these rules are asked
 *  (harness-pi item 12). */
export const NONE_REACH: ReadonlySet<string> = new Set();

/** The reach a run's identity gives its pi: a write run reaches what the
 *  coding preset does; a read run reaches nothing that writes; a run without
 *  an identity reaches none of pi's own tools. */
export function reachFor(identity: Identity): ReadonlySet<string> {
  if (identity === "write") return CODING_REACH;
  if (identity === "read") return READ_REACH;
  return NONE_REACH;
}

/** One call's verdict: allowed; refused by a rule the reason names; or a tool
 *  outside the run's identity's reach altogether (`outside-profile`). */
export type ToolVerdict = { verdict: "allowed" } | { verdict: "refused" | "outside-profile"; reason: string };

export interface ToolRuleContext {
  /** The run's identity — the preset's (`AgentDef.identity`): it decides the
   *  reach, and under `read` the shell never pushes or writes to GitHub. */
  identity: Identity;
  /** The checkout pi runs in: the files bundles are this tree and nothing outside it. */
  checkout: string;
  /** The run's branch, when the run was given one (a plan unit's, the spike's):
   *  then the one push target it may use. Absent, the run names its own
   *  branch and may push any but the protected ones. */
  branch?: string;
  /** Branches a run without a branch of its own may never push to: the base
   *  its pull request would target, the repository's default. */
  protectedBranches?: readonly string[];
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
/** `git push`, with git's own options between the two words allowed for —
 *  `-C <dir>`, `--git-dir=`, `--work-tree=`, `-c key=value`, `--no-pager` —
 *  so a push aimed from another directory is the same push. */
const GIT_THEN_PUSH = String.raw`\bgit(?:\s+(?:-C\s+\S+|--git-dir=\S+|--work-tree=\S+|-c\s+\S+|--no-pager))*\s+push\b`;
/** Each `git push` and what follows it up to the next shell operator. */
const GIT_PUSH = new RegExp(`${GIT_THEN_PUSH}([^;&|]*)`, "g");
/** Any `git push` at all — a read run's one answer to every one of them. */
const ANY_PUSH = new RegExp(GIT_THEN_PUSH);
/** A GitHub write from the shell, for a run whose identity holds no write:
 *  the CLI's comment, edit, state and review verbs on a pull request or an
 *  issue; `gh api` with a write method, or with a field (`-f`/`-F`, an input
 *  file) — fields make `gh api` POST; curl at the REST API with a write
 *  method or a body. A read of either by the same tools is not matched. */
const GH_WRITE_VERB =
  /\bgh\s+(pr|issue)\s+(comment|create|edit|close|reopen|ready|lock|unlock|review|merge|delete|transfer|pin|unpin)\b/;
const WRITE_METHOD = "(POST|post|PATCH|patch|PUT|put|DELETE|delete)";
const GH_API_WRITE = new RegExp(
  `\\bgh\\s+api\\b(?=[^;&|]*(?:\\s(?:-X|--method)[\\s=]*${WRITE_METHOD}\\b|\\s(?:-f|-F|--field|--raw-field|--input)[\\s=]))`,
);
const CURL_GITHUB_WRITE = new RegExp(
  `\\bcurl\\b(?=[^;&|]*api\\.github\\.com)(?=[^;&|]*(?:\\s(?:-X|--request)[\\s=]*${WRITE_METHOD}\\b|\\s(?:-d|--data(?:-\\w+)?|--json|-T|--upload-file)[\\s=]))`,
);

export function judgeToolCall(tool: string, input: unknown, ctx: ToolRuleContext): ToolVerdict {
  const bundle = PI_TOOL_BUNDLES[tool];
  if (bundle === undefined) return outside(`${tool} is not in any bundle the ${ctx.identity} identity reaches`);
  if (!reachFor(ctx.identity).has(bundle)) {
    return outside(
      ctx.identity === "none"
        ? `${tool} is the \`${bundle}\` bundle: a run without a workspace (identity none) has none of pi's own tools`
        : `${tool} is the \`${bundle}\` bundle, outside the ${ctx.identity} identity's reach`,
    );
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
  if (ctx.identity !== "write") {
    // The read-only rule (harness-pi item 10): the worktree the resident
    // attached for this run holds no write token and its origin is the
    // read-only mirror, so a push could not land — the rule says so before
    // the model learns it from a failure, and covers a GitHub write the
    // prompt already forbids (the bot posts the review, never the agent).
    if (ANY_PUSH.test(command)) return refused("read-only — a read-identity run never pushes");
    if (GH_WRITE_VERB.test(command) || GH_API_WRITE.test(command) || CURL_GITHUB_WRITE.test(command)) {
      return refused("read-only — a read-identity run never writes to GitHub");
    }
    return allowed;
  }
  for (const match of command.matchAll(GIT_PUSH)) {
    const verdict = judgePush(match[1], ctx);
    if (verdict.verdict !== "allowed") return verdict;
  }
  return allowed;
}

/** `git push [flags] [remote [refspec]]`: the run's repository is `origin`
 *  and, when the run was given a branch, that is its one target — anything
 *  else is a `repo:use` the grant set does not carry; a destination of `HEAD`
 *  is the branch the driver checked out, the run's, so `git push origin HEAD`
 *  is the same push as naming it. A run naming its own branch may push any but
 *  the protected ones: the base its pull request targets is never pushed to. */
function judgePush(tail: string, ctx: ToolRuleContext): ToolVerdict {
  const words = tail.split(/\s+/).filter((w) => w.length > 0 && !w.startsWith("-"));
  const [remote, refspec] = words;
  if (remote !== undefined && remote !== "origin") {
    return refused(`repo:use — push to remote \`${remote}\`, not the run's repository (origin)`);
  }
  // A push naming no refspec pushes the checked-out branch, which a rule over
  // the call's text alone cannot know: `git switch main && git push` passes
  // here. The accepted gap of text-only rules — the policy table's tool-level
  // rows (the authorization spec's open item) are where a checkout-aware
  // gate belongs.
  if (refspec === undefined) return allowed;
  const destination = refspec.replace(/^\+/, "").split(":").pop() ?? refspec;
  if (ctx.branch !== undefined) {
    const branch = destination === "HEAD" ? ctx.branch : destination.replace(/^refs\/heads\//, "");
    if (branch !== ctx.branch) return refused(`repo:use — push to \`${branch}\`, not the run's branch ${ctx.branch}`);
    return allowed;
  }
  const branch = destination.replace(/^refs\/heads\//, "");
  if (branch !== "HEAD" && (ctx.protectedBranches ?? []).includes(branch)) {
    return refused(
      `repo:use — push to \`${branch}\`, the branch this run's pull request targets; push your own branch`,
    );
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
