import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

// The one exception to the sticky ref binding (docs/reference/specs/resident-repos.md
// item 16): the `ownPr` body field — the pull request the thread's own run
// opened and its head branch — reaches `attachThreadBody`, whose decision is
// the pure `rebindPlan` / `rebindVerdict` of src/execution/residentRebind.ts
// (the tested code IS the shipped code). The move is a `git checkout` inside
// the thread's existing worktree, measured and run as the thread user under
// the mirror mutex: no clone, no `rm -rf`, no new path, no new pool user. The
// binding records how its ref was chosen (`boundBy`) and the move (`rebound`);
// the answer carries the move or the named refusal. Plain Node, the entry read
// as text, never loaded, like reuseAttach.test.ts.

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

describe("rebindToOwnPr moves the binding in place, or names why it stands", () => {
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
    const put = rebind.indexOf("await this.ctx.storage.put(key, moved);");
    expect(lockStart).toBeGreaterThan(-1);
    expect(reread).toBeGreaterThan(lockStart);
    expect(rejudge).toBeGreaterThan(reread);
    expect(put).toBeGreaterThan(rejudge);
    expect(lockEnd).toBeGreaterThan(put);
    expect(rebind).toMatch(/if \(again\.kind === "none"\) return \{ kind: "none", binding: current \};/);
    expect(rebind).toMatch(/if \(again\.kind === "refuse"\) return again;/);
    // Inside the mutex the measure, the checkout and the write all use the re-read row, never the pre-lock snapshot.
    expect(rebind.slice(reread, lockEnd)).not.toMatch(/\bprior\.(user|worktreePath|ref)\b/);
  });

  it("measures the tree AS THE THREAD USER under the mirror mutex — the branch is a local branch of this tree, the tracked files are clean and judged only off a status git could read — and asks rebindVerdict", () => {
    expect(rebind).toMatch(/this\.run\(\["test", "-d", `\$\{wt\}\/\.git`\]\)/);
    expect(rebind).toMatch(
      /this\.threadRun\(\s*current\.user,\s*wt,\s*`git rev-parse --verify --quiet \$\{shellQuote\(`refs\/heads\/\$\{again\.to\}`\)\}`,/,
    );
    expect(rebind).toMatch(
      /this\.threadRun\(\s*current\.user,\s*wt,\s*"git status --porcelain -uno",\s*DEFAULT_EXEC_TIMEOUT_MS,?\s*\)/,
    );
    expect(rebind).toMatch(
      /tree\.readable = status\.exitCode === 0;\s*if \(tree\.readable\) tree\.dirty = status\.stdout\.trim\(\) !== "";/,
    );
    // The verdict is judged on the re-read plan, which carries `own`; the pre-lock plan lacks it when it was a recreate.
    expect(rebind).toMatch(/const verdict = rebindVerdict\(again, tree\);/);
    expect(rebind).not.toMatch(/rebindVerdict\(plan,/);
  });

  it("the move is one `git checkout` inside the existing tree as the thread user, recorded as its own step; a failed checkout is a named refusal, never an attach failure", () => {
    expect(rebind).toMatch(/`git checkout --quiet \$\{shellQuote\(again\.to\)\}`/);
    expect(rebind).toMatch(/record\("rebind-checkout",/);
    expect(rebind).toMatch(/rebindRefused\(again, "checkout-failed",/);
    // Nothing is cloned, wiped, re-pathed or re-allocated: same worktree, same pool user.
    expect(rebind).not.toMatch(/rm", "-rf"/);
    expect(rebind).not.toMatch(/git", "clone"/);
    expect(rebind).not.toMatch(/threadWorktreePath\(/);
    expect(rebind).not.toMatch(/findFreePoolUser\(/);
    expect(rebind).not.toMatch(/allocateThreadUser\(/);
  });

  it("a rebind rewrites the re-read binding's ref and records the move on it, inside the mutex; a mutex timeout is the attach's 503 mirror-busy", () => {
    expect(rebind).toMatch(
      /const rebound: Rebound = \{\s*from: current\.ref,\s*to: again\.to,\s*pr: again\.pr,\s*at: /,
    );
    expect(rebind).toMatch(/const moved: ThreadBinding = \{ \.\.\.current, ref: again\.to, rebound \};/);
    expect(rebind).toMatch(/await this\.ctx\.storage\.put\(key, moved\);/);
    expect(rebind).toMatch(/if \(err instanceof MirrorBusyError\)/);
    expect(rebind).toMatch(/reason: "mirror-busy"/);
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

  it("detachThread remembers the pushed branches FIRST — before the already-evicted, busy, dirty and eviction decisions — so a release that evicts, keeps, or finds the tree already gone all leave the fact behind", () => {
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

describe("rebindToOwnPr recreates the tree at a remembered branch when the tree is gone", () => {
  const rebind = method("rebindToOwnPr");

  it("an evicted binding's recreate plan, and a live binding whose tree turned out missing, both go through the mirror check — never the local-branch probe — on the re-read plan", () => {
    expect(rebind).toMatch(
      /if \(again\.kind === "recreate"\) return this\.recreateAtOwnBranch\(current, again, fetchToken\);/,
    );
    expect(rebind).toMatch(
      /if \(verdict\.kind === "recreate"\) return this\.recreateAtOwnBranch\(current, again, fetchToken\);/,
    );
    expect(rebind).not.toMatch(/recreateAtOwnBranch\(current, plan,/);
  });

  it("the mirror must hold the branch to clone it: fetched when missing — a failed fetch is logged and degrades to the refusal, never the attach's 500 — and a branch still missing after the fetch (deleted after a merge) is a branch-absent refusal, the binding kept", () => {
    const recreate = method("recreateAtOwnBranch");
    expect(recreate).toMatch(/await this\.refExists\(plan\.to\)/);
    const tryAt = recreate.indexOf("try {");
    const fetchAt = recreate.search(
      /await this\.gitWithCred\(\s*fetchToken,\s*\["-C", MIRROR_DIR, "fetch", "--prune", "origin"\],\s*"fetch",\s*GIT_NETWORK_TIMEOUT_MS,?\s*\)/,
    );
    const catchAt = recreate.indexOf("} catch (err) {");
    const recheckAt = recreate.lastIndexOf("present = await this.refExists(plan.to);");
    expect(tryAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(tryAt);
    expect(catchAt).toBeGreaterThan(fetchAt);
    expect(recheckAt).toBeGreaterThan(catchAt);
    expect(recreate).not.toMatch(/attach-failed/);
    expect(recreate).not.toMatch(/throw /);
    expect(recreate).toMatch(/rebindRefused\(\s*plan,\s*"branch-absent",/);
    // The move is recorded on the row; the tree itself is the attach's to clone at the new ref.
    expect(recreate).toMatch(/const moved: ThreadBinding = \{ \.\.\.current, ref: plan\.to, rebound \};/);
    expect(recreate).toMatch(/await this\.ctx\.storage\.put\(threadBindingKey\(current\.threadKey\), moved\);/);
    expect(recreate).not.toMatch(/rm", "-rf"/);
    expect(recreate).not.toMatch(/git", "clone"/);
    expect(recreate).not.toMatch(/git checkout/);
  });

  it("the fetch token is minted before the mutex, only when a recreate is possible, and never for a plan the binding already ruled out", () => {
    const mint = rebind.indexOf("const fetchToken =");
    const lock = rebind.indexOf("await this.withMirrorLock(");
    expect(mint).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(mint);
    expect(rebind).toMatch(/plan\.kind === "recreate" \|\| plan\.own/);
    expect(rebind).toMatch(/mintRepoScopedToken\(this\.env, slug\)/);
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

  it("the step vocabulary names the checkout", () => {
    const steps = readSource("../../src/execution/residentSteps.ts");
    expect(steps).toMatch(/"rebind-checkout": "checking out the thread's own branch",/);
  });
});
