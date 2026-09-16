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
 *  named). The move is a decision about the BINDING alone; the tree is the
 *  attach's business afterwards (item 17: a run starts from a clean tree at
 *  the bound ref, so the attach provisions the tree at the moved ref as it
 *  provisions any other). The resident moves the binding only when all of
 *  these hold:
 *  - the binding was made by default (the first message named no branch), read
 *    off `boundBy`, or, for a binding made before that field, off whether the
 *    ref is the default branch — a ref a person named is never moved;
 *  - the thread was not rebound before, or its earlier move was returned (the
 *    second movement below) — a thread moves once per pull request;
 *  - the branch is the thread's own: remembered from a release (`ownBranches`,
 *    the branches its runs pushed), or, when nothing was remembered, a local
 *    branch of the thread's surviving tree — the physical fact that this
 *    thread's run created it. A branch neither remembered nor local is
 *    refused whatever the caller says; so is one the mirror does not hold
 *    even after a fetch (the Worker's check: the tree is cloned from it).
 *  Every refusal is named in the attach answer so the bot can say why the
 *  follow-up runs where it does.
 *
 *  The second movement: a rebound binding names a branch that can die — the
 *  pull request merges and the branch is deleted. A binding left on it would
 *  fail every later attach (`unknown-ref`) for the thread's whole life. So a
 *  binding a rebind moved, whose branch the mirror no longer holds after a
 *  fetch, goes back to the default it was bound to (`canReturnToDefault`,
 *  `returnToDefault`); the attach provisions the tree there, clean, and the
 *  thread is default-bound again, so a later own pull request may move it once
 *  more. A ref a person named that vanished keeps the `unknown-ref` refusal:
 *  that branch is the person's to sort out. */

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

/** A branch a run pushed and the pull request it heads — what the run's
 *  release hands the resident (`/detach` body `pushed`), read off the run's
 *  own `pr_opened` events. */
export interface PushedBranch {
  ref: string;
  pr: number;
}

/** The same fact as the binding remembers it, with when it was told. */
export interface OwnBranch extends PushedBranch {
  at: string;
}

/** The most branches one release may hand over: a run pushes a handful at most. */
export const PUSHED_MAX = 20;
/** The most branches a binding remembers: the newest are kept. */
export const OWN_BRANCHES_MAX = 50;

export type ParsedPushed = { pushed: PushedBranch[] } | { error: string };

const PUSHED_ERROR = "pushed must be a list of {ref: <branch>, pr: <positive integer>} when present";

/** `/detach` body field `pushed`: absent → nothing (the body every bot always
 *  sent); a list of up to `PUSHED_MAX` well-formed `{ref, pr}` → itself;
 *  anything else → a 400-shaped error. Each ref's PATTERN is the Worker's to
 *  check (`parseRef`), like every ref. */
export function parsePushed(value: unknown): ParsedPushed {
  if (value === undefined) return { pushed: [] };
  if (!Array.isArray(value) || value.length > PUSHED_MAX) return { error: PUSHED_ERROR };
  const pushed: PushedBranch[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return { error: PUSHED_ERROR };
    const { ref, pr } = entry as { ref?: unknown; pr?: unknown };
    if (typeof ref !== "string" || ref.length === 0) return { error: PUSHED_ERROR };
    if (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr <= 0) return { error: PUSHED_ERROR };
    pushed.push({ ref, pr });
  }
  return { pushed };
}

/** The binding's memory after a release: every branch handed over is
 *  remembered once — a branch pushed again moves to the end with its current
 *  pull request and time — and only the newest `OWN_BRANCHES_MAX` are kept.
 *  Stored BEFORE any eviction decision, so the fact survives the tree. */
export function rememberOwnBranches(
  existing: readonly OwnBranch[] | undefined,
  pushed: readonly PushedBranch[],
  at: string,
): OwnBranch[] {
  const refs = new Set(pushed.map((p) => p.ref));
  const kept = (existing ?? []).filter((b) => !refs.has(b.ref));
  const added = pushed.map((p) => ({ ref: p.ref, pr: p.pr, at }));
  return [...kept, ...added].slice(-OWN_BRANCHES_MAX);
}

/** Whether the thread's own runs pushed `ref`, as the binding remembers it. */
export function isOwnBranch(binding: { ownBranches?: readonly OwnBranch[] }, ref: string): boolean {
  return (binding.ownBranches ?? []).some((b) => b.ref === ref);
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

/** The record a rebind leaves on the binding and in the attach answer: from
 *  which ref, onto which branch, for which pull request, when. `returnedAt`:
 *  that branch was gone from the mirror at a later attach and the binding
 *  went back to the default (the second movement) — a returned move no
 *  longer counts as the thread's one move. */
export interface Rebound {
  from: string;
  to: string;
  pr: number;
  at: string;
  returnedAt?: string;
}

/** The move back, in the attach answer: from the branch that is gone, to the
 *  default, for the pull request whose branch it was, when. */
export interface Returned {
  from: string;
  to: string;
  pr: number;
  at: string;
}

export type RebindRefusal = "named-ref" | "already-rebound" | "branch-absent";

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
  /** The branches the thread's own runs pushed, handed over at each release. */
  ownBranches?: OwnBranch[];
}

export type RebindPlan =
  /** No hint, no binding yet (the hint binds as any refHint), the binding is
   *  already on that branch, or a resumed run's attach. */
  | { kind: "none" }
  /** The binding alone rules it out; nothing on disk is consulted. */
  | { kind: "refuse"; refused: RebindRefused }
  /** The binding allows it and has a live tree. `own`: the thread's own runs
   *  pushed the branch, as the binding remembers it — the fact that decides;
   *  when nothing was remembered, the tree's local branch is the fallback
   *  evidence (`rebindVerdict`). */
  | { kind: "measure"; from: string; to: string; pr: number; own: boolean }
  /** The binding allows it, its tree was evicted, and the thread's own runs
   *  pushed the branch: the binding moves and the attach recreates the tree
   *  at the branch — once the mirror is known to hold it. */
  | { kind: "recreate"; from: string; to: string; pr: number };

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
  // A move that was returned (its branch gone, the binding back on the
  // default) no longer stands in the way: the thread may follow its next
  // pull request as it followed the first.
  if (binding.rebound && binding.rebound.returnedAt === undefined) {
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
  const own = isOwnBranch(binding, plan.to);
  if (binding.evicted || !binding.user) {
    if (own) return { kind: "recreate", from: binding.ref, ...plan };
    return {
      kind: "refuse",
      refused: rebindRefused(
        plan,
        "branch-absent",
        `the thread's worktree was evicted and none of its runs pushed ${JSON.stringify(plan.to)}; only a branch this thread's own run pushed moves it`,
      ),
    };
  }
  return { kind: "measure", from: binding.ref, ...plan, own };
}

/** What the attach measured about the thread's tree, as the thread user —
 *  only when the binding remembers no push of the branch: the tree is then
 *  the only place the branch's origin can be read. */
export interface RebindTreeFacts {
  /** `<worktree>/.git` is a directory. */
  exists: boolean;
  /** `git rev-parse --verify --quiet refs/heads/<to>` succeeded in the tree;
   *  false for a branch the tree never made and for a tree git cannot read
   *  (neither verifies anything). */
  branchExists?: boolean;
}

export type RebindVerdict =
  /** The branch is the thread's own: move the binding. The tree is not this
   *  verdict's concern — the attach provisions it at the moved ref (item 17),
   *  once the Worker has seen the mirror hold the branch. */
  { kind: "rebind" } | { kind: "refuse"; refused: RebindRefused };

/** Whether the branch is the thread's own, for a measured plan: the memory of
 *  a release decides by itself; without it, the surviving tree must hold the
 *  branch as a local branch. */
export function rebindVerdict(plan: { to: string; pr: number; own?: boolean }, tree: RebindTreeFacts): RebindVerdict {
  if (plan.own === true) return { kind: "rebind" };
  if (!tree.exists) {
    return {
      kind: "refuse",
      refused: rebindRefused(
        plan,
        "branch-absent",
        `the thread's worktree is missing and none of its runs pushed ${JSON.stringify(plan.to)}; the branch cannot be verified there`,
      ),
    };
  }
  if (tree.branchExists !== true) {
    return {
      kind: "refuse",
      refused: rebindRefused(
        plan,
        "branch-absent",
        `${JSON.stringify(plan.to)} is not a local branch of the thread's worktree and none of its runs pushed it; only a branch this thread's own run made moves it`,
      ),
    };
  }
  return { kind: "rebind" };
}

/** Whether a binding whose ref the mirror no longer holds goes back to the
 *  default branch (the second movement): only a binding a rebind moved onto
 *  its own pull request's branch — bound by default in the first place, still
 *  on that branch, the move not yet returned. Anything else keeps the
 *  attach's `unknown-ref` refusal: a ref a person named is that person's to
 *  sort out, and a binding on the default cannot lose its ref. */
export function canReturnToDefault(
  binding: { ref: string; boundBy?: BoundBy; rebound?: Rebound },
  defaultRef: string,
): boolean {
  const r = binding.rebound;
  if (r === undefined || r.returnedAt !== undefined || binding.ref !== r.to) return false;
  return binding.ref !== defaultRef && boundByOf(binding, defaultRef) === "default";
}

/** The move back: the binding's ref becomes the default and the move that
 *  brought it here is stamped returned, so the thread may move again. Only
 *  ever applied to a binding `canReturnToDefault` admitted. */
export function returnToDefault<B extends { ref: string; rebound?: Rebound }>(
  binding: B & { rebound: Rebound },
  defaultRef: string,
  at: string,
): { binding: B; returned: Returned } {
  const returned: Returned = { from: binding.ref, to: defaultRef, pr: binding.rebound.pr, at };
  return { binding: { ...binding, ref: defaultRef, rebound: { ...binding.rebound, returnedAt: at } }, returned };
}
