import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

// A run's end gives its pool user back, whatever its tree holds
// (docs/reference/specs/resident-repos.md items 16a, 16b and 17): a run starts
// from a clean tree, so nothing uncommitted or unpushed outlives the run —
// what a run wants kept, it commits and pushes. `detachThread` therefore has
// one reason to keep a tree, an op still in flight in it, and one duty
// besides releasing: to name what the release discards (`leftBehind`, from the
// one measurement `evictedTreeOf` of src/execution/residentCleanliness.ts also
// writes onto the binding), so the loss is never silent. The clean-idle sweep
// releases on idleness alone for the same reason. Plain Node, the entry read
// as text, never loaded.

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));

function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

describe("detachThread releases the tree whatever it holds, and names what it discards", () => {
  const detach = method("detachThread");

  it("no path keeps a tree for its dirt: the one measurement feeds the answer and the record, never a `released: false`", () => {
    expect(detach).toMatch(/if \(!force && active\) tree = await this\.measureTreeBeforeEviction\(binding\);/);
    expect(detach).not.toMatch(/kept", user: binding\.user \};\s*\}\s*\}/);
    expect(detach).not.toMatch(/\$\{c\.reason\} — kept/);
    expect(detach).not.toMatch(/if \(!c\.clean\)/);
    expect(detach).not.toMatch(/worktreeCleanliness/);
    // A probe that failed names nothing in the answer; the eviction records it (dirtNeverKeeps.test.ts).
    expect(detach).toMatch(/const leftBehind = tree && "leftBehind" in tree \? tree\.leftBehind : undefined;/);
  });

  it("the answer carries `leftBehind` on a release that discarded something, and the type declares it", () => {
    expect(source).toMatch(/interface DetachAnswer \{[\s\S]*?leftBehind\?: LeftBehind;[\s\S]*?\n\}/);
    expect(detach).toMatch(/\): Promise<DetachAnswer \| ThreadErr> \{/);
    expect(detach).toMatch(
      /return \{ released: true, user, \.\.\.\(leftBehind !== undefined \? \{ leftBehind \} : \{\}\) \};/,
    );
  });

  it("the measurement is a non-force release's alone — a read-only tree holds nothing, a hard stop's tree is whatever the killed command left — and runs only with the runtime up", () => {
    expect(detach).toMatch(/let tree: EvictedTree \| undefined;\s*if \(!force && active\) tree = await/);
    const measure = detach.indexOf("tree = await this.measureTreeBeforeEviction(binding);");
    const kill = detach.indexOf("await this.killThreadUserProcesses(plan.user);");
    const drain = detach.indexOf("const left = await this.waitForThreadDrain(threadKey);");
    expect(kill).toBeGreaterThan(-1);
    expect(drain).toBeGreaterThan(kill);
    expect(measure).toBeGreaterThan(drain);
  });

  it("an op in flight still keeps (the pure planForceDetach), force still kills it first, and the re-checks before the eviction stand", () => {
    expect(detach).toMatch(/const plan = planForceDetach\(\{/);
    expect(detach).toMatch(
      /if \(plan\.action === "refuse"\) return \{ released: false, reason: plan\.reason, user: binding\.user \};/,
    );
    expect(detach).toMatch(/if \(plan\.action === "kill"\) \{/);
    expect(detach).toMatch(
      /if \(left > 0\) return \{ released: false, reason: busyAfterKillReason\(left\), user: binding\.user \};/,
    );
    // The measurement awaited: an op that started meanwhile, or a re-attach, keeps the tree — never rm under a live command or a fresh tree.
    const measure = detach.indexOf("tree = await this.measureTreeBeforeEviction(binding);");
    const busyNow = detach.indexOf("const busyNow = this.threadOpsInFlight.get(threadKey) ?? 0;");
    const reread = detach.indexOf(
      "const current = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));",
    );
    const evict = detach.indexOf('await this.evictBinding(current, activeNow, `detach`, "detach", tree)');
    expect(busyNow).toBeGreaterThan(measure);
    expect(reread).toBeGreaterThan(busyNow);
    expect(evict).toBeGreaterThan(reread);
    expect(detach).toMatch(/reason: `busy: \$\{busyNow\} operation\(s\) started during detach — kept`,/);
    expect(detach).toMatch(/reason: "re-attached during the detach — kept"/);
  });
});

describe("the clean-idle sweep releases on idleness alone", () => {
  const sweep = method("sweepWorktrees");

  it("a live binding idle past the hour with no op in flight is released whatever its tree holds; a busy or recently attached one is kept", () => {
    expect(sweep).toMatch(
      /const busy = this\.threadOpsInFlight\.get\(binding\.threadKey\) \?\? 0;\s*if \(last >= idleCutoff \|\| busy > 0\) \{\s*kept\+\+;\s*continue;\s*\}/,
    );
    // The tree is measured for the eviction's record (dirtNeverKeeps.test.ts), never for a keep.
    expect(sweep).not.toMatch(/worktreeCleanliness/);
    expect(sweep).not.toMatch(/cleanIdle/);
    expect(sweep).not.toMatch(/if \(tree/);
  });

  it("the re-read guards before the eviction stand: a re-attach since the listing keeps its fresh tree, and the runtime is re-read per binding", () => {
    expect(sweep).toMatch(
      /if \(!current \|\| current\.evicted \|\| current\.lastAttachAt !== binding\.lastAttachAt\) \{/,
    );
    expect(sweep).toMatch(/const activeNow = await this\.isRuntimeActive\(\)\.catch\(\(\) => false\);/);
    expect(sweep).toMatch(/last >= cutoff \? "clean-idle" : "ttl"/);
  });
});
