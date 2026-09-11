import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The refresh instance counts its cycle in flight only past the entry gates
// (docs/reference/specs/resident-repos.md item 16c): `inFlightCount()` is what
// `isIdle`, `reconcileImage("refresh")` and the gate's disk-full recycle read,
// and a cycle that counted itself before its own gates would never park, never
// restart a stale image and never recycle a full disk — every gate would see
// one operation in flight: the probing cycle. The alarm path ordered this by
// hand (the gates, then the increment); the instance path runs the gates inside
// its fetch step, so the step callback is handed the count and calls it once
// `refreshGate` has answered go — the other steps first thing. Plain Node, the
// entry read as text, never loaded — like refresh.test.ts.

const source = readFileSync(fileURLToPath(new URL("./worker.ts", import.meta.url)), "utf8");

/** The text of one method of `ResidentDO`: from its declaration to the next
 *  member declared at the class's indentation (a doc comment, a method, a
 *  field), so a nested block's closing brace cannot end the window early. */
function method(name: string): string {
  const start = source.search(new RegExp(`^  (?:private |public )?(?:async )?${name}[<(]`, "m"));
  expect(start, `worker.ts declares ${name}`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(
    /^ {2}(?:\/\*\*|(?:private |public )?(?:async )?[A-Za-z_$][\w$]*(?:<[^>]*>)?\(|(?:private |public )?(?:readonly )?[A-Za-z_$][\w$]* *[=:])/m,
  );
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

describe("the refresh instance counts its cycle in flight only past the entry gates", () => {
  it("runInstanceStep hands the step its count instead of counting before the step runs — the one increment sits inside that closure", () => {
    const body = method("runInstanceStep");
    expect(body.match(/refreshesInFlight\+\+/g)?.length, "exactly one increment").toBe(1);
    expect(body).toMatch(/const count = \(\) => \{[\s\S]{0,160}?this\.refreshesInFlight\+\+;/);
    expect(body).toMatch(/if \(counted\) this\.refreshesInFlight--;/);
  });

  it("the fetch step counts only once refreshGate has answered go — the gates see the cycle as not in flight", () => {
    const body = method("refreshInstanceFetch");
    const gate = body.indexOf("await this.refreshGate(");
    const count = body.indexOf("cycle.count();");
    expect(gate, "the fetch step runs the gates").toBeGreaterThan(-1);
    expect(count, "the fetch step counts its cycle").toBeGreaterThan(-1);
    expect(count, "the count follows the gates").toBeGreaterThan(gate);
    expect(body.slice(gate, count)).toMatch(/if \(!gate\.go\) return/);
  });

  it.each(["refreshInstanceInstall", "refreshInstanceBuild", "refreshInstanceSnapshot"])(
    "%s counts its cycle first thing — no gate runs there",
    (name) => {
      const body = method(name);
      expect(body).toMatch(/async \(cycle\) => \{\n\s*cycle\.count\(\);/);
    },
  );
});
