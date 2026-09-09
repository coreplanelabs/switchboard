// The resident's step vocabulary (docs/reference/specs/tracing.md item 15): every command
// the resident Worker runs is named here, and only here. The Worker's runners
// (`runOk`, `gitWithCred`, `buildUserRun`, `restoreExtracted` in
// deploy/cloudflare-resident/worker.ts) take a `ResidentStepName`, so a step
// the table does not know is a type error there; the run page's display table
// reads the labels, so no grafted step ever renders as `a Switchboard step`.
// Node-free: the Worker bundles this file.

export const RESIDENT_STEP_LABELS = {
  clone: "cloning the repo",
  "checkout-clone": "cloning the checkout",
  "worktree-clone": "cloning the worktree",
  "worktree-detach": "checking out the expected commit",
  "op-clone": "cloning the op tree",
  fetch: "fetching the branch",
  "wake-fetch": "fetching the latest commits",
  "reclaim-fetch": "fetching to reclaim the mirror",
  "for-each-ref": "listing the branches",
  checkout: "checking out the branch",
  "checkout-update": "updating the checkout",
  "rev-parse": "reading the commit",
  "cat-file": "checking the mirror for the commit",
  "show-ref": "reading the branch tip",
  "detect-default-branch": "detecting the default branch",
  git: "a git command",
  "git-setup": "configuring git",
  "stage-perms": "securing the credential stage",
  install: "installing dependencies",
  build: "building",
  test: "running the tests",
  "clear-markers": "clearing the build markers",
  "lockfile-key": "hashing the lockfile",
  "deps-store-dir": "preparing the dependency store",
  "deps-scratch": "cloning a scratch tree for the dependency install",
  "deps-install": "installing the dependency store",
  "deps-harden": "locking down the installed dependencies",
  "deps-commit": "recording the installed dependencies",
  "deps-adopt": "adopting the dependency store",
  "deps-restore-scratch": "restoring dependencies to scratch",
  "deps-restore-chown": "setting the restored dependencies' owner",
  "deps-restore-commit": "recording the restored dependencies",
  "deps-scratch-chown": "setting the dependency scratch owner",
  "deps-evict": "evicting an old dependency store",
  "unlink-deps-view": "unlinking the dependency view",
  "clear-installing-marker": "clearing the install marker",
  chown: "setting the workspace owner",
  "worktree-chown": "setting the worktree owner",
  "op-chown": "setting the op tree's owner",
  "worktree-clean": "cleaning the worktree",
  "clean-workspace": "cleaning the workspace",
  "clean-before-restore": "cleaning before the restore",
  "unmount-restores": "unmounting earlier restores",
  "mirror-restore-extract": "extracting the mirror snapshot",
  "checkout-restore-extract": "extracting the checkout snapshot",
  "deps-restore-extract": "extracting the dependency snapshot",
  evict: "evicting a stale tree",
  "thread-dir": "preparing a directory",
  "threads-dir": "preparing a directory",
  "op-dir": "preparing a directory",
  "ops-dir": "preparing a directory",
  "stage-dir": "preparing a directory",
  stat: "checking a file",
  touch: "touching a marker",
  nproc: "counting CPUs",
  mutex_wait: "waiting for the workspace",
  kill: "stopping the previous step",
} as const satisfies Record<string, string>;

/** A step named in the table. */
export type ResidentStepLabelKey = keyof typeof RESIDENT_STEP_LABELS;

/** A build-user step sweeps the previous step's leftover processes first; that sweep is named after the step it precedes. */
export const STALE_SWEEP_SUFFIX = "-stale-sweep";

/** Every name the Worker's command runners accept: a table entry, or a table entry's stale sweep. */
export type ResidentStepName = ResidentStepLabelKey | `${ResidentStepLabelKey}${typeof STALE_SWEEP_SUFFIX}`;

export const RESIDENT_STEP_NAMES: readonly ResidentStepLabelKey[] = Object.keys(
  RESIDENT_STEP_LABELS,
) as ResidentStepLabelKey[];

function labelKeyOf(name: string): ResidentStepLabelKey | undefined {
  return Object.prototype.hasOwnProperty.call(RESIDENT_STEP_LABELS, name) ? (name as ResidentStepLabelKey) : undefined;
}

/** The label for a step name, or undefined for a name outside the vocabulary. */
export function residentStepLabel(name: string): string | undefined {
  const direct = labelKeyOf(name);
  if (direct !== undefined) return RESIDENT_STEP_LABELS[direct];
  if (name.endsWith(STALE_SWEEP_SUFFIX)) {
    const base = labelKeyOf(name.slice(0, -STALE_SWEEP_SUFFIX.length));
    if (base !== undefined) return `clearing leftovers before ${RESIDENT_STEP_LABELS[base]}`;
  }
  return undefined;
}

export function isResidentStepName(name: string): name is ResidentStepName {
  return residentStepLabel(name) !== undefined;
}
