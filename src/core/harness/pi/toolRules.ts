// A preset's tool rules under pi (docs/reference/specs/harness-pi.md items 7
// and 10): what a run may ask of pi's built-in tools and of the harness's own,
// judged from the call plus the write harness's settled formatting receipt —
// the push target (the run's repository and branch), the pushed tree's receipt,
// a merge or an approval, the executor's credential store, an
// environment dump, a path outside the checkout, a tool outside the reach the
// run's identity gives it. A write run's reach is the coding preset's; a read
// run's holds no write bundle, and its shell never pushes and never writes to
// GitHub — the read-only rule the resident enforces with a read-only worktree
// and no write token, said once more in pi's terms. The rule itself executes
// and reads nothing; the runtime wrapper reads only Git's tree identity through
// the Executor seam. The load harness previews every call against the pure rule
// for the spike's receipt; the pi harness's gate refuses with it. Each rule
// cites the rule it stands in for; the policy table's remaining tool-level rows
// (the authorization spec's open gap) are the follow-up. The harness reports
// settled tool results into its process-local receipt, and a restart starts
// unproved.

import { isAbsolute, relative, resolve } from "node:path";
import type { Identity } from "../../../agents/registry.js";
import type { Executor } from "../../../execution/executor.js";
import { shellQuote } from "../../../execution/shellQuote.js";
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

export interface PushRefspec {
  source: string;
  /** Undefined means Git infers the checked-out branch from a source of HEAD. */
  destination?: string;
}

export interface PushResolution {
  remote: string;
  remoteUrl: string;
  refspecs: readonly PushRefspec[];
}

export interface PushGuard {
  /** The clean Git tree id whose changed-set formatter last settled cleanly. */
  formattedTree?: string;
  /** Canonical formatting calls remember the tree they started on, so a call
   *  running beside another write cannot certify a different tree when it ends. */
  pendingFormatting: Map<string, string | undefined>;
  /** A clean formatter's tree inspection can still be in flight when the next
   *  authorization ask arrives; a push waits for it before comparing trees. */
  pendingSettlement?: Promise<void>;
  /** Invalidates an older asynchronous inspection when a later formatter settles. */
  receiptRevision: number;
  /** The current checkout identity observed immediately before the push ask. */
  currentTree?: string;
  /** The effective remote and every source/destination observed before the push ask. */
  pushResolution?: PushResolution;
  /** Every effective refspec source's committed tree observed before the push ask. */
  pushedTrees?: readonly string[];
}

/** Per-harness state for the coding push guard. It deliberately starts
 *  unproved: a resumed process cannot inherit a gate receipt it did not see. */
export function createPushGuard(): PushGuard {
  return { pendingFormatting: new Map(), receiptRevision: 0 };
}

export interface ToolRuleContext {
  /** The run's identity — the preset's (`AgentDef.identity`): it decides the
   *  reach, and under `read` the shell never pushes or writes to GitHub. */
  identity: Identity;
  /** The checkout pi runs in: the files bundles are this tree and nothing outside it. */
  checkout: string;
  /** The run's repository slug, used to bind the effective push URL. */
  repository?: string;
  /** The run's branch, when the run was given one (a plan unit's, the spike's):
   *  then the one push target it may use. Absent, the run names its own
   *  branch and may push any but the protected ones. */
  branch?: string;
  /** Branches a run without a branch of its own may never push to: the base
   *  its pull request would target, the repository's default. */
  protectedBranches?: readonly string[];
  /** A write run's process-local receipt that formatting passed on the tree it
   *  is about to push. Absent in pure previews and read-only runs. */
  pushGuard?: PushGuard;
  /** Reads the checkout's committed Git tree plus whether its working tree is
   *  dirty. Harnesses bind this through the run's executor; pure previews do not. */
  inspectTree?: () => Promise<string | undefined>;
  /** Resolves one push refspec's source to its committed tree. */
  inspectRefTree?: (ref: string) => Promise<string | undefined>;
  /** Resolves the effective remote URL and every source/destination selected
   *  by either explicit refspecs or Git's configured defaults. */
  inspectPush?: (remote: string, explicit?: readonly PushRefspec[]) => Promise<PushResolution | undefined>;
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
const GIT_THEN = String.raw`\bgit(?:\s+(?:-C\s+\S+|--git-dir=\S+|--work-tree=\S+|-c\s+\S+|--no-pager))*\s+`;
const GIT_THEN_PUSH = String.raw`${GIT_THEN}push\b`;
/** Each `git push` and what follows it up to the next shell operator. An
 *  `&` that belongs to a redirection (`2>&1`, `>&2`, `&>log`, `&>>log`) is
 *  the redirection's, not an operator: the tail runs past it, so the push's
 *  own arguments after one are still judged (`git push 2>&1 evil main`). */
const GIT_PUSH = new RegExp(`${GIT_THEN_PUSH}((?:[^;&|]|(?<=[<>])&|&(?=>))*)`, "g");
/** Any recognized `git push`; the broad form catches global-option shapes
 *  that the guarded parser deliberately does not attempt to reproduce. */
const ANY_PUSH = new RegExp(GIT_THEN_PUSH);
const ANY_GIT_PUSH = /\bgit\b[^;&|\n]*\bpush\b/;
const ALL_GIT_PUSH_SHAPES = new RegExp(ANY_GIT_PUSH.source, "g");

function hasUnrecognizedGitPush(command: string): boolean {
  return [...command.matchAll(ALL_GIT_PUSH_SHAPES)].some((match) => !ANY_PUSH.test(match[0]));
}
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

export function judgeToolCall(tool: string, input: unknown, ctx: ToolRuleContext, callId?: string): ToolVerdict {
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
  if (tool === "bash") return judgeBash(args.command, args.timeout, ctx, callId);
  if (bundle === "files" || bundle === "write-files") return judgePath(args.path, ctx);
  return allowed;
}

function judgeBash(command: unknown, timeout: unknown, ctx: ToolRuleContext, callId: string | undefined): ToolVerdict {
  if (typeof command !== "string") return refused("malformed — bash without a string command");
  const verdict = judgeBashCommand(command, ctx, callId);
  if (verdict.verdict !== "allowed") return verdict;
  return judgeBashTimeout(timeout, ctx);
}

function judgeBashCommand(command: string, ctx: ToolRuleContext, callId: string | undefined): ToolVerdict {
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
    if (ANY_GIT_PUSH.test(command)) return refused("read-only — a read-identity run never pushes");
    if (GH_WRITE_VERB.test(command) || GH_API_WRITE.test(command) || CURL_GITHUB_WRITE.test(command)) {
      return refused("read-only — a read-identity run never writes to GitHub");
    }
    return allowed;
  }
  if (ctx.pushGuard !== undefined && hasUnrecognizedGitPush(command)) return refused(PUSH_WITHOUT_GATE);
  for (const match of command.matchAll(GIT_PUSH)) {
    if (ctx.pushGuard !== undefined && !isGuardedPushInvocation(match[0], match[1])) {
      return refused(PUSH_WITHOUT_GATE);
    }
    const verdict = judgePush(match[1], ctx);
    if (verdict.verdict !== "allowed") return verdict;
    // Authorization observes the checkout before bash starts. Keep the push at
    // the command's first execution boundary so an earlier command or command
    // substitution cannot change the tree after that observation and before
    // Git resolves the ref it sends.
    if (ctx.pushGuard !== undefined && pushCanFollowAnotherCommand(command, match)) {
      return refused(PUSH_WITHOUT_GATE);
    }
  }
  // Only the canonical pipeline can prove the changed set: a literal file
  // list, or text that merely mentions Prettier, says nothing about files the
  // command omitted. The pipeline derives every non-deleted path from the
  // protected base and pipefail keeps a failed diff from looking like an
  // empty, successful formatting run.
  const formattingBase = changedSetFormattingBase(command);
  if (callId !== undefined && formattingBase !== undefined && ctx.protectedBranches?.includes(formattingBase)) {
    ctx.pushGuard?.pendingFormatting.set(callId, undefined);
  }
  return allowed;
}

const CHANGED_SET_PRETTIER =
  /^set -o pipefail && git diff --name-only --diff-filter=ACMR -z origin\/([A-Za-z0-9][A-Za-z0-9._/-]*)\.\.\.HEAD -- \| xargs -0 -r npx prettier --check --ignore-unknown --$/;
const PUSH_WITHOUT_GATE = "the tree changed since the gates ran; run them on this tree, then push";
const TREE_IDENTITY_MARKER = "__SWITCHBOARD_TREE__";
const TREE_IDENTITY_COMMAND =
  "tree=$(git rev-parse 'HEAD^{tree}') || exit $?; " +
  "status=$(git status --porcelain=v1 --untracked-files=normal) || exit $?; " +
  'if test -n "$status"; then state=dirty; else state=clean; fi; ' +
  `printf '${TREE_IDENTITY_MARKER}%s:%s\\n' "$tree" "$state"`;

/** The tree identity is executor-observed, not inferred from the model's
 *  command. Git's tree object binds committed contents; the dirty bit prevents
 *  a clean receipt from crossing working-tree edits. */
export async function inspectGitTree(executor: Executor): Promise<string | undefined> {
  const output = await executor.exec(TREE_IDENTITY_COMMAND);
  return treeIdentity(output);
}

/** Resolve the tree an explicit push source names. Shell quoting and Git's
 *  option delimiter keep the model-provided ref a ref rather than a command. */
export async function inspectGitRefTree(executor: Executor, ref: string): Promise<string | undefined> {
  const revision = shellQuote(`${ref}^{tree}`);
  const output = await executor.exec(
    `tree=$(git rev-parse --verify --end-of-options ${revision}) || exit $?; ` +
      `printf '${TREE_IDENTITY_MARKER}%s:clean\\n' "$tree"`,
  );
  return treeIdentity(output);
}

const PUSH_URLS_MARKER = "__SWITCHBOARD_PUSH_URLS__";
const PUSH_URLS_END_MARKER = "__SWITCHBOARD_PUSH_URLS_END__";
const PUSH_BRANCH_MARKER = "__SWITCHBOARD_PUSH_BRANCH__";
const PUSH_REFS_MARKER = "__SWITCHBOARD_PUSH_REFS__";
const PUSH_DEFAULT_MARKER = "__SWITCHBOARD_PUSH_DEFAULT__";

/** Resolve one push's effective endpoint and all source/destination pairs in
 *  one executor observation. Git prefers every configured pushurl over url;
 *  multiple endpoints, a non-GitHub endpoint, or a repository other than the
 *  run's fail closed. Mirror/follow-tags settings are checked for explicit as
 *  well as omitted refspecs because either can add refs beyond the command. */
export async function inspectGitPush(
  executor: Executor,
  remote: string,
  repository: string,
  explicit?: readonly PushRefspec[],
): Promise<PushResolution | undefined> {
  const pushUrlKey = shellQuote(`remote.${remote}.pushurl`);
  const urlKey = shellQuote(`remote.${remote}.url`);
  const pushKey = shellQuote(`remote.${remote}.push`);
  const mirrorKey = shellQuote(`remote.${remote}.mirror`);
  const sourceCommand =
    explicit === undefined
      ? `git config --get-all ${pushKey} >/dev/null 2>&1; status=$?; ` +
        `if test "$status" -eq 0; then ` +
        `printf '${PUSH_REFS_MARKER}\\0'; git config --null --get-all ${pushKey}; ` +
        `elif test "$status" -eq 1; then ` +
        `mode=$(git config --get push.default 2>/dev/null); mode_status=$?; ` +
        `if test "$mode_status" -eq 1; then mode=simple; elif test "$mode_status" -ne 0; then exit "$mode_status"; fi; ` +
        `printf '${PUSH_DEFAULT_MARKER}%s\\0' "$mode"; ` +
        `else exit "$status"; fi`
      : "";
  const output = await executor.exec(
    `git config --get-regexp '^url\\..*\\.(pushInsteadOf|insteadOf)$' >/dev/null 2>&1; rewrite_status=$?; ` +
      `if test "$rewrite_status" -eq 0; then exit 2; elif test "$rewrite_status" -gt 1; then exit "$rewrite_status"; fi; ` +
      `printf '${PUSH_URLS_MARKER}\\0'; ` +
      `git config --get-all ${pushUrlKey} >/dev/null 2>&1; pushurl_status=$?; ` +
      `if test "$pushurl_status" -eq 0; then git config --null --get-all ${pushUrlKey}; ` +
      `elif test "$pushurl_status" -eq 1; then git config --null --get-all ${urlKey} || exit $?; ` +
      `else exit "$pushurl_status"; fi; ` +
      `printf '${PUSH_URLS_END_MARKER}\\0'; ` +
      `branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null); branch_status=$?; ` +
      `if test "$branch_status" -gt 1; then exit "$branch_status"; fi; ` +
      `printf '${PUSH_BRANCH_MARKER}%s\\0' "$branch"; ` +
      `mirror=$(git config --bool --get ${mirrorKey} 2>/dev/null); mirror_status=$?; ` +
      `if test "$mirror_status" -eq 0 && test "$mirror" = true; then exit 2; ` +
      `elif test "$mirror_status" -gt 1; then exit "$mirror_status"; fi; ` +
      `follow_tags=$(git config --bool --get push.followTags 2>/dev/null); follow_status=$?; ` +
      `if test "$follow_status" -eq 0 && test "$follow_tags" = true; then exit 2; ` +
      `elif test "$follow_status" -gt 1; then exit "$follow_status"; fi; ` +
      sourceCommand,
  );
  const remoteUrl = configuredPushUrl(output, repository);
  if (remoteUrl === undefined) return undefined;
  const branch = configuredPushBranch(output);
  const selected = explicit ?? configuredPushSources(output);
  if (selected === undefined) return undefined;
  const refspecs = selected.map((refspec) =>
    refspec.destination === undefined && refspec.source === "HEAD" && branch !== undefined
      ? { ...refspec, destination: branch }
      : refspec,
  );
  return refspecs.some(({ destination }) => destination === undefined) ? undefined : { remote, remoteUrl, refspecs };
}

function configuredPushUrl(output: string, repository: string): string | undefined {
  const start = output.indexOf(`${PUSH_URLS_MARKER}\0`);
  const end = output.indexOf(`${PUSH_URLS_END_MARKER}\0`, start + PUSH_URLS_MARKER.length + 1);
  if (start < 0 || end < 0) return undefined;
  const payload = output.slice(start + PUSH_URLS_MARKER.length + 1, end);
  const urls = payload.split("\0").filter(Boolean);
  if (urls.length !== 1 || githubRepositoryOf(urls[0])?.toLowerCase() !== repository.toLowerCase()) return undefined;
  return urls[0];
}

function configuredPushBranch(output: string): string | undefined {
  const start = output.indexOf(PUSH_BRANCH_MARKER);
  if (start < 0) return undefined;
  const payload = output.slice(start + PUSH_BRANCH_MARKER.length);
  const end = payload.indexOf("\0");
  return end > 0 ? payload.slice(0, end) : undefined;
}

function githubRepositoryOf(remoteUrl: string): string | undefined {
  const scp = /^(?:[^@\s]+@)?github\.com:([^/?#]+\/[^/?#]+?)(?:\.git)?\/?$/.exec(remoteUrl);
  if (scp) return scp[1].replace(/\.git$/, "");
  try {
    const url = new URL(remoteUrl);
    if (url.hostname.toLowerCase() !== "github.com") return undefined;
    const repository = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    return /^[^/]+\/[^/]+$/.test(repository) ? repository : undefined;
  } catch {
    return undefined;
  }
}

function configuredPushSources(output: string): readonly PushRefspec[] | undefined {
  const refsStart = output.indexOf(`${PUSH_REFS_MARKER}\0`);
  if (refsStart >= 0) {
    const payload = output.slice(refsStart + PUSH_REFS_MARKER.length + 1);
    if (!payload.endsWith("\0")) return undefined;
    const values = payload.slice(0, -1).split("\0");
    if (values.length === 0) return undefined;
    const refspecs = values.map(parsePushRefspec);
    return refspecs.every((refspec): refspec is PushRefspec => refspec !== undefined) ? refspecs : undefined;
  }

  const defaultStart = output.indexOf(PUSH_DEFAULT_MARKER);
  if (defaultStart < 0) return undefined;
  const payload = output.slice(defaultStart + PUSH_DEFAULT_MARKER.length);
  const end = payload.indexOf("\0");
  if (end < 0 || payload.slice(end + 1).trim().length > 0) return undefined;
  switch (payload.slice(0, end).toLowerCase()) {
    case "current":
    case "simple":
      return [{ source: "HEAD" }];
    default:
      // Nothing selects no owned destination; matching, upstream and tracking
      // can select destinations that are not the checked-out branch. Refuse
      // every mode that does not resolve the gated tree to the run's branch.
      return undefined;
  }
}

function parsePushRefspec(refspec: string): PushRefspec | undefined {
  const normalized = refspec.replace(/^\+/, "");
  const separator = normalized.indexOf(":");
  const source = separator < 0 ? normalized : normalized.slice(0, separator);
  const destination = separator < 0 ? (source === "HEAD" ? undefined : source) : normalized.slice(separator + 1);
  if (
    source.length === 0 ||
    destination === "" ||
    source.startsWith("^") ||
    source.startsWith("-") ||
    source.includes("*") ||
    destination?.includes("*") === true
  ) {
    return undefined;
  }
  return destination === undefined ? { source } : { source, destination };
}

function treeIdentity(output: string): string | undefined {
  const match = new RegExp(`${TREE_IDENTITY_MARKER}([0-9a-f]{40,64}):(clean|dirty)`).exec(output);
  return match?.[1] === undefined ? undefined : `${match[1]}:${match[2]}`;
}

function changedSetFormattingBase(command: string): string | undefined {
  return CHANGED_SET_PRETTIER.exec(command)?.[1];
}

function pushCanFollowAnotherCommand(command: string, match: RegExpMatchArray): boolean {
  const beforePush = command.slice(0, match.index ?? 0).trim();
  return beforePush.length > 0 || /`|\$\(|[<>]\(/.test(match[0]);
}

/** A harness calls this when a tool result lands. A failed canonical check
 *  invalidates any earlier receipt. A clean result certifies only the same
 *  clean tree seen at authorization and settlement: a dirty bit cannot bind
 *  the index and working-tree bytes that Prettier inspected. */
export function recordToolResult(ctx: ToolRuleContext, callId: string, ok: boolean): Promise<void> {
  const guard = ctx.pushGuard;
  if (guard === undefined || !guard.pendingFormatting.has(callId)) return Promise.resolve();
  const startedTree = guard.pendingFormatting.get(callId);
  guard.pendingFormatting.delete(callId);
  const revision = ++guard.receiptRevision;
  guard.formattedTree = undefined;
  if (!ok || !startedTree?.endsWith(":clean") || ctx.inspectTree === undefined) return Promise.resolve();

  const settlement = ctx
    .inspectTree()
    .then((settledTree) => {
      if (guard.receiptRevision === revision && settledTree === startedTree) {
        guard.formattedTree = settledTree;
      }
    })
    .catch(() => undefined);
  guard.pendingSettlement = settlement;
  return settlement;
}

/** The runtime form of the pure rule: tree-sensitive calls take a fresh
 *  executor-backed identity before the syntactic verdict is returned. */
export async function judgeToolCallWithTree(
  tool: string,
  input: unknown,
  ctx: ToolRuleContext,
  callId?: string,
): Promise<ToolVerdict> {
  const guard = ctx.pushGuard;
  const command = tool === "bash" && isRecord(input) && typeof input.command === "string" ? input.command : undefined;
  if (guard !== undefined && command !== undefined && ANY_PUSH.test(command)) {
    await guard.pendingSettlement;
    guard.currentTree = await ctx.inspectTree?.().catch(() => undefined);
    const selection = pushSelection(command);
    guard.pushResolution =
      selection === undefined
        ? undefined
        : await ctx.inspectPush?.(selection.remote, selection.explicit).catch(() => undefined);
    if (guard.pushResolution === undefined) {
      guard.pushedTrees = undefined;
    } else {
      const trees = await Promise.all(
        guard.pushResolution.refspecs.map(({ source }) =>
          source === "HEAD" ? guard.currentTree : ctx.inspectRefTree?.(source).catch(() => undefined),
        ),
      );
      guard.pushedTrees = trees.every((tree): tree is string => tree !== undefined) ? trees : undefined;
    }
  }
  const verdict = judgeToolCall(tool, input, ctx, callId);
  if (
    verdict.verdict === "allowed" &&
    guard !== undefined &&
    callId !== undefined &&
    command !== undefined &&
    changedSetFormattingBase(command) !== undefined &&
    guard.pendingFormatting.has(callId)
  ) {
    guard.pendingFormatting.set(callId, await ctx.inspectTree?.().catch(() => undefined));
  }
  return verdict;
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
 *  else is a `repo:use` the grant set does not carry; a destination of `HEAD`
 *  is the branch the driver checked out, the run's, so `git push origin HEAD`
 *  is the same push as naming it. A run naming its own branch may push any but
 *  the protected ones: the base its pull request targets is never pushed to. */
function judgePush(tail: string, ctx: ToolRuleContext): ToolVerdict {
  const [remote, ...refspecs] = pushArguments(tail);
  if (ctx.pushGuard !== undefined && remote === undefined) {
    return refused(PUSH_WITHOUT_GATE);
  }
  if (remote !== undefined && remote !== "origin") {
    return refused(`repo:use — push to remote \`${remote}\`, not the run's repository (origin)`);
  }
  if (refspecs.length > 1 || hasBulkPushOption(tail) || refspecs.some(isBulkRefspec)) {
    return refused(PUSH_WITHOUT_GATE);
  }
  const named = refspecs[0] === undefined ? undefined : parsePushRefspec(refspecs[0]);
  if (named !== undefined) {
    const namedDestination = judgePushDestination(named.destination, ctx);
    if (namedDestination.verdict !== "allowed") return namedDestination;
  }
  // Runtime applies one executor-resolved answer to every form: explicit
  // refspecs and configured defaults reach the same source, destination and
  // endpoint checks. The pure preview has no repository configuration, so it
  // retains the call-only destination policy used by load receipts.
  if (ctx.pushGuard !== undefined) {
    const receipt = judgePushReceipt(ctx);
    if (receipt.verdict !== "allowed") return receipt;
    const destinations = ctx.pushGuard.pushResolution?.refspecs.map(({ destination }) => destination) ?? [];
    if (ctx.branch === undefined && new Set(destinations).size > 1) return refused(PUSH_WITHOUT_GATE);
    for (const destination of destinations) {
      const verdict = judgePushDestination(destination, ctx);
      if (verdict.verdict !== "allowed") return verdict;
    }
    return allowed;
  }
  return allowed;
}

function judgePushDestination(destination: string | undefined, ctx: ToolRuleContext): ToolVerdict {
  if (ctx.branch !== undefined) {
    const branch = destination === undefined ? ctx.branch : destination.replace(/^refs\/heads\//, "");
    if (branch !== ctx.branch) return refused(`repo:use — push to \`${branch}\`, not the run's branch ${ctx.branch}`);
    return allowed;
  }
  if (destination === undefined) return allowed;
  if (destination.startsWith("refs/") && !destination.startsWith("refs/heads/")) {
    return refused(`repo:use — push to \`${destination}\`, not a branch owned by this run`);
  }
  const branch = destination.replace(/^refs\/heads\//, "");
  if ((ctx.protectedBranches ?? []).includes(branch)) {
    return refused(
      `repo:use — push to \`${branch}\`, the branch this run's pull request targets; push your own branch`,
    );
  }
  return allowed;
}

function judgePushReceipt(ctx: ToolRuleContext): ToolVerdict {
  const guard = ctx.pushGuard;
  if (
    guard !== undefined &&
    (guard.formattedTree === undefined ||
      guard.formattedTree !== guard.currentTree ||
      guard.pushResolution === undefined ||
      guard.pushResolution.remote !== "origin" ||
      guard.pushedTrees === undefined ||
      guard.pushedTrees.some((tree) => tree !== guard.formattedTree))
  ) {
    return refused(PUSH_WITHOUT_GATE);
  }
  return allowed;
}

/** The remote and every explicit source/destination named by a push. An
 *  omitted refspec stays undefined so the executor-backed resolver applies
 *  remote.<name>.push or push.default through the same resolution path. */
function pushSelection(command: string): { remote: string; explicit?: readonly PushRefspec[] } | undefined {
  const match = command.matchAll(GIT_PUSH).next().value;
  if (match === undefined) return undefined;
  const [remote, ...rawRefspecs] = pushArguments(match[1]);
  if (remote === undefined) return undefined;
  if (rawRefspecs.length === 0) return { remote };
  const explicit = rawRefspecs.map(parsePushRefspec);
  return explicit.every((refspec): refspec is PushRefspec => refspec !== undefined) ? { remote, explicit } : undefined;
}

/** A shell redirection word (`2>&1`, `>&2`, `&>log`, `>out.log`,
 *  `2>/dev/null`, `<in`): the shell's, never one of the push's arguments. A
 *  bare operator (`>`, `2>`, `>&`) takes the next word as its target. */
const REDIRECTION = /^(\d*|&)(>>|>&|>\|?|<<<?|<&|<>?)(.*)$/;
const BULK_PUSH_OPTIONS = new Set([
  "--all",
  "--branches",
  "--mirror",
  "--tags",
  "--follow-tags",
  "--delete",
  "-d",
  "--prune",
]);
const SAFE_GUARDED_PUSH_OPTIONS = new Set([
  "--",
  "-u",
  "--set-upstream",
  "-f",
  "--force",
  "--force-with-lease",
  "--force-if-includes",
  "--atomic",
  "--dry-run",
  "-n",
  "--porcelain",
  "--no-verify",
  "--verbose",
  "-v",
  "--quiet",
  "-q",
  "--ipv4",
  "-4",
  "--ipv6",
  "-6",
  "--thin",
  "--progress",
]);

/** A guarded push is deliberately static and narrow: no Git context override,
 *  shell-expanded argument, or option that can redirect the repository or
 *  select/delete refs beyond the one refspec the guard inspects. */
function isGuardedPushInvocation(invocation: string, tail: string): boolean {
  if (!/^git\s+push\b/.test(invocation)) return false;
  if (/[$'"\\?[\]{}()]/.test(tail)) return false;
  const raw = tail.split(/\s+/).filter((word) => word.length > 0);
  for (let i = 0; i < raw.length; i++) {
    const redirection = REDIRECTION.exec(raw[i]);
    if (redirection) {
      if (redirection[3] === "") i++;
      continue;
    }
    if (raw[i].startsWith("-") && !SAFE_GUARDED_PUSH_OPTIONS.has(raw[i]) && !raw[i].startsWith("--force-with-lease=")) {
      return false;
    }
  }
  return true;
}

/** Whether Git may select source refs beyond the one explicit refspec the
 *  guard resolves. These forms are deliberately refused rather than trying
 *  to reproduce Git's ref-selection and configuration rules. */
function hasBulkPushOption(tail: string): boolean {
  return tail
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .some((word) => BULK_PUSH_OPTIONS.has(word.replace(/['"\\]/g, "")));
}

/** Git's matching (`:`) and wildcard refspecs can select more than one source
 *  even though they occupy one argument. */
function isBulkRefspec(refspec: string): boolean {
  const normalized = refspec.replace(/['"\\]/g, "").replace(/^\+/, "");
  return normalized === ":" || normalized.includes("*");
}

/** The push's own arguments out of what follows `git push` (already cut at
 *  `|`, `;` and a control `&` by the match): flags dropped, each shell redirection and
 *  its target skipped — skipped, not stopped at, so an argument after one
 *  (`git push 2>/dev/null evil main`) is still judged. */
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
