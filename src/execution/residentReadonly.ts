/** The read-only attach decision of the resident Worker's `attachThread`
 *  (deploy/cloudflare-resident/worker.ts), kept pure and dependency-free so it
 *  is unit-testable from src/ and imported across packages by the resident
 *  Worker (like residentDetach / shellQuote) — the tested code IS the shipped
 *  code.
 *
 *  Background (2026-08-29, PR #182): a review run — read-only "by convention"
 *  — held a per-attach GitHub credential file and an `origin` pointing at
 *  GitHub, fetched another PR's branch because the PR body referenced it, and
 *  its verdict landed on the wrong PR (#194 added the post-step guard). This
 *  removes the capability: a read-only attach gets no credential file and an
 *  `origin` it cannot fetch from, so "read-only" is enforced by the worktree,
 *  not requested of the model.
 *
 *  Mode is sticky per attach, not per thread: the binding records the mode
 *  the tree was last built for, and an attach in the OTHER mode recreates the
 *  tree (a credential-less, mirror-origin tree must never be handed to a
 *  writable run, and a writable tree's credential file must never survive
 *  into a read-only run). Recreating is the simple safe option — the only
 *  state a tree carries between attaches is scratch files, and a mode switch
 *  on one thread is rare (a thread is normally one agent for its whole life). */

export type ParsedReadonly = { readonly: boolean } | { error: string };

/** `/attach` body field `readonly`: absent → false (older bots never send it);
 *  a boolean → itself; anything else → a 400-shaped error. */
export function parseReadonly(value: unknown): ParsedReadonly {
  if (value === undefined) return { readonly: false };
  if (typeof value === "boolean") return { readonly: value };
  return { error: "readonly must be a boolean when present" };
}

export interface ReadonlyAttachPlan {
  /** The mode this attach builds/reuses the tree for (recorded on the binding). */
  readonly: boolean;
  /** True when the existing tree was built for the other mode and must be wiped
   *  before reuse — evaluated before the ordinary dirty/stale checks. */
  modeSwitch: boolean;
  /** Mint a repo-scoped token for the tree and write the credential file (writable only). A read-only attach never puts a token in the tree; the mirror's own recovery fetch (root, outside the tree) may still mint one. */
  credentialFile: boolean;
  /** Remove any credential file / helper config from the tree (read-only, every
   *  attach — a reused tree may predate this rule). */
  scrubCredentials: boolean;
  /** What the worktree's `origin` points at after clone. */
  originUrl: string;
}

export function planReadonlyAttach(input: {
  readonly: boolean;
  /** The thread's existing binding, if any. `evicted` trees are gone from disk
   *  and are recreated anyway, so their recorded mode is irrelevant. */
  prior?: { readonly?: boolean; evicted?: boolean };
  /** `owner/name` of the repo — the writable origin. */
  slug: string;
  /** The resident's bare mirror path — the read-only origin. Thread users are
   *  denied traversal into it (root:worker1 750), so fetch/push fail while
   *  the clone-time remote-tracking refs (`origin/<default>`) stay usable for
   *  `git diff origin/main...HEAD`. */
  mirrorDir: string;
}): ReadonlyAttachPlan {
  const { readonly, prior, slug, mirrorDir } = input;
  const priorLive = prior !== undefined && !prior.evicted;
  const modeSwitch = priorLive && (prior.readonly ?? false) !== readonly;
  return {
    readonly,
    modeSwitch,
    credentialFile: !readonly,
    scrubCredentials: readonly,
    originUrl: readonly ? mirrorDir : `https://github.com/${slug}.git`,
  };
}
