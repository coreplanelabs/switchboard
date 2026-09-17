import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

// The one exception to the sticky ref binding (docs/reference/specs/resident-repos.md
// item 16): the `ownPr` body field — the pull request the thread's own run
// opened and its head branch — reaches `attachThreadBody`, whose decision is
// the pure `rebindPlan` / `rebindVerdict` of src/execution/residentRebind.ts
// (the tested code IS the shipped code). The move is a decision about the
// binding alone: the row's ref changes under the mirror mutex once the mirror
// is known to hold the branch, and the attach that follows provisions the
// tree at the moved ref exactly as it provisions any tree (item 17) — no
// checkout in place, no flag that keeps a dirty tree. The binding records how
// its ref was chosen (`boundBy`) and the move (`rebound`); the answer carries
// the move or the named refusal. The second movement: a rebound binding whose
// branch is gone from the mirror goes back to the default. Plain Node, the
// entry read as text, never loaded, like reuseAttach.test.ts.

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));

function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

function functionOf(name: string): string {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  expect(start, `worker.ts declares function ${name}`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 3);
}

describe("the `ownPr` and `refByDefault` body fields reach the binding decision", () => {
  it("handleAttach parses both with the pure parsers, checks the PR's ref against the one ref pattern, refuses a malformed field 400, and hands the reason to attachThread", () => {
    expect(source).toMatch(/import \{[^}]*parseOwnPr[^}]*\} from "\.\.\/\.\.\/src\/execution\/residentRebind\.js";/);
    expect(source).toMatch(
      /import \{[^}]*parseRefByDefault[^}]*\} from "\.\.\/\.\.\/src\/execution\/residentRebind\.js";/,
    );
    const handler = functionOf("handleAttach");
    expect(handler).toMatch(/const parsedOwnPr = parseOwnPr\(body\.ownPr\);/);
    expect(handler).toMatch(/if \("error" in parsedOwnPr\) return json\(\{ error: parsedOwnPr\.error \}, 400\);/);
    expect(handler).toMatch(/parseRef\(parsedOwnPr\.ownPr\.ref, "ownPr\.ref"\)/);
    expect(handler).toMatch(/const refByDefault = parseRefByDefault\(body\.refByDefault\);/);
    expect(handler).toMatch(/if \("error" in refByDefault\) return json\(\{ error: refByDefault\.error \}, 400\);/);
    expect(handler).toMatch(
      /attachThread\(\s*ctx\.threadKey,\s*refHint,\s*readonly\.readonly,\s*want\.sha,\s*reuse\.reuse,\s*ctx\.record,\s*traceparent,\s*reason,?\s*\)/,
    );
  });

  it("attachThread carries the reason through the traced body, which asks rebindPlan BEFORE the binding's ref is chosen and records boundBy on a new binding", () => {
    expect(method("attachThread")).toMatch(/reason: RefHintReason = NO_REF_HINT_REASON,/);
    expect(method("attachThreadTraced")).toMatch(
      /attachThreadBody\(\s*threadKey,\s*refHint,\s*readonly,\s*wantSha,\s*reuse,\s*resourceId,\s*t0,\s*record,\s*reason,?\s*\)/,
    );
    const body = method("attachThreadBody");
    const rebind = body.search(/await this\.rebindToOwnPr\(\s*stored\.get\(threadBindingKey\(threadKey\)\)/);
    const ref = body.indexOf("const ref = prior?.ref ?? refHint;");
    expect(rebind).toBeGreaterThan(-1);
    expect(ref).toBeGreaterThan(rebind);
    expect(body).toMatch(/const prior = rebind\.binding;/);
    // A NEW binding records how its ref was chosen; an existing one keeps its own record.
    expect(body).toMatch(
      /allocateThreadUser\(\s*threadKey,\s*ref,\s*worktreePath,\s*boundByFor\(\{ refByDefault: reason\.refByDefault, ref, defaultRef: facts\.defaultRef \}\),?\s*\)/,
    );
    const alloc = method("allocateThreadUser");
    expect(alloc).toMatch(/boundBy: BoundBy,/);
    expect(alloc).toMatch(/: \{ boundBy \}\),/);
    expect(alloc).toMatch(/\{ boundBy: existing\.boundBy \}/);
    expect(alloc).toMatch(/\{ rebound: existing\.rebound \}/);
  });
});

describe("rebindToOwnPr moves the binding, or names why it stands — a decision about the binding alone", () => {
  const rebind = method("rebindToOwnPr");

  it("plans off the binding with the pure rebindPlan and stops there for none and refuse", () => {
    expect(source).toMatch(/import \{[^}]*rebindPlan[^}]*\} from "\.\.\/\.\.\/src\/execution\/residentRebind\.js";/);
    expect(rebind).toMatch(/const plan = rebindPlan\(\{ ownPr, reuse, binding: prior, defaultRef \}\);/);
    expect(rebind).toMatch(/if \(plan\.kind === "none" \|\| prior === undefined\) return \{ binding: prior \};/);
    expect(rebind).toMatch(/if \(plan\.kind === "refuse"\) return \{ binding: prior, rebindRefused: plan\.refused \};/);
  });

  it("re-reads the binding under the mirror mutex before anything is judged or written, and re-judges the plan on that row — a premise that moved while waiting is never overwritten", () => {
    const lockStart = rebind.indexOf("await this.withMirrorLock(");
    const lockEnd = rebind.indexOf("}, ATTACH_MUTEX_WAIT_MS)");
    const reread = rebind.indexOf("const current = (await this.ctx.storage.get<ThreadBinding>(key)) ?? prior;");
    const rejudge = rebind.indexOf("const again = rebindPlan({ ownPr, reuse, binding: current, defaultRef });");
    const move = rebind.indexOf("return this.moveOntoOwnBranch(current, again, fetchToken);");
    expect(lockStart).toBeGreaterThan(-1);
    expect(reread).toBeGreaterThan(lockStart);
    expect(rejudge).toBeGreaterThan(reread);
    expect(move).toBeGreaterThan(rejudge);
    expect(lockEnd).toBeGreaterThan(move);
    expect(rebind).toMatch(/if \(again\.kind === "none"\) return \{ kind: "none", binding: current \};/);
    expect(rebind).toMatch(/if \(again\.kind === "refuse"\) return again;/);
    // Inside the mutex the measure and the move use the re-read row, never the pre-lock snapshot.
    expect(rebind.slice(reread, lockEnd)).not.toMatch(/\bprior\.(user|worktreePath|ref)\b/);
  });

  it("the memory of a release decides by itself; only a branch nothing remembered is looked for in the surviving tree — one probe, AS THE THREAD USER, for the local branch — and rebindVerdict judges it", () => {
    expect(rebind).toMatch(/if \(again\.kind === "measure" && !again\.own\) \{/);
    expect(rebind).toMatch(/this\.run\(\["test", "-d", `\$\{wt\}\/\.git`\]\)/);
    expect(rebind).toMatch(
      /this\.threadRun\(\s*current\.user,\s*wt,\s*`git rev-parse --verify --quiet \$\{shellQuote\(`refs\/heads\/\$\{again\.to\}`\)\}`,/,
    );
    expect(rebind).toMatch(/tree\.branchExists = branch\.exitCode === 0;/);
    expect(rebind).toMatch(/const verdict = rebindVerdict\(again, tree\);/);
    expect(rebind).toMatch(/if \(verdict\.kind === "refuse"\) return verdict;/);
    // The tree's dirt and HEAD are not the rebind's concern: no status, no
    // HEAD probe, no checkout, no fetch, no reset in the tree. The binding
    // moves; the attach provisions the tree (item 17).
    expect(rebind).not.toMatch(/git status/);
    expect(rebind).not.toMatch(/abbrev-ref HEAD/);
    expect(rebind).not.toMatch(/git checkout/);
    expect(rebind).not.toMatch(/git (fetch|reset|clean|stash)/);
    expect(rebind).not.toMatch(/keepTree|dirty|checkout-failed|rebind-checkout/);
    // Nothing is cloned, wiped, re-pathed or re-allocated here either: the tree is the attach's.
    expect(rebind).not.toMatch(/rm", "-rf"/);
    expect(rebind).not.toMatch(/git", "clone"/);
    expect(rebind).not.toMatch(/threadWorktreePath\(/);
    expect(rebind).not.toMatch(/findFreePoolUser\(/);
    expect(rebind).not.toMatch(/allocateThreadUser\(/);
  });

  it("every allowed plan — a live tree or an evicted one — goes through the mirror check on the re-read plan, and the fetch token is minted before the mutex for it", () => {
    const mint = rebind.indexOf("const fetchToken = githubAppConfigured(this.env)");
    const lock = rebind.indexOf("await this.withMirrorLock(");
    expect(mint).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(mint);
    expect(rebind).toMatch(/mintRepoScopedToken\(this\.env, slug\)/);
    expect(rebind).toMatch(/return this\.moveOntoOwnBranch\(current, again, fetchToken\);/);
    expect(rebind).not.toMatch(/moveOntoOwnBranch\(current, plan,/);
    expect(rebind).not.toMatch(/recreateAtOwnBranch/);
  });

  it("a mutex timeout is the attach's 503 mirror-busy; a move is logged as the tree being provisioned at the branch", () => {
    expect(rebind).toMatch(/if \(err instanceof MirrorBusyError\)/);
    expect(rebind).toMatch(/reason: "mirror-busy"/);
    expect(rebind).toMatch(
      /rebound \$\{rebound\.from\} → \$\{rebound\.to\} \(the thread's own pull request #\$\{rebound\.pr\}\); the tree is provisioned at it/,
    );
    expect(rebind).toMatch(/return \{ binding: moved, rebound \};/);
  });
});

describe("moveOntoOwnBranch: the mirror must hold the branch, then the row moves and the attach provisions the tree", () => {
  const move = method("moveOntoOwnBranch");

  it("fetches when the mirror lacks the branch — a failed fetch is logged and degrades to the refusal, never the attach's 500 — and a branch still missing after the fetch (deleted after a merge) is a branch-absent refusal, the binding kept", () => {
    expect(move).toMatch(/await this\.refExists\(plan\.to\)/);
    const tryAt = move.indexOf("try {");
    const fetchAt = move.search(
      /await this\.gitWithCred\(\s*fetchToken,\s*\["-C", MIRROR_DIR, "fetch", "--prune", "origin"\],\s*"fetch",\s*GIT_NETWORK_TIMEOUT_MS,?\s*\)/,
    );
    const catchAt = move.indexOf("} catch (err) {");
    const recheckAt = move.lastIndexOf("present = await this.refExists(plan.to);");
    expect(tryAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(tryAt);
    expect(catchAt).toBeGreaterThan(fetchAt);
    expect(recheckAt).toBeGreaterThan(catchAt);
    expect(move).not.toMatch(/attach-failed/);
    expect(move).not.toMatch(/throw /);
    expect(move).toMatch(/rebindRefused\(\s*plan,\s*"branch-absent",/);
  });

  it("the move is recorded on the row and nothing on disk is touched — the tree is the attach's to provision at the new ref, at the binding's stored path", () => {
    expect(move).toMatch(/const moved: ThreadBinding = \{ \.\.\.current, ref: plan\.to, rebound \};/);
    expect(move).toMatch(/await this\.ctx\.storage\.put\(threadBindingKey\(current\.threadKey\), moved\);/);
    expect(move).toMatch(/return \{ kind: "rebound", moved, rebound \};/);
    expect(move).not.toMatch(/rm", "-rf"/);
    expect(move).not.toMatch(/git", "clone"/);
    expect(move).not.toMatch(/git checkout/);
    expect(move).not.toMatch(/worktreePath/);
    // The path is the binding's throughout: nothing is derived from the moved ref.
    expect(method("attachThreadBody")).toMatch(
      /const worktreePath = prior\?\.worktreePath \?\? \(await threadWorktreePath\(threadKey, ref\)\);/,
    );
  });
});

// The tree after a move is item 17's business, and item 17 has one rule: a
// provisioning attach's tree is clean at the bound ref's tip, or recreated.
// No word from the rebind reaches the worktree step.
describe("the attach after a rebind provisions the tree at the moved ref as it provisions any tree", () => {
  const body = method("attachThreadBody");
  const create = method("attachThreadCreate");
  const ensure = method("ensureThreadWorktree");

  it("no flag about the tree rides from the rebind to the worktree step: the outcome is the moved row alone", () => {
    expect(source).toMatch(/\| \{ kind: "rebound"; moved: ThreadBinding; rebound: Rebound \};/);
    for (const m of [body, create, ensure]) expect(m).not.toMatch(/keepTree/);
    expect(create).toMatch(
      /this\.ensureThreadWorktree\(binding, sha, mode\.originUrl, mode\.modeSwitch, \{\s*detached: target\.kind === "sha",\s*reuse,?\s*\}\)/,
    );
    expect(ensure).toMatch(/opts: \{ detached: boolean; reuse: boolean \}/);
    expect(ensure).toMatch(
      /const decision = decideWorktree\(\{ reuse: opts\.reuse, modeSwitch, sha, worktreePath: wt, facts \}\);/,
    );
  });

  it("the worktree step's one rm -rf and its clone sit behind the pure decision, which recreates a dirty or stale tree — the tree the run left on the old branch included — and no other path in the attach removes or clones a tree", () => {
    const decision = ensure.indexOf("const decision = decideWorktree(");
    const reuse = ensure.indexOf('if (decision.kind === "reuse") return false;');
    const wipe = ensure.indexOf('await this.runOk(["rm", "-rf", wt], "worktree-clean");');
    const clone = ensure.indexOf('"worktree-clone"');
    expect(decision).toBeGreaterThan(-1);
    expect(reuse).toBeGreaterThan(decision);
    expect(wipe).toBeGreaterThan(reuse);
    expect(clone).toBeGreaterThan(wipe);
    for (const m of [body, create, method("rebindToOwnPr"), method("moveOntoOwnBranch")]) {
      expect(m).not.toMatch(/rm", "-rf"/);
      expect(m).not.toMatch(/git", "clone"/);
    }
    // The decision's own word on a dirty tree lives in src/execution/residentReuse.ts: recreate, no exception.
    const reuseModule = readSource("../../src/execution/residentReuse.ts");
    expect(reuseModule).toMatch(/if \(facts\.dirty\) return \{ kind: "recreate", why: "dirty" \};/);
    expect(reuseModule).not.toMatch(/keepTree/);
  });
});

// The second movement (item 16): the thread's branch — one a rebind moved it
// onto, or one its own runs pushed and it was bound to by name (a ship unit's)
// — is deleted once its pull request merges, and a binding left on it would
// fail every later attach `unknown-ref` and fall to a cold sandbox for the
// rest of the thread's life. Decided where the fact is established — under
// the mirror mutex, after the attach's fetch found the ref gone — by the pure
// `canReturnToDefault` / `returnToDefault` over the row's `rebound` and
// `ownBranches`; a person-named ref the thread never pushed keeps the refusal.
describe("a binding whose own branch is gone from the mirror returns to the default, and the run starts clean there", () => {
  const create = method("attachThreadCreate");
  const back = method("returnBindingToDefault");

  it("the create step asks canReturnToDefault only on an unknown-ref target after the fetch, re-targets the default, and still throws unknown-ref for a binding that may not return", () => {
    expect(source).toMatch(
      /import \{[^}]*canReturnToDefault[^}]*\} from "\.\.\/\.\.\/src\/execution\/residentRebind\.js";/,
    );
    expect(source).toMatch(
      /import \{[^}]*returnToDefault[^}]*\} from "\.\.\/\.\.\/src\/execution\/residentRebind\.js";/,
    );
    const lockStart = create.indexOf("await this.withMirrorLock(");
    const fetched = create.indexOf("const why = await this.mirrorFetchReasonFor(binding.ref, want, returnable);");
    const firstTarget = create.indexOf("let target = attachTarget({");
    const gate = create.indexOf('if (target.kind === "unknown-ref" && returnable) {');
    const returned = create.indexOf("const back = await this.returnBindingToDefault(binding, facts.defaultRef);");
    const retarget = create.indexOf("want = wantShaForBinding({ boundRef: binding.ref, refHint, wantSha });", returned);
    const throwAt = create.indexOf('if (target.kind === "unknown-ref") {');
    const worktree = create.indexOf("const recreated = await this.ensureThreadWorktree(binding, sha,");
    expect(lockStart).toBeGreaterThan(-1);
    expect(fetched).toBeGreaterThan(lockStart);
    expect(firstTarget).toBeGreaterThan(fetched);
    expect(gate).toBeGreaterThan(firstTarget);
    expect(returned).toBeGreaterThan(gate);
    expect(retarget).toBeGreaterThan(returned);
    expect(throwAt).toBeGreaterThan(retarget);
    expect(worktree).toBeGreaterThan(throwAt);
    expect(create).toMatch(/binding = back\.binding;\s*returned = back\.returned;/);
    // The default's existence and tip are read for real after the return (item 51 judges the tip too).
    expect(create).toMatch(/const defaultExists = await this\.refExists\(binding\.ref\);/);
    expect(create).toMatch(/refExists: defaultExists,/);
    // The tree is provisioned at the default by the same worktree step, at the same path: nothing special-cased.
    expect(create).toMatch(/let binding = input\.binding;/);
    expect(create).toMatch(/let returned: Returned \| undefined;/);
  });

  it("a returnable ref the mirror still holds is verified against the origin at every attach: the fetch decision is handed canReturnToDefault, computed once before the mutex, so the prune runs and the ref is re-read for real; a verification fetch that fails is one log line and the mirror's ref, while a fetch for a missing or stale ref fails as before", () => {
    expect(source).toMatch(
      /import \{[^}]*mirrorFetchReason[^}]*\} from "\.\.\/\.\.\/src\/execution\/residentHead\.js";/,
    );
    expect(source).not.toMatch(/mirrorNeedsFetch/);
    const decision = method("mirrorFetchReasonFor");
    expect(decision).toMatch(
      /mirrorFetchReasonFor\(\s*ref: string,\s*wantSha: string \| null,\s*returnable: boolean,?\s*\): Promise<FetchReason \| null>/,
    );
    expect(decision).toMatch(/return mirrorFetchReason\(\{ refExists, mirrorSha, wantSha, returnable \}\);/);
    // One predicate, read once off the binding before the lock, drives the mint
    // pre-check, the fetch under the lock and the return gate alike.
    const returnable = create.indexOf("const returnable = canReturnToDefault(binding, facts.defaultRef);");
    const mint = create.indexOf("(await this.mirrorFetchReasonFor(binding.ref, want, returnable))");
    const lockStart = create.indexOf("await this.withMirrorLock(");
    const why = create.indexOf("const why = await this.mirrorFetchReasonFor(binding.ref, want, returnable);");
    const fetch = create.indexOf('["-C", MIRROR_DIR, "fetch", "--prune", "origin"],', why);
    const soft = create.indexOf('if (why !== "returnable-ref") throw err;', fetch);
    const reread = create.indexOf("const refExists = why === null || (await this.refExists(binding.ref));", soft);
    expect(returnable).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(returnable);
    expect(lockStart).toBeGreaterThan(mint);
    expect(why).toBeGreaterThan(lockStart);
    expect(fetch).toBeGreaterThan(why);
    expect(soft).toBeGreaterThan(fetch);
    expect(reread).toBeGreaterThan(soft);
    expect(create.slice(why, reread)).toMatch(/if \(why !== null\) \{\s*try \{\s*await this\.gitWithCred\(/);
    expect(create.slice(soft, reread)).toMatch(
      /the fetch verifying \$\{binding\.ref\} at the origin failed \(\$\{errMsg\(err\)\}\) — the attach goes on with the mirror's ref/,
    );
    // No second predicate spelling: the gate reads the same fact.
    expect(create).not.toMatch(/canReturnToDefault\(binding, facts\.defaultRef\)\)/);
  });

  it("the return re-reads the row under the mutex and hands it whole — rebound and ownBranches alike — to the pure returnToDefault, whose undefined (a person-named ref the thread never pushed, or a row another attach moved meanwhile) is answered as the row stands with nothing written; its row is what gets written", () => {
    expect(back).toMatch(/const current = \(await this\.ctx\.storage\.get<ThreadBinding>\(key\)\) \?\? binding;/);
    expect(back).toMatch(/const back = returnToDefault\(current, defaultRef, /);
    expect(back).toMatch(/if \(back === undefined\) return \{ binding: current \};/);
    // No Worker-side pre-judgement narrows the pure decision to a rebound row:
    // a binding bound by name to a branch it pushed returns too.
    expect(back).not.toMatch(/current\.rebound === undefined/);
    expect(back).not.toMatch(/canReturnToDefault\(/);
    expect(back).toMatch(/await this\.ctx\.storage\.put\(key, back\.binding\);/);
    expect(back).toMatch(
      /is gone from the mirror .* — returned to \$\{back\.returned\.to\}; the tree is provisioned there/,
    );
    // Nothing on disk: the tree is the attach's.
    expect(back).not.toMatch(/rm", "-rf"/);
    expect(back).not.toMatch(/git", "clone"/);
    expect(back).not.toMatch(/threadRun\(/);
  });

  it("the row's final write and the answer speak of the returned binding; the answer carries `returned` for the card", () => {
    const answer = create.slice(create.indexOf("const container = await this.containerIdentity();"));
    expect(answer).toMatch(/ref: binding\.ref,/);
    expect(answer).toMatch(/\.\.\.\(returned !== undefined \? \{ returned \} : \{\}\),/);
    expect(source).toMatch(/interface AttachOk \{[\s\S]*?returned\?: Returned;[\s\S]*?\n\}/);
    // The move's record on the binding carries its return, so the thread may move again.
    const rebindModule = readSource("../../src/execution/residentRebind.ts");
    expect(rebindModule).toMatch(/export interface Rebound \{[\s\S]*?returnedAt\?: string;[\s\S]*?\n\}/);
  });

  it("the binding records its last move back (`returned`) beside `rebound` — the home of the return for a binding never rebound — and a re-allocation after eviction carries it", () => {
    expect(source).toMatch(
      /interface ThreadBinding \{[\s\S]*?rebound\?: Rebound;[\s\S]*?returned\?: Returned;[\s\S]*?\n\}/,
    );
    expect(method("allocateThreadUser")).toMatch(/\{ returned: existing\.returned \}/);
    const rebindModule = readSource("../../src/execution/residentRebind.ts");
    expect(rebindModule).toMatch(/export interface RebindableBinding \{[\s\S]*?returned\?: Returned;[\s\S]*?\n\}/);
  });
});

describe("the run's pushed branches survive the tree: the detach body's `pushed` lands on the binding before any eviction", () => {
  it("handleDetach parses `pushed` with the pure parser, checks every ref against the one ref pattern, refuses a malformed list 400, and hands it to detachThread", () => {
    expect(source).toMatch(/import \{[^}]*parsePushed[^}]*\} from "\.\.\/\.\.\/src\/execution\/residentRebind\.js";/);
    const handler = functionOf("handleDetach");
    expect(handler).toMatch(/const pushed = parsePushed\(body\.pushed\);/);
    expect(handler).toMatch(/if \("error" in pushed\) return json\(\{ error: pushed\.error \}, 400\);/);
    expect(handler).toMatch(/parseRef\(entry\.ref, "pushed\[\]\.ref"\)/);
    expect(handler).toMatch(/detachThread\(ctx\.threadKey, body\.force === true, pushed\.pushed\)/);
  });

  it("detachThread remembers the pushed branches FIRST — before the already-evicted, busy and eviction decisions — so a release that evicts, keeps, or finds the tree already gone all leave the fact behind", () => {
    const detach = method("detachThread");
    expect(detach).toMatch(/pushed: readonly PushedBranch\[\] = \[\],/);
    const remember = detach.indexOf("await this.rememberOwnBranches(threadKey, pushed);");
    const read = detach.indexOf(
      "const binding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));",
    );
    const evicted = detach.indexOf('return { released: false, reason: "already-evicted" };');
    expect(remember).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(remember);
    expect(evicted).toBeGreaterThan(read);
    const keep = method("rememberOwnBranches");
    expect(keep).toMatch(/ownBranches: rememberOwnBranches\(binding\.ownBranches, pushed, /);
    expect(keep).toMatch(/await this\.ctx\.storage\.put\(threadBindingKey\(threadKey\), /);
  });

  it("the memory rides every binding rewrite: a re-allocation after eviction carries it, and the type declares it", () => {
    expect(source).toMatch(/interface ThreadBinding \{[\s\S]*?ownBranches\?: OwnBranch\[\];[\s\S]*?\n\}/);
    expect(method("allocateThreadUser")).toMatch(/\{ ownBranches: existing\.ownBranches \}/);
  });
});

describe("the binding and the attach answer carry the record", () => {
  it("ThreadBinding records boundBy and rebound; AttachOk answers rebound or rebindRefused; the create step spreads them into the answer", () => {
    expect(source).toMatch(
      /interface ThreadBinding \{[\s\S]*?boundBy\?: BoundBy;[\s\S]*?rebound\?: Rebound;[\s\S]*?\n\}/,
    );
    expect(source).toMatch(
      /interface AttachOk \{[\s\S]*?rebound\?: Rebound;[\s\S]*?rebindRefused\?: RebindRefused;[\s\S]*?\n\}/,
    );
    const create = method("attachThreadCreate");
    expect(create).toMatch(/rebound\?: Rebound;/);
    expect(create).toMatch(/rebindRefused\?: RebindRefused;/);
    expect(create).toMatch(/\.\.\.\(rebound !== undefined \? \{ rebound \} : \{\}\),/);
    expect(create).toMatch(/\.\.\.\(rebindRefused !== undefined \? \{ rebindRefused \} : \{\}\),/);
  });

  it("the step vocabulary names no checkout of the thread's own branch: the move is the row's, the tree is the worktree step's", () => {
    const steps = readSource("../../src/execution/residentSteps.ts");
    expect(steps).not.toMatch(/rebind-checkout/);
    expect(steps).toMatch(/"worktree-clone": "cloning the worktree",/);
  });
});
