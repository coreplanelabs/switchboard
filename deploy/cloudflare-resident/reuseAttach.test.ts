import { describe, expect, it } from "vitest";
import { threadRequestFixture } from "./testing/threadRequestFixture.js";
import { methodOf, readSource } from "./testing/sourceScan";

// A resumed run's attach reuses the thread's worktree as it stands
// (docs/reference/specs/resident-repos.md item 66): the `reuse` body field
// reaches `ensureThreadWorktree`, whose decision is the pure `decideWorktree`
// of src/execution/residentReuse.ts (the tested code IS the shipped code),
// so the one `rm -rf` (`worktree-clean`) runs only on a `recreate` decision,
// and a tree a reusing attach cannot keep is a named 409 `needs: "recreate"`
// refusal after the rollback, never a wipe. The answer names the container the
// tree is in (the kernel's boot id, memoized per incarnation), so the run's
// row can tell the container its pi runs in from another. Plain Node, the
// entry read as text, never loaded, like runtimeUnreachable.test.ts.

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));

function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

describe("the `reuse` body field reaches the worktree decision", () => {
  it("handleAttach parses `reuse` with the pure parser, refuses a malformed one 400, and hands the flag to attachThread", async () => {
    const h = threadRequestFixture();
    expect(await (await h.attach({ reuse: true })).json()).toEqual({ attached: true });
    expect(h.attached).toEqual([
      [
        "mcp:request",
        null,
        true,
        null,
        true,
        { defaultRef: "main" },
        "trace",
        { ownPr: null, refByDefault: false },
        undefined,
        undefined,
        "run-request",
        "gen-request",
        7,
        false,
        h.context,
      ],
    ]);
    const refused = await h.attach({ reuse: "yes" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "reuse must be a boolean when present" });
    expect(h.attached).toHaveLength(1);
  });

  it("attachThread carries `reuse` through the traced body to the create step", async () => {
    const h = threadRequestFixture();
    expect(await (await h.attach({ reuse: true })).json()).toEqual({ attached: true });
    expect(h.traced).toEqual([
      [
        "mcp:request",
        null,
        true,
        null,
        true,
        { defaultRef: "main" },
        1000,
        { ownPr: null, refByDefault: false },
        undefined,
        undefined,
        "run-request",
        "gen-request",
        7,
        false,
        h.context,
      ],
    ]);
    expect(method("attachThreadBody")).toMatch(/attachThreadCreate\(\{[\s\S]*?\breuse,[\s\S]*?\}\)/);
    expect(method("attachThreadCreate")).toMatch(/reuse: boolean;/);
  });
});

describe("ensureThreadWorktree keeps a reusing attach's tree and wipes only on a recreate decision", () => {
  const ensure = method("ensureThreadWorktree");

  it("takes the flag, measures the tree as WorktreeFacts and asks decideWorktree", () => {
    expect(source).toMatch(/import \{[^}]*decideWorktree[^}]*\} from "\.\.\/\.\.\/src\/execution\/residentReuse\.js";/);
    expect(ensure).toMatch(
      /opts: \{[\s\S]*?detached: boolean;[\s\S]*?reuse: boolean;[\s\S]*?refChanged: boolean;[\s\S]*?priorBinding\?: ThreadBinding;[\s\S]*?advanceOwner\?: WorkspaceOwner;?[\s\S]*?\}/,
    );
    expect(ensure).toMatch(/const facts: WorktreeFacts = \{ exists: false \};/);
    expect(ensure).toMatch(
      /decideWorktree\(\{[\s\S]*?reuse: opts\.reuse,[\s\S]*?modeSwitch,[\s\S]*?refChanged: opts\.refChanged,[\s\S]*?sha,[\s\S]*?worktreePath: wt,[\s\S]*?facts,[\s\S]*?\}\);/,
    );
  });

  it("the ancestry probe is a provisioning attach's alone: a reusing attach never judges the HEAD", () => {
    expect(ensure).toMatch(/if \(!opts\.reuse && !facts\.dirty && facts\.head !== sha\) \{/);
  });

  it("a refusal is thrown as ReuseRefusedError and a reuse returns before the wipe; the one rm -rf follows both", () => {
    const refuse = ensure.indexOf('if (decision.kind === "refuse") throw new ReuseRefusedError(decision.why);');
    const reuse = ensure.indexOf('if (decision.kind === "reuse") return false;');
    const wipe = ensure.indexOf('await this.runOk(["rm", "-rf", wt], "worktree-clean");');
    expect(refuse).toBeGreaterThan(-1);
    expect(reuse).toBeGreaterThan(refuse);
    expect(wipe).toBeGreaterThan(reuse);
    // One wipe in the whole method, and none before the decision.
    expect(ensure.match(/rm", "-rf"/g)).toHaveLength(1);
    expect(ensure.slice(0, refuse)).not.toMatch(/rm", "-rf"/);
  });

  it("the create step turns the refusal into a 409 needs recreate after the rollback, the resident's words prefixed reuse-refused", () => {
    const create = method("attachThreadCreate");
    const rollback = create.indexOf("await rollback();");
    const mapped = create.search(
      /if \(err instanceof ReuseRefusedError\)\s*return \{\s*error: `reuse-refused: \$\{err\.why\}`,\s*status: 409,\s*needs: "recreate",?\s*\};/,
    );
    expect(rollback).toBeGreaterThan(-1);
    expect(mapped).toBeGreaterThan(rollback);
    expect(source).toMatch(/^class ReuseRefusedError extends Error \{/m);
  });
});

describe("the attach answer names the container the tree is in", () => {
  it("AttachOk carries `container`, filled from the memoized boot id, and the memo dies with the incarnation", () => {
    expect(source).toMatch(/interface AttachOk \{[\s\S]*?container\?: string;[\s\S]*?\}/);
    const create = method("attachThreadCreate");
    expect(create).toMatch(/const container = await this\.containerIdentity\(\);/);
    expect(create).toMatch(/\.\.\.\(container !== undefined \? \{ container \} : \{\}\),/);
    const identity = method("containerIdentity");
    expect(identity).toMatch(/runOk\(\["cat", "\/proc\/sys\/kernel\/random\/boot_id"\], "boot-id"\)/);
    expect(identity).toMatch(/this\.containerIdMemo = word;/);
    expect(method("clearIncarnationMemos")).toMatch(/this\.containerIdMemo = undefined;/);
  });
});
