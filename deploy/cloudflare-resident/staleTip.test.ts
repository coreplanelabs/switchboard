import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

// Item 51 (docs/reference/specs/resident-repos.md): a run executes at the sha
// it asked for, or not on this resident. The attach reads the ref's tip once,
// hands it to the pure `attachTarget`, refuses `stale-tip` when the tip is not
// the named commit, and provisions the worktree at that same tip otherwise.
// Plain Node, the entry read as text, never loaded — like reuseAttach.test.ts.

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));

function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

describe("the attach refuses a stale tip instead of running it", () => {
  const body = () => method("attachThreadCreate");

  it("the tip is read once after the fetch and handed to attachTarget; the refused kinds are named before the worktree is provisioned", () => {
    const b = body();
    const tipRead = b.indexOf(
      "let tipSha = refExists ? await this.readMirrorSha(binding.ref).catch(() => null) : null;",
    );
    const target = b.indexOf("let target = attachTarget({");
    const staleThrow = b.indexOf('throw new StepError(\n            "stale-tip",');
    const provision = b.indexOf("await this.ensureThreadWorktree(binding, sha,");
    expect(tipRead).toBeGreaterThan(-1);
    expect(target).toBeGreaterThan(tipRead);
    expect(staleThrow).toBeGreaterThan(target);
    expect(provision).toBeGreaterThan(staleThrow);
    // The first target call carries the tip it judges on.
    expect(b.slice(target, b.indexOf("});", target))).toMatch(/tipSha,/);
  });

  it("the worktree is provisioned at the tip the target was judged on — never a second read that could see a different commit", () => {
    const b = body();
    expect(b).toMatch(/const sha = target\.kind === "sha" \? target\.sha : tipSha;/);
    // A tip the read could not answer is a named failure, never a null sha handed on.
    expect(b).toMatch(/if \(sha === null\) \{\s*throw new StepError\(\s*"rev-parse",/);
    expect(b).not.toMatch(/tipSha as string/);
    // No other tip read remains between the target and the provisioning.
    const between = b.slice(
      b.indexOf("let target = attachTarget({"),
      b.indexOf("await this.ensureThreadWorktree(binding, sha,"),
    );
    expect(between.match(/readMirrorSha\(/g) ?? []).toHaveLength(1); // the returnable-ref re-read of the default's tip
  });

  it("the route answers 409 with the resident's state and the reason `stale-tip`, beside the 400 an unknown ref gets", () => {
    const b = method("attachThreadCreate");
    const catchBlock = b.slice(b.indexOf('err.step === "unknown-ref"'));
    expect(catchBlock).toMatch(/err\.step === "stale-tip"/);
    expect(catchBlock).toMatch(
      /error: `stale-tip: \$\{err\.message\}`,\s*status: 409,\s*state: s\.state,\s*reason: "stale-tip",\s*cause: "system"/,
    );
  });
});
