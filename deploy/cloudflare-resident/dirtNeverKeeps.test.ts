import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

// A tree is never kept for its dirt (docs/reference/specs/resident-repos.md
// item 17): a run starts from a clean tree at its bound ref, so uncommitted
// changes and unpushed commits in a tree no run is using protect nothing —
// the next attach wipes them. The one thing that keeps a tree is an op in
// flight in it. So the reclamation of a finished ref (item 45), the eviction
// under disk pressure (item 55) and the idle-sleep gate (item 16b) decide
// without the clean check, and every eviction records what the tree it
// removed held — the counts, or that git could not read it — on the binding
// beside `evictedWhy` and in one log line, so nothing is discarded silently.
// The disk-full recycle (item 54) destroys every tree at once, as a platform
// sleep does, so it reads the idle gate's own predicate — a live binding used
// within the floor — and never the trees: the disk may go away when no run is
// using it. Plain Node, the entry read as text, never loaded — like
// releaseAtRunEnd.test.ts.

const source = readSource("worker.ts");
const gc = readSource("gc.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));

function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

describe("the idle-sleep gate asks about attaches and ops, never about dirt", () => {
  const isIdle = method("isIdle");

  it("isIdle is recent use and the in-flight count alone — a dirty live tree never pins the container awake", () => {
    expect(isIdle).toMatch(/if \(this\.recentlyUsed\(await this\.liveBindings\(\)\)\) return false;/);
    expect(isIdle).toMatch(/return this\.inFlightCount\(\) === 0;/);
    expect(isIdle).not.toMatch(/liveTreesClean|worktreeCleanliness|isRuntimeActive|measureTreeBeforeEviction/);
  });

  it("the recent-use arithmetic lives once, in the predicate both the idle gate and the disk-full recycle read", () => {
    const recentlyUsed = method("recentlyUsed");
    expect(recentlyUsed).toMatch(/const recent = systemClock\(\) - IDLE_AFTER_S \* 1000;/);
    expect(recentlyUsed).toMatch(/return live\.some\(\(b\) => Date\.parse\(b\.lastAttachAt\) >= recent\);/);
    expect([...residentDO.matchAll(/IDLE_AFTER_S \* 1000/g)]).toHaveLength(1);
    expect([...residentDO.matchAll(/this\.recentlyUsed\(/g)]).toHaveLength(2);
  });

  it("the clean check over every live tree is gone — no reader of the trees decides whether the container stays", () => {
    expect(source).not.toMatch(/liveTreesClean|treesClean/);
  });
});

describe("the disk-full recycle goes by liveness, never by dirt", () => {
  const recover = method("recoverFromDiskFull");
  const disk = readSource("../../src/execution/residentDisk.ts");

  it("the pure plan takes the cooldown, the in-flight count and recent use — no input about the trees", () => {
    const input = /export function planDiskFullRecovery\(input: \{[\s\S]*?\n\}\): DiskFullRecovery \{/.exec(disk);
    expect(input, "residentDisk.ts declares planDiskFullRecovery").not.toBeNull();
    expect(input![0]).toMatch(/inFlight: number;/);
    expect(input![0]).toMatch(/recentlyUsed: boolean;/);
    expect(input![0]).toMatch(/idleFloorS: number;/);
    expect(input![0]).not.toMatch(/clean|dirty|tree/i);
    expect(disk).not.toMatch(/treesClean|dirty|uncommitted|unpushed/i);
  });

  it("the Worker feeds the plan the idle gate's own predicate at its floor, the calling cycle excluded from the in-flight count", () => {
    expect(recover).toMatch(/inFlight: this\.inFlightCount\(\) - selfInFlight,/);
    expect(recover).toMatch(/recentlyUsed: this\.recentlyUsed\(live\),/);
    expect(recover).toMatch(/idleFloorS: IDLE_AFTER_S,/);
    expect(recover).not.toMatch(/treesClean|liveTreesClean|worktreeCleanliness|\.clean\b/);
  });

  it("a recycle discards every live tree like an eviction: each is measured first (runtime up), the plan is decided again over fresh facts, the record is written, then the container stops", () => {
    const plan = recover.indexOf('if (first.action === "wait") return kept(first.why);');
    const active = recover.indexOf("const active = await this.isRuntimeActive().catch(() => false);");
    const measure = recover.indexOf("await this.measureTreeBeforeEviction(binding)");
    const verdict = recover.indexOf("const verdict = plan(await this.liveBindings());");
    const refuse = recover.indexOf('if (verdict.action === "wait") return kept(verdict.why);');
    const record = recover.indexOf("await this.recordRecycledTree(binding, tree);");
    const stamp = recover.indexOf("await this.ctx.storage.put(DISK_FULL_RECYCLE_KEY, systemClock());");
    const stop = recover.indexOf("await this.stop().catch(");
    expect(plan).toBeGreaterThan(-1);
    expect(active).toBeGreaterThan(plan);
    expect(measure).toBeGreaterThan(active);
    expect(verdict).toBeGreaterThan(measure);
    expect(refuse).toBeGreaterThan(verdict);
    expect(record).toBeGreaterThan(refuse);
    expect(stamp).toBeGreaterThan(record);
    expect(stop).toBeGreaterThan(stamp);
  });

  it("the record sits on the live binding under the recycle's own name — the binding is not evicted, its user kept, the tree recreated on the next attach — both fields rewritten, one log line when something was there", () => {
    const record = method("recordRecycledTree");
    expect(record).toMatch(/if \(!now \|\| now\.evicted \|\| now\.lastAttachAt !== binding\.lastAttachAt\) return;/);
    expect(record).toMatch(
      /recycledLeftBehind: tree && "leftBehind" in tree \? tree\.leftBehind : undefined,\s*recycledUnmeasured: tree && "unmeasured" in tree \? tree\.unmeasured : undefined,\s*\} satisfies ThreadBinding\);/,
    );
    expect(record).not.toMatch(/evicted: true|evictedWhy|evictedLeftBehind|evictedUnmeasured|user: ""/);
    const put = record.indexOf("recycledLeftBehind:");
    const log = record.search(
      /if \(tree\)\s*console\.log\(`disk-full: \$\{binding\.threadKey\} tree discarded with the disk — \$\{evictedTreeSentence\(tree\)\}`\);/,
    );
    expect(put).toBeGreaterThan(-1);
    expect(log).toBeGreaterThan(put);
    const binding = /interface ThreadBinding \{[\s\S]*?\n\}/.exec(source);
    expect(binding, "worker.ts declares ThreadBinding").not.toBeNull();
    expect(binding![0]).toMatch(/recycledLeftBehind\?: LeftBehind;/);
    expect(binding![0]).toMatch(/recycledUnmeasured\?: string;/);
    expect(method("getResidentInfo")).toMatch(
      /recycledLeftBehind: recycledLeftBehind \?\? null,\s*recycledUnmeasured: recycledUnmeasured \?\? null,/,
    );
  });
});

describe("a finished ref's tree is reclaimed whatever it holds", () => {
  const reclaim = method("reclaimFinishedRefs");

  it("the pure decision takes the fate, the default-branch rule and the op count — no clean input, no dirty keep", () => {
    const input = /export interface ReclaimInput \{[\s\S]*?\n\}/.exec(gc);
    expect(input, "gc.ts declares ReclaimInput").not.toBeNull();
    expect(input![0]).not.toMatch(/clean/);
    const why = /export type ReclaimWhy =[\s\S]*?;/.exec(gc);
    expect(why, "gc.ts declares ReclaimWhy").not.toBeNull();
    expect(why![0]).not.toMatch(/"dirty"/);
    expect(reclaim).toMatch(/const decision = reclaimDecision\(\{ fate, isDefaultRef, busy \}\);/);
    expect(reclaim).not.toMatch(/why: "dirty"/);
    expect(reclaim).not.toMatch(/worktreeCleanliness/);
  });

  it("what the tree holds is measured once after the decision and before the re-read guards, and rides into the eviction for the record; the busy guard stands", () => {
    const decision = reclaim.indexOf("const decision = reclaimDecision({ fate, isDefaultRef, busy });");
    const measure = reclaim.indexOf("const tree = active ? await this.measureTreeBeforeEviction(binding) : undefined;");
    const busyNow = reclaim.indexOf("const busyNow = this.threadOpsInFlight.get(binding.threadKey) ?? 0;");
    const reread = reclaim.indexOf(
      "const current = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(binding.threadKey));",
    );
    const evict = reclaim.indexOf("await this.evictBinding(current, activeNow, `reclaim ${resource}`, why, tree)");
    expect(decision).toBeGreaterThan(-1);
    expect(measure).toBeGreaterThan(decision);
    expect(busyNow).toBeGreaterThan(measure);
    expect(reread).toBeGreaterThan(busyNow);
    expect(evict).toBeGreaterThan(reread);
    expect(reclaim).toMatch(
      /if \(busyNow > 0\) \{\s*kept\.push\(\{ threadKey: binding\.threadKey, ref: binding\.ref, why: "busy" \}\);/,
    );
  });
});

describe("disk pressure evicts dirty trees in the normal order", () => {
  const admit = method("admitThreadDisk");

  it("no candidate is kept for its dirt: the keep tokens are the pure order's plus busy and other", () => {
    expect(admit).not.toMatch(/why: "dirty"/);
    expect(admit).not.toMatch(/if \(!clean\.clean\)/);
    expect(admit).not.toMatch(/worktreeCleanliness/);
    const budget = readSource("../../src/execution/residentDiskBudget.ts");
    expect(budget).toMatch(
      /^export type DiskKeepWhy = "busy" \| "default-ref" \| "recent" \| "requesting" \| "other";$/m,
    );
  });

  it("each candidate is measured in the pure order before the sweep's re-read guards, and the counts ride into the eviction; a busy candidate is still kept", () => {
    const measure = admit.indexOf("const tree = await this.measureTreeBeforeEviction(binding);");
    const reread = admit.indexOf(
      "const current = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(c.threadKey));",
    );
    const evict = admit.indexOf('await this.evictBinding(current, true, "disk-pressure", DISK_PRESSURE_REASON, tree)');
    expect(measure).toBeGreaterThan(-1);
    expect(reread).toBeGreaterThan(measure);
    expect(evict).toBeGreaterThan(reread);
    expect(admit).toMatch(
      /\(this\.threadOpsInFlight\.get\(c\.threadKey\) \?\? 0\) > 0\s*\) \{\s*kept\.push\(\{ threadKey: c\.threadKey, why: "busy" \}\);/,
    );
  });
});

describe("every eviction records what the tree held", () => {
  const evict = method("evictBinding");

  it("the measurement is one method over the one-spawn probe, read into the record and nowhere else", () => {
    expect(method("measureTreeBeforeEviction")).toMatch(
      /return evictedTreeOf\(await this\.worktreeCleanliness\(binding\)\);/,
    );
    expect(source).toMatch(
      /import \{[^}]*evictedTreeOf,\s*evictedTreeSentence,[^}]*type EvictedTree,[^}]*\} from "\.\.\/\.\.\/src\/execution\/residentCleanliness\.js";/,
    );
    // The probe itself is read by the measurement alone — never by a keep decision, not even the disk-full recycle's.
    const readers = [...residentDO.matchAll(/this\.worktreeCleanliness\(/g)];
    expect(readers).toHaveLength(1);
  });

  it("evictBinding takes the measurement and stamps the counts, or the probe's failure, beside evictedWhy — both absent for a clean tree", () => {
    expect(evict).toMatch(/tree\?: EvictedTree,\s*\): Promise<boolean> \{/);
    expect(evict).toMatch(
      /evictedWhy: why,\s*evictedLeftBehind: tree && "leftBehind" in tree \? tree\.leftBehind : undefined,\s*evictedUnmeasured: tree && "unmeasured" in tree \? tree\.unmeasured : undefined,\s*\} satisfies ThreadBinding\);/,
    );
    const binding = /interface ThreadBinding \{[\s\S]*?\n\}/.exec(source);
    expect(binding, "worker.ts declares ThreadBinding").not.toBeNull();
    expect(binding![0]).toMatch(/evictedWhy\?: string;/);
    expect(binding![0]).toMatch(/evictedLeftBehind\?: LeftBehind;/);
    expect(binding![0]).toMatch(/evictedUnmeasured\?: string;/);
  });

  it("one log line names what went — the counts, or that the tree could not be measured — after the record is written", () => {
    const put = evict.indexOf("evictedWhy: why,");
    const log = evict.indexOf(
      "if (tree) console.log(`${logCtx}: ${binding.threadKey} evicted (${why}) — ${evictedTreeSentence(tree)}`);",
    );
    expect(put).toBeGreaterThan(-1);
    expect(log).toBeGreaterThan(put);
  });

  it("the sweep measures too, with the runtime up — for the record only, never a keep", () => {
    const sweep = method("sweepWorktrees");
    const activeNow = sweep.indexOf("const activeNow = await this.isRuntimeActive().catch(() => false);");
    const measure = sweep.indexOf(
      "const tree = activeNow ? await this.measureTreeBeforeEviction(current) : undefined;",
    );
    expect(activeNow).toBeGreaterThan(-1);
    expect(measure).toBeGreaterThan(activeNow);
    expect(sweep).toMatch(/last >= cutoff \? "clean-idle" : "ttl",\s*tree,/);
    // The code reads `tree` exactly twice: its declaration and the eviction's argument — no keep decides on it.
    const code = sweep.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code.match(/\btree\b/g)).toHaveLength(2);
  });

  it("the detach's one measurement feeds its answer and the record alike", () => {
    const detach = method("detachThread");
    expect(detach).toMatch(/if \(!force && active\) tree = await this\.measureTreeBeforeEviction\(binding\);/);
    expect(detach).toMatch(/await this\.evictBinding\(current, activeNow, `detach`, "detach", tree\)/);
    expect(detach).toMatch(/const leftBehind = tree && "leftBehind" in tree \? tree\.leftBehind : undefined;/);
  });

  it("the live view carries both fields beside evictedWhy, so /residents, the dash and /debug threads can show what an eviction discarded", () => {
    expect(method("getResidentInfo")).toMatch(
      /evictedWhy: evictedWhy \?\? null,\s*evictedLeftBehind: evictedLeftBehind \?\? null,\s*evictedUnmeasured: evictedUnmeasured \?\? null,/,
    );
  });
});
