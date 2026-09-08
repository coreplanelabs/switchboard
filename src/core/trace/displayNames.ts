import { STREAMED_SPANS, type StreamedSpanName } from "./streamSpans.js";

// What a reader sees for a span (features/tracing.md): one table over the
// enumerated streamed names — total by type, unique by test — plus one rule per
// prefix family. No user surface prints a raw span name; the card's setup label
// and the timeline's rows and ranked list all come through here.

/** The display name of every enumerated streamed span. */
export const DISPLAY_NAMES = {
  request: "the request",
  "slack.receive": "receiving",
  "dispatch.history": "reading the thread",
  "dispatch.admission": "checking the thread",
  "dispatch.ack_card": "posting the status card",
  "dispatch.gate.repo": "checking the repo",
  "dispatch.gate.pr_head": "checking the PR",
  "dispatch.workspace.attach": "attaching the workspace",
  "dispatch.gate.attached_head": "checking out the branch",
  "dispatch.mcp_discovery": "loading tools",
  "dispatch.compose": "preparing the prompt",
  "dispatch.channel_visibility": "checking the channel",
  "dispatch.repo_context": "reading the repo's context",
  "dispatch.memory_read": "recalling memory",
  "dispatch.refuse": "refusing",
  "dispatch.ship_preflight": "checking the ship request",
  "dispatch.ledger_claim": "claiming the run's row",
  "run.agent": "the agent loop",
  "run.command": "the command",
  "run.reading_diff": "reading the diff (in parallel)",
  "run.reading_diff.upgrade": "upgrading the diff (in parallel)",
  "run.settle_reviewed_head": "re-checking the moved branch",
  "run.observe_workspace": "checking the workspace",
  "run.pr_post_step": "posting the PR",
  "run.reading_diff_join": "waiting for the diff",
  "model.turn": "a model turn",
  "ship.round": "a ship round",
  "post.card_close": "closing the card",
  "post.reply": "posting the reply",
} as const satisfies Record<StreamedSpanName, string>;

/** The resident's steps, as the attach and op grafts name them
 *  (`dispatch.workspace.attach.<step>`, `run.command.<step>`): every step name
 *  the resident Worker passes to its command runners, so a run page never
 *  reads `a Switchboard step` for one of them (a source-scan test keeps the
 *  two in step — a step added to the Worker without a label fails it). */
export const RESIDENT_STEP_NAMES: Readonly<Record<string, string>> = {
  // the repo and its branch
  clone: "cloning the repo",
  "checkout-clone": "cloning the checkout",
  "worktree-clone": "cloning the worktree",
  "op-clone": "cloning the op tree",
  fetch: "fetching the branch",
  "wake-fetch": "fetching the latest commits",
  "reclaim-fetch": "fetching to reclaim the mirror",
  "for-each-ref": "listing the branches",
  checkout: "checking out the branch",
  "rev-parse": "reading the commit",
  "show-ref": "reading the branch tip",
  "detect-default-branch": "detecting the default branch",
  git: "a git command",
  "git-setup": "configuring git",
  "stage-perms": "securing the credential stage",
  // the commands the repo configured
  install: "installing dependencies",
  build: "building",
  test: "running the tests",
  lint: "linting",
  typecheck: "typechecking",
  // the dependency store
  "lockfile-key": "hashing the lockfile",
  "deps-store-dir": "preparing the dependency store",
  "deps-install": "installing the dependency store",
  "deps-adopt": "adopting the dependency store",
  "deps-restore-scratch": "restoring dependencies to scratch",
  "deps-restore-chown": "setting the restored dependencies' owner",
  "deps-scratch-chown": "setting the dependency scratch owner",
  "deps-evict": "evicting an old dependency store",
  "unlink-deps-view": "unlinking the dependency view",
  "clear-installing-marker": "clearing the install marker",
  // the trees and their owners
  chown: "setting the workspace owner",
  "worktree-chown": "setting the worktree owner",
  "op-chown": "setting the op tree's owner",
  "worktree-clean": "cleaning the worktree",
  "clean-workspace": "cleaning the workspace",
  "clean-before-restore": "cleaning before the restore",
  evict: "evicting a stale tree",
  "thread-dir": "preparing a directory",
  "threads-dir": "preparing a directory",
  "op-dir": "preparing a directory",
  "ops-dir": "preparing a directory",
  "stage-dir": "preparing a directory",
  stat: "checking a file",
  touch: "touching a marker",
  nproc: "counting CPUs",
  // the resident's own bookkeeping around a step
  mutex_wait: "waiting for the workspace",
  kill: "stopping the previous step",
};

/** The fallback for a prefixed span whose leaf we cannot name. */
export const GENERIC_STEP_NAME = "a Switchboard step";

/** The display name for any span name: the table for an enumerated name; for a
 *  prefix family the tool's own name (`tool.bash` → `bash`), the MCP tool's own
 *  name (`mcp.<server>.<tool>` → `<tool>`), or the resident step's label, with
 *  `GENERIC_STEP_NAME` when a prefixed leaf is unknown or empty. A name that is
 *  neither enumerated nor prefixed is not streamed and also reads generic. */
export function displayNameOf(name: string): string {
  if (name in DISPLAY_NAMES) return DISPLAY_NAMES[name as StreamedSpanName];
  if (name.startsWith("tool.")) return name.slice("tool.".length) || GENERIC_STEP_NAME;
  if (name.startsWith("mcp.")) {
    const leaf = name.slice(name.lastIndexOf(".") + 1);
    return leaf && leaf !== "mcp" ? leaf : GENERIC_STEP_NAME;
  }
  for (const prefix of ["dispatch.workspace.attach.", "run.command."]) {
    if (name.startsWith(prefix)) return RESIDENT_STEP_NAMES[name.slice(prefix.length)] ?? GENERIC_STEP_NAME;
  }
  return GENERIC_STEP_NAME;
}

/** Every enumerated name, for the totality test. */
export const ENUMERATED_SPAN_NAMES: readonly StreamedSpanName[] = STREAMED_SPANS;
