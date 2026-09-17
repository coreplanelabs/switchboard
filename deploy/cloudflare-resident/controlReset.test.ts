import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";
import { ControlResetError, RuntimeReplacedError, controlResetErr, runtimeReplacedErr } from "./threadErr";

// Feature: docs/reference/specs/resident-repos.md item 43 (and harness-pi.md
// item 16): the resident's own Durable Object resetting under a live command (a
// Worker-code deploy) is NEVER the `runtime-replaced` word — the container and
// its processes are unchanged, so it answers its own `control-reset` word and
// the harness never orphans a live pi by relaunching it in the same container
//. Plain Node: the entry read as text, never loaded — like
// runtimeUnreachable.test.ts and lifecycle.test.ts — and the error classes and
// their builders loaded from ./threadErr.ts, which imports nothing workerd-only.

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));

/** One top-level `function name(...) { ... }` of the entry, to its closing brace at column 0. */
function functionOf(name: string): string {
  const start = source.search(new RegExp(`^function ${name}\\(`, "m"));
  expect(start, `worker.ts declares function ${name}`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 3);
}

describe("a DO code-update reset answers control-reset, distinct from runtime-replaced", () => {
  it("the two error classes carry two distinct words, neither one bleeding into the other", () => {
    const control = new ControlResetError("collect", new Error("reset because its code was updated")).message;
    expect(control).toMatch(/^control-reset:/);
    expect(control).toMatch(/the container and its processes are as they were/);
    expect(control).toMatch(/the command's outcome is unknown/);
    expect(control).not.toMatch(/runtime-replaced/);

    const replaced = new RuntimeReplacedError("collect", new Error("Process supervisor is closed"), true).message;
    expect(replaced).toMatch(/^runtime-replaced:/);
    expect(replaced).not.toMatch(/control-reset/);
  });

  it("the two ThreadErr builders answer two distinct reasons the client keys on", () => {
    const replaced = runtimeReplacedErr(
      new RuntimeReplacedError("spawn", new Error("Process supervisor is closed"), true),
    );
    expect(replaced).toMatchObject({ status: 409, reason: "runtime-replaced" });
    const controlReset = controlResetErr(
      new ControlResetError("spawn", new Error("reset because its code was updated")),
    );
    expect(controlReset).toMatchObject({ status: 409, reason: "control-reset" });
    expect(controlReset.reason).not.toBe("runtime-replaced");
  });

  it("isControlReset is the DO code-update reset predicate, kept apart from the runtime-replacement classifier", () => {
    expect(functionOf("isControlReset")).toMatch(/return isDurableObjectCodeUpdateReset\(err\);/);
  });

  it("the /exec gate's vouching set AND isRuntimeReplacement are both immune to the DO reset — a vouch or a replacement judgement on it would say the opposite of the control-reset word — while the restore path folds it in explicitly at its own site", () => {
    // `sdkVouchesRuntimeMoved` is read only by `replacedExecAnswer`, on a
    // RuntimeReplacedError's cause; a DO reset becomes a ControlResetError in
    // run() first, so a vouch for it here could only ever be dead or wrong.
    expect(functionOf("sdkVouchesRuntimeMoved")).not.toMatch(/isDurableObjectCodeUpdateReset/);
    // isRuntimeReplacement is immune too, so the /exec path never swaps the
    // incarnation on a DO reset regardless of the catch's ordering (finding 7).
    expect(functionOf("isRuntimeReplacement")).not.toMatch(/isDurableObjectCodeUpdateReset/);
    // The restore path is the ONE site that shares the replacement disposition
    // with a DO reset — named explicitly, since a reset under a live restore
    // leaves nothing to land and re-restores onto the container that comes back.
    expect(source).toMatch(/const runtimeReplaced = isRuntimeReplacement\(err\) \|\| isControlReset\(err\);/);
    // isControlReset is the DO reset's one and only home now.
    const homes = source.match(/isDurableObjectCodeUpdateReset\(err\)/g) ?? [];
    expect(homes, "the DO-reset predicate is read by isControlReset alone").toHaveLength(1);
  });

  it("run() routes a DO reset to control-reset BEFORE the runtime-replacement handling, in both phases — the reset path never says the word", () => {
    const run = methodOf(residentDO, "run");
    expect(run, "worker.ts declares ResidentDO.run").not.toBeNull();
    const body = run!;
    // Spawn phase: the control-reset throw comes before the `isRuntimeReplacement`
    // check AND before the unconditional `swapIncarnation()` — a DO reset over an
    // unchanged container must never clear its still-valid memos and leases.
    const spawnCatch = body.indexOf("proc = await createExtensionProcessSandbox(this).exec");
    const collect = body.indexOf("await proc.output(");
    const spawnControlReset = body.indexOf('throw new ControlResetError("spawn"', spawnCatch);
    const spawnRuntime = body.indexOf("isRuntimeReplacement(err)", spawnCatch);
    const spawnSwap = body.indexOf("this.swapIncarnation()", spawnCatch);
    expect(spawnControlReset, "spawn catch throws ControlResetError").toBeGreaterThan(-1);
    expect(spawnControlReset).toBeLessThan(spawnRuntime);
    expect(spawnSwap, "spawn catch swaps the incarnation").toBeGreaterThan(-1);
    expect(spawnSwap).toBeLessThan(collect); // the spawn catch's own swap, not a later one
    expect(spawnControlReset).toBeLessThan(spawnSwap);
    expect(spawnControlReset).toBeLessThan(collect);
    // Collect phase: the same, before the replacement branch's unconditional swap.
    const collectControlReset = body.indexOf('throw new ControlResetError("collect"', collect);
    const collectRuntime = body.indexOf("isRuntimeReplacement(err)", collect);
    const collectSwap = body.indexOf("this.swapIncarnation()", collect);
    expect(collectControlReset, "collect catch throws ControlResetError").toBeGreaterThan(-1);
    expect(collectControlReset).toBeLessThan(collectRuntime);
    expect(collectSwap, "collect catch swaps the incarnation").toBeGreaterThan(-1);
    expect(collectControlReset).toBeLessThan(collectSwap);
  });

  it("the replacement's two consequences are split after the reset check, in both phases: the memos clear unconditionally, the incarnation (the lease fencing token) is minted only when the replacement is known, and the reset path reaches neither — so a DO reset over a live pi clears nothing and mints nothing, and the re-send lands on the same pi", () => {
    const run = methodOf(residentDO, "run");
    expect(run, "worker.ts declares ResidentDO.run").not.toBeNull();
    const body = run!;
    const spawnCatch = body.indexOf("proc = await createExtensionProcessSandbox(this).exec");
    const collect = body.indexOf("await proc.output(");
    for (const [phase, from, to] of [
      ["spawn", spawnCatch, collect],
      ["collect", collect, body.length],
    ] as const) {
      const reset = body.indexOf(`throw new ControlResetError("${phase}"`, from);
      const clear = body.indexOf("this.clearIncarnationMemos();", from);
      const known = body.indexOf("const known = await this.replacementKnown(err);", from);
      const mint = body.indexOf("if (known) this.swapIncarnation();", from);
      const thrown = body.indexOf(`throw new RuntimeReplacedError("${phase}", err, known)`, from);
      for (const [what, at] of [
        ["the memo clear", clear],
        ["the decision", known],
        ["the gated mint", mint],
        ["the throw", thrown],
      ] as const) {
        expect(at, `${phase}: ${what} is in the catch`).toBeGreaterThan(-1);
        expect(at, `${phase}: ${what} is this phase's`).toBeLessThan(to);
        expect(reset, `${phase}: the control-reset throw precedes ${what}`).toBeLessThan(at);
      }
      expect(clear).toBeLessThan(known);
      expect(known).toBeLessThan(mint);
      expect(mint).toBeLessThan(thrown);
      // Nothing clears or mints between the reset check and its throw: the
      // reset path is a bare throw.
      const resetLine = body.slice(body.lastIndexOf("\n", reset) + 1, body.indexOf("\n", reset));
      expect(resetLine.trim()).toMatch(
        /^if \(isControlReset\(err\)\) throw new ControlResetError\("(spawn|collect)", err\);$/,
      );
      // The memo clear is unconditional (no `if` on its line) and the mint is
      // conditional on `known` alone.
      const clearLine = body.slice(body.lastIndexOf("\n", clear) + 1, body.indexOf("\n", clear));
      expect(clearLine.trim()).toBe("this.clearIncarnationMemos();");
    }
    // No unconditional swap is left in either catch.
    expect(body.match(/^\s*this\.swapIncarnation\(\);\s*$/m)).toBeNull();
  });

  it("the restore path's fold keeps minting: a DO reset under a restore is a new isolate, so its swapIncarnation() stays unconditional there", () => {
    const fold = residentDO.indexOf("const runtimeReplaced = isRuntimeReplacement(err) || isControlReset(err);");
    expect(fold, "the restore path folds the DO reset in").toBeGreaterThan(-1);
    const interrupted = residentDO.indexOf('if (disposition.action === "interrupted") {', fold);
    const swap = residentDO.indexOf("this.swapIncarnation();", interrupted);
    expect(interrupted).toBeGreaterThan(-1);
    expect(swap).toBeGreaterThan(interrupted);
    // The mint is inside the interrupted branch and not under any further condition.
    const between = residentDO.slice(interrupted, swap);
    expect(between).not.toMatch(/if \(known\)/);
    expect(residentDO.slice(residentDO.lastIndexOf("\n", swap) + 1, residentDO.indexOf("\n", swap)).trim()).toMatch(
      /^this\.swapIncarnation\(\);/,
    );
  });

  it("every thread route that names a runtime replacement names a control reset first, so a DO reset answers control-reset on exec, read and write", () => {
    const runtimeMappings = source.match(
      /if \(err instanceof RuntimeReplacedError\) return runtimeReplacedErr\(err\);/g,
    );
    expect(runtimeMappings, "the thread routes map RuntimeReplacedError").not.toBeNull();
    const paired = source.match(
      /if \(err instanceof ControlResetError\) return controlResetErr\(err\);\n\s*if \(err instanceof RuntimeReplacedError\) return runtimeReplacedErr\(err\);/g,
    );
    expect(paired?.length, "each runtime-replaced mapping is preceded by a control-reset mapping").toBe(
      runtimeMappings!.length,
    );
  });
});
