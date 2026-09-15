/** The one exception to the resident's sticky ref binding
 *  (deploy/cloudflare-resident/worker.ts `attachThreadBody`), kept pure and
 *  dependency-free so it is unit-testable from src/ and imported by the
 *  resident Worker like residentReuse and residentHead: the tested code IS the
 *  shipped code.
 *
 *  Background: a thread's first attach binds a ref, and every later attach in
 *  the thread keeps it — a differing hint is ignored, so a stray word can never
 *  move a thread onto a stranger's branch. That rule has one blind spot: a
 *  thread bound to the repo default because its first message named no branch,
 *  whose own run then created a branch, pushed it and opened a pull request.
 *  The follow-up's target resolution binds that branch (the thread's own PR,
 *  docs/reference/specs/resident-repos.md item 29), the resident ignores it, and
 *  the follow-up runs on the default branch while the thread's work sits on
 *  the branch it made — a push from there would land on the default.
 *
 *  Shape: the caller names the reason for its hint (`ownPr`: the pull request
 *  the thread's own run opened and its head branch — never a PR a person
 *  named). The resident moves the binding only when all of these hold:
 *  - the binding was made by default (the first message named no branch), read
 *    off `boundBy`, or, for a binding made before that field, off whether the
 *    ref is the default branch — a ref a person named is never moved;
 *  - the thread was not rebound before — a thread moves once;
 *  - the branch is a local branch of the thread's OWN worktree — the physical
 *    fact that this thread's run created it; a branch the tree never made is
 *    refused whatever the caller says;
 *  - the tree has no uncommitted tracked changes — never at the cost of work.
 *  The move is a `git checkout` inside the existing tree: same path, same pool
 *  user, deps and snapshot lineage untouched. Every refusal is named in the
 *  attach answer so the bot can say why the follow-up runs where it does. */

/** The pull request the thread's own run opened, and its head branch — the
 *  reason a caller's refHint is that branch. */
export interface OwnPr {
  number: number;
  ref: string;
}

export type ParsedOwnPr = { ownPr: OwnPr | null } | { error: string };

const OWN_PR_ERROR = "ownPr must be {number: <positive integer>, ref: <branch>} when present";

/** `/attach` body field `ownPr`: absent → null (the body every bot always
 *  sent); `{number, ref}` with a positive integer and a non-empty string →
 *  itself; anything else → a 400-shaped error. The ref's PATTERN is the
 *  Worker's to check, where it checks every ref (`parseRef`), before the
 *  string can become a git argument. */
export function parseOwnPr(value: unknown): ParsedOwnPr {
  if (value === undefined) return { ownPr: null };
  if (typeof value !== "object" || value === null) return { error: OWN_PR_ERROR };
  const { number, ref } = value as { number?: unknown; ref?: unknown };
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) return { error: OWN_PR_ERROR };
  if (typeof ref !== "string" || ref.length === 0) return { error: OWN_PR_ERROR };
  return { ownPr: { number, ref } };
}

export type ParsedRefByDefault = { refByDefault: boolean } | { error: string };

/** `/attach` body field `refByDefault`: the caller bound the resident's own
 *  default branch because its message named none (item 30). Absent → false; a
 *  boolean → itself; anything else → a 400-shaped error. */
export function parseRefByDefault(value: unknown): ParsedRefByDefault {
  if (value === undefined) return { refByDefault: false };
  if (typeof value === "boolean") return { refByDefault: value };
  return { error: "refByDefault must be a boolean when present" };
}

/** How a binding's ref was chosen: the repo default for want of a named
 *  branch, or a branch someone named. */
export type BoundBy = "default" | "name";

/** What a NEW binding records: `default` only when the caller said it bound
 *  the default for want of a name AND the ref is that default — a flag on any
 *  other ref is a caller bug, and `name` is the direction that never moves. */
export function boundByFor(input: { refByDefault: boolean; ref: string; defaultRef: string }): BoundBy {
  return input.refByDefault && input.ref === input.defaultRef ? "default" : "name";
}

/** How an EXISTING binding's ref was chosen: the recorded value, or, for a
 *  binding made before the field, `default` iff its ref is the default branch. */
export function boundByOf(binding: { ref: string; boundBy?: BoundBy }, defaultRef: string): BoundBy {
  return binding.boundBy ?? (binding.ref === defaultRef ? "default" : "name");
}

/** The record a rebind leaves on the binding and in the attach answer. */
export interface Rebound {
  from: string;
  to: string;
  pr: number;
  at: string;
}

export type RebindRefusal = "named-ref" | "already-rebound" | "branch-absent" | "dirty" | "checkout-failed";

/** Why the binding stood, in the attach answer: the branch it was asked to
 *  move to, the pull request, the reason and its sentence. */
export interface RebindRefused {
  to: string;
  pr: number;
  reason: RebindRefusal;
  why: string;
}

/** What the plan reads off the thread's binding. */
export interface RebindableBinding {
  ref: string;
  /** "" once evicted: no tree, no user to measure it as. */
  user: string;
  evicted?: boolean;
  boundBy?: BoundBy;
  rebound?: Rebound;
}

export type RebindPlan =
  /** No hint, no binding yet (the hint binds as any refHint), the binding is
   *  already on that branch, or a resumed run's attach. */
  | { kind: "none" }
  /** The binding alone rules it out; nothing on disk is consulted. */
  | { kind: "refuse"; refused: RebindRefused }
  /** The binding allows it; the tree decides (`rebindVerdict`). */
  | { kind: "measure"; from: string; to: string; pr: number };

export function rebindRefused(plan: { to: string; pr: number }, reason: RebindRefusal, why: string): RebindRefused {
  return { to: plan.to, pr: plan.pr, reason, why };
}

/** Whether the binding may move, read off the binding alone. */
export function rebindPlan(input: {
  ownPr: OwnPr | null;
  /** A resumed run's attach keeps the tree exactly as it stands (item 66): its
   *  HEAD is where the run left it and must not move under the run. */
  reuse: boolean;
  binding: RebindableBinding | undefined;
  defaultRef: string;
}): RebindPlan {
  const { ownPr, reuse, binding, defaultRef } = input;
  if (ownPr === null || reuse || binding === undefined || binding.ref === ownPr.ref) return { kind: "none" };
  const plan = { to: ownPr.ref, pr: ownPr.number };
  if (boundByOf(binding, defaultRef) === "name") {
    return {
      kind: "refuse",
      refused: rebindRefused(
        plan,
        "named-ref",
        `the thread is bound to ${JSON.stringify(binding.ref)} by name; a named branch is never moved`,
      ),
    };
  }
  if (binding.rebound) {
    const r = binding.rebound;
    return {
      kind: "refuse",
      refused: rebindRefused(
        plan,
        "already-rebound",
        `the thread was already rebound from ${JSON.stringify(r.from)} to ${JSON.stringify(r.to)} (its pull request #${r.pr}); a thread moves once`,
      ),
    };
  }
  if (binding.evicted || !binding.user) {
    return {
      kind: "refuse",
      refused: rebindRefused(
        plan,
        "branch-absent",
        "the thread's worktree was evicted; the branch cannot be verified there",
      ),
    };
  }
  return { kind: "measure", from: binding.ref, ...plan };
}

/** What the attach measured about the thread's tree, as the thread user. Each
 *  probe past `exists` is measured only when the tree is there. */
export interface RebindTreeFacts {
  /** `<worktree>/.git` is a directory. */
  exists: boolean;
  /** `git rev-parse --verify --quiet refs/heads/<to>` succeeded in the tree. */
  branchExists?: boolean;
  /** `git status --porcelain -uno` ran: false is a tree git cannot read
   *  (corrupt, or owned by an earlier pool user), where nothing is verifiable. */
  readable?: boolean;
  /** `git status --porcelain -uno` listed a tracked change (untracked scratch
   *  files are the thread's own state and survive a checkout). */
  dirty?: boolean;
}

export type RebindVerdict = { kind: "rebind" } | { kind: "refuse"; refused: RebindRefused };

/** The tree's verdict on a measured plan. */
export function rebindVerdict(plan: { to: string; pr: number }, tree: RebindTreeFacts): RebindVerdict {
  if (!tree.exists) {
    return {
      kind: "refuse",
      refused: rebindRefused(
        plan,
        "branch-absent",
        "the thread's worktree is missing; the branch cannot be verified there",
      ),
    };
  }
  if (tree.readable === false) {
    return {
      kind: "refuse",
      refused: rebindRefused(
        plan,
        "branch-absent",
        "the thread's worktree cannot be read; the branch cannot be verified there",
      ),
    };
  }
  if (tree.branchExists !== true) {
    return {
      kind: "refuse",
      refused: rebindRefused(
        plan,
        "branch-absent",
        `${JSON.stringify(plan.to)} is not a local branch of the thread's worktree; only a branch this thread's own run made moves it`,
      ),
    };
  }
  if (tree.dirty === true) {
    return {
      kind: "refuse",
      refused: rebindRefused(
        plan,
        "dirty",
        "the worktree has uncommitted changes on the bound branch; the binding stands until they are committed or discarded",
      ),
    };
  }
  return { kind: "rebind" };
}
