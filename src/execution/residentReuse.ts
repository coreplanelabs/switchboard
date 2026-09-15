/** The worktree decision of the resident Worker's attach
 *  (deploy/cloudflare-resident/worker.ts `ensureThreadWorktree`), kept pure
 *  and dependency-free so it is unit-testable from src/ and imported by the
 *  resident Worker like residentReadonly and residentHead: the tested code IS
 *  the shipped code.
 *
 *  Background: an attach treated the thread's tree as disposable: dirty
 *  tracked files or a HEAD off the mirror's tip meant `rm -rf` and a fresh
 *  clone. That is the right discipline for a fresh run, whose tree is a
 *  leftover of some earlier run in the thread. It is the wrong discipline for
 *  a run that comes back after a bot restart: the dirty tree IS that run's
 *  work, and the wipe either destroyed it under a still-living process or
 *  raced that process's own writes and failed the attach outright.
 *
 *  Shape: the caller says whether this attach REUSES (a resumed run) or
 *  PROVISIONS (a fresh one). A reusing attach keeps a readable tree exactly
 *  as it stands, dirt and stale HEAD included, and refuses by name a tree it
 *  cannot keep (gone, unreadable, built for the other mode) without touching
 *  it. A provisioning attach keeps the dirty/stale discipline byte for byte. */

export type ParsedReuse = { reuse: boolean } | { error: string };

/** `/attach` body field `reuse`: absent → false (the body every bot always
 *  sent, a fresh attach); a boolean → itself; anything else → a 400-shaped error. */
export function parseReuse(value: unknown): ParsedReuse {
  if (value === undefined) return { reuse: false };
  if (typeof value === "boolean") return { reuse: value };
  return { error: "reuse must be a boolean when present" };
}

/** What the attach measured about the tree on disk, as the thread user. Each
 *  probe past `exists` is measured only when the one before it allowed; an
 *  unmeasured fact is undefined. */
export interface WorktreeFacts {
  /** `<worktree>/.git` is a directory. */
  exists: boolean;
  /** `git status --porcelain -uno` and `git rev-parse HEAD` both succeeded. */
  readable?: boolean;
  /** The failing probe's first error line, when one failed. */
  detail?: string;
  /** Tracked files differ from HEAD (untracked scratch files never count). */
  dirty?: boolean;
  /** The tree's HEAD. */
  head?: string;
  /** Whether the target commit is an ancestor of HEAD, measured by a
   *  provisioning attach whose HEAD is not the target; never by a reusing one. */
  descendsFromTip?: boolean;
}

export type WorktreeDecision =
  /** Keep the tree exactly as it stands. */
  | { kind: "reuse" }
  /** Wipe it and clone afresh (a provisioning attach only). */
  | { kind: "recreate"; why: "mode-switch" | "missing" | "unreadable" | "dirty" | "stale" }
  /** A reusing attach cannot keep this tree, and must not replace it. */
  | { kind: "refuse"; why: string };

export function decideWorktree(input: {
  /** True for a resumed run's attach: keep the tree, never wipe it. */
  reuse: boolean;
  /** The tree was built for the other mode (read-only against writable). */
  modeSwitch: boolean;
  /** The commit a provisioning attach checks out: the ref's tip, or the expected head. */
  sha: string;
  worktreePath: string;
  facts: WorktreeFacts;
}): WorktreeDecision {
  const { reuse, modeSwitch, sha, worktreePath, facts } = input;
  if (modeSwitch) {
    return reuse
      ? {
          kind: "refuse",
          why: `the worktree at ${worktreePath} was built for the other mode (read-only against writable)`,
        }
      : { kind: "recreate", why: "mode-switch" };
  }
  if (!facts.exists) {
    return reuse
      ? {
          kind: "refuse",
          why: `no worktree at ${worktreePath}: the container disk was recycled or the tree was evicted since the run attached`,
        }
      : { kind: "recreate", why: "missing" };
  }
  if (facts.readable !== true) {
    return reuse
      ? {
          kind: "refuse",
          why: `the worktree at ${worktreePath} cannot be read (${facts.detail ?? "git probe failed"})`,
        }
      : { kind: "recreate", why: "unreadable" };
  }
  // A reusing attach judges nothing past readability: the dirt and the HEAD are the run's own state.
  if (reuse) return { kind: "reuse" };
  if (facts.dirty) return { kind: "recreate", why: "dirty" };
  if (facts.head !== sha && facts.descendsFromTip !== true) return { kind: "recreate", why: "stale" };
  return { kind: "reuse" };
}
