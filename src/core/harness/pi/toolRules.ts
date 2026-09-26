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
import { commandPastLoopEndRefusal } from "../windDown.js";

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

export type ExistingPrPublicationAuthority = { ref: string; expectedHeadSha: string } | { blocked: string };

/** A live existing-PR publication capability. The run loop replaces
 * `authority` when any atomic push is rejected, so every harness gate holding
 * this fence observes the revocation before it judges the next tool call. */
export interface ExistingPrPublicationFence {
  authority: ExistingPrPublicationAuthority;
}

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
  /** An existing pull request's live atomic publication fence. Blocked
   * authority refuses every push; an allowed receipt requires the exact owned
   * destination and an explicit force-with-lease pinned to the fresh expected
   * head. The wrapper stays shared so a rejection can revoke an open harness. */
  publication?: ExistingPrPublicationFence;
  /** How long until the LOOP ends, in ms, on the harness's clock — the moment
   *  the loop-end cut fires (`loopClock.loopEnd`; a follow-up turn's own
   *  deadline while a turn runs), never the lease's end: a bash call whose
   *  explicit timeout reaches past it is refused before it runs. Absent (a
   *  preview, a gate whose ask carries no timeout), no call is judged by it. */
  loopEndsIn?: () => number;
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
const GIT_THEN_PUSH = String.raw`\bgit(?:[ \t]+(?:-C[ \t]+\S+|--git-dir=\S+|--work-tree=\S+|-c[ \t]+\S+|--no-pager))*[ \t]+push\b`;
/** Each `git push` and what follows it up to the next unquoted shell
 *  operator or newline. Continuations are folded before matching; quoted
 *  newlines and escaped operators must not hide later push arguments. An
 *  `&` that belongs to a redirection (`2>&1`, `>&2`, `&>log`, `&>>log`) is
 *  the redirection's, not an operator: the tail runs past it, so the push's
 *  own arguments after one are still judged (`git push 2>&1 evil main`). */
const GIT_PUSH = new RegExp(
  GIT_THEN_PUSH + String.raw`((?:"(?:\\[\s\S]|[^"\\])*"|'[^']*'|\\[^\n]|[^\n;&|'"\\]|(?<=[<>])&|&(?=>))*)`,
  "g",
);
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

/** OpenCode's permission actions in pi's tool words, so `judgeToolCall` — which
 *  keys on pi's own tool names (`PI_TOOL_BUNDLES`) — judges an OpenCode ask by
 *  the same rules pi's calls are judged by (docs/reference/specs/harness.md
 *  item 4). OpenCode's built-in tools each assert one action: `shell` is
 *  the run's bash; `edit`, `write` and `patch` all assert `edit`
 *  (`packages/core/src/tool/plugin/{edit,write,patch}.ts`), the write-files
 *  bundle; `read` is `read`; `glob` asserts `glob` and `grep` asserts `grep`
 *  (over a pattern, judged as pi's `find`/`grep`); `webfetch`/`websearch` are
 *  denied for every identity and so never ask. `external_directory` is not
 *  here — the bridge judges its directory resources as paths. An MCP tool
 *  asserts `<server>_<tool>`; its word is the tool half. */
export const OPENCODE_ACTION_TO_TOOL_WORD: Readonly<Record<string, string>> = {
  shell: "bash",
  edit: "edit",
  // OpenCode's `write` and `patch` tools both assert the `edit` action (their
  // `permission: "edit"`), so `write` is never an action here; a call to the
  // write tool arrives as `edit`.
  patch: "edit",
  read: "read",
  glob: "find",
  grep: "grep",
  webfetch: "web_fetch",
  websearch: "web_search",
};

/** One OpenCode permission action as pi's tool word: a named built-in maps by
 *  the table; an MCP tool's `<server>_<tool>` action drops its server prefix to
 *  the tool half; anything else is the action itself, which `judgeToolCall`
 *  reads as a tool outside every bundle (refused, `outside-profile`). */
export function openCodeToolWord(action: string): string {
  const mapped = OPENCODE_ACTION_TO_TOOL_WORD[action];
  if (mapped !== undefined) return mapped;
  const underscore = action.indexOf("_");
  return underscore > 0 ? action.slice(underscore + 1) : action;
}

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
  if (tool === "bash") return judgeBash(args.command, args.timeout, ctx);
  if (bundle === "files" || bundle === "write-files") return judgePath(args.path, ctx);
  return allowed;
}

function judgeBash(command: unknown, timeout: unknown, ctx: ToolRuleContext): ToolVerdict {
  if (typeof command !== "string") return refused("malformed — bash without a string command");
  const verdict = judgeBashCommand(command, ctx);
  if (verdict.verdict !== "allowed") return verdict;
  return judgeBashTimeout(timeout, ctx);
}

function judgeBashCommand(command: string, ctx: ToolRuleContext): ToolVerdict {
  if (CREDENTIAL_FILE.test(command)) return refused("credential — reads the executor's credential store");
  if (ENV_DUMP.test(command)) return refused("credential — dumps the process environment");
  if (CREDENTIAL_VAR.test(command)) return refused("credential — expands a credential variable");
  if (MERGE_OR_APPROVE.test(command)) {
    return refused("merge/approve — a coding run never merges or approves a pull request");
  }
  const pushCommand = withoutShellContinuations(command);
  if (ctx.identity !== "write") {
    // The read-only rule (harness-pi item 10): the worktree the resident
    // attached for this run holds no write token and its origin is the
    // read-only mirror, so a push could not land — the rule says so before
    // the model learns it from a failure, and covers a GitHub write the
    // prompt already forbids (the bot posts the review, never the agent).
    if (ANY_PUSH.test(pushCommand)) return refused("read-only — a read-identity run never pushes");
    if (GH_WRITE_VERB.test(command) || GH_API_WRITE.test(command) || CURL_GITHUB_WRITE.test(command)) {
      return refused("read-only — a read-identity run never writes to GitHub");
    }
    return allowed;
  }
  for (const match of pushCommand.matchAll(GIT_PUSH)) {
    const verdict = judgePush(match[1], ctx);
    if (verdict.verdict !== "allowed") return verdict;
  }
  return allowed;
}

/** Bash removes a backslash-newline pair, not whitespace between words.
 *  Keep single-quoted text and other escape pairs intact: an escaped
 *  backslash before a newline does not continue the command. This is only
 *  the push matcher's input, never a rewrite of what the shell executes. */
function withoutShellContinuations(command: string): string {
  let result = "";
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "\\" && quote !== "'" && i + 1 < command.length) {
      const next = command[++i];
      if (next !== "\n") result += char + next;
      continue;
    }
    if (char === quote) quote = undefined;
    else if (quote === undefined && (char === "'" || char === '"')) quote = char;
    result += char;
  }
  return result;
}

/** pi's bash `timeout` is seconds, optional, and unbounded when absent (the
 *  pinned pi runs a call without one until it exits or the loop's end cuts it;
 *  a non-finite or non-positive number pi refuses itself). An explicit one
 *  that reaches past the loop's end (harness-pi item 7) is refused before the
 *  command runs, with the seconds left and the two ways forward — so the
 *  model learns at once, not from the cut, that the command could never
 *  finish. A call naming no timeout is never refused here: a `git push` in
 *  the last minute must run, and the loop's end bounds it as it always did. */
function judgeBashTimeout(timeout: unknown, ctx: ToolRuleContext): ToolVerdict {
  if (!ctx.loopEndsIn || typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return allowed;
  const leftMs = ctx.loopEndsIn();
  if (timeout * 1000 <= leftMs) return allowed;
  return refused(commandPastLoopEndRefusal(Math.round(timeout), Math.max(0, Math.floor(leftMs / 1000))));
}

/** `git push [flags] [remote [refspec]]`: the run's repository is `origin`
 *  and, when the run was given a branch, that is its one target — anything
 *  else is a `repo:use` the grant set does not carry. A bare push or `HEAD`
 *  source is not proof of that target: the checkout may have moved
 *  since the driver attached it. A run naming its own branch may push any but
 *  the protected ones: the base its pull request targets is never pushed to. */
function judgePush(tail: string, ctx: ToolRuleContext): ToolVerdict {
  const [remote, refspec, ...additionalRefspecs] = pushArguments(tail);
  if (remote !== undefined && remote !== "origin") {
    return refused(`repo:use — push to remote \`${remote}\`, not the run's repository (origin)`);
  }
  if (ctx.publication !== undefined) {
    const publication = ctx.publication.authority;
    if ("blocked" in publication) return refused(`repo:use — existing-PR publication blocked: ${publication.blocked}`);
    if (refspec === undefined)
      return refused("repo:use — existing-PR publication requires the explicit owned destination");
    if (additionalRefspecs.length > 0)
      return refused("repo:use — existing-PR publication allows exactly one owned destination");
    const [source, destination = source] = refspec.replace(/^\+/, "").split(":");
    const branch = destination.replace(/^refs\/heads\//, "");
    if (branch !== publication.ref)
      return refused(`repo:use — push to \`${branch}\`, not the owned publication ref ${publication.ref}`);
    if (source.replace(/^refs\/heads\//, "") !== publication.ref)
      return refused(`repo:use — push from the owned publication ref ${publication.ref}; the checkout may have moved`);
    const lease = `--force-with-lease=refs/heads/${publication.ref}:${publication.expectedHeadSha}`;
    if (!tail.split(/\s+/).includes(lease))
      return refused(
        `repo:use — existing-PR publication requires \`${lease}\` so concurrent movement fails atomically`,
      );
    return allowed;
  }
  if (ctx.branch !== undefined && refspec === undefined)
    return refused(
      `repo:use — name the run's branch ${ctx.branch} as the push source and destination; the checkout may have moved`,
    );
  if (ctx.branch !== undefined && additionalRefspecs.length > 0)
    return refused("repo:use — a bound run may push exactly one branch");
  // An unbound run may cut its own branch. A bare push still relies on the
  // checkout; a checkout-aware gate is the policy table's open item.
  if (refspec === undefined) return allowed;
  const [source, destination = source] = refspec.replace(/^\+/, "").split(":");
  if (ctx.branch !== undefined) {
    const branch = destination.replace(/^refs\/heads\//, "");
    if (branch !== ctx.branch) return refused(`repo:use — push to \`${branch}\`, not the run's branch ${ctx.branch}`);
    if (source.replace(/^refs\/heads\//, "") !== ctx.branch)
      return refused(`repo:use — push from the run's branch ${ctx.branch}; the checkout may have moved`);
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

/** A shell redirection word (`2>&1`, `>&2`, `&>log`, `>out.log`,
 *  `2>/dev/null`, `<in`): the shell's, never one of the push's arguments. A
 *  bare operator (`>`, `2>`, `>&`) takes the next word as its target. */
const REDIRECTION = /^(\d*|&)(>>|>&|>\|?|<<<?|<&|<>?)(.*)$/;

/** The push's own arguments out of what follows `git push` (already cut at
 *  unquoted newlines, `|`, `;` and a control `&` by the match): flags dropped,
 *  each shell redirection and its target skipped — skipped, not stopped at,
 *  so an argument after one (`git push 2>/dev/null evil main`) is still judged. */
function pushArguments(tail: string): string[] {
  const words: string[] = [];
  const raw = tail.split(/\s+/).filter((w) => w.length > 0);
  for (let i = 0; i < raw.length; i++) {
    const redirection = REDIRECTION.exec(raw[i]);
    if (redirection) {
      if (redirection[3] === "") i++; // a bare operator's target is the next word
      continue;
    }
    if (!raw[i].startsWith("-")) words.push(raw[i]);
  }
  return words;
}

function judgePath(path: unknown, ctx: ToolRuleContext): ToolVerdict {
  if (path === undefined) return allowed; // the search tools default to the checkout
  if (typeof path !== "string") return refused("malformed — a path tool without a string path");
  if (CREDENTIAL_FILE.test(path)) return refused("credential — reads the executor's credential store");
  const rel = relative(ctx.checkout, resolve(ctx.checkout, path));
  if (rel.startsWith("..") || isAbsolute(rel)) return refused(`path — \`${path}\` resolves outside the checkout`);
  return allowed;
}
