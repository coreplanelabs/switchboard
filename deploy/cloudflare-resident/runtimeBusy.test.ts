import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

// A loaded container that did not accept the connection is a wait on the
// resident too (docs/reference/specs/resident-repos.md item 68; the thread
// sandbox's execution.md item 28): the platform's accept refusal is named at
// the exec choke point's SPAWN alone — nothing ran — as the typed
// `SandboxRuntimeBusyError`, the thread data plane answers it as the 503 with
// the token, and a running command's output failure is never named so, since
// the process exists and the client's re-send would run it twice. Plain Node,
// the entry read as text, never loaded — like runtimeUnreachable.test.ts.

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));

/** One method of `ResidentDO`, asserting the entry declares it. */
function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

describe("the loaded container is named at the spawn alone", () => {
  it("run() throws the typed word from its spawn catch — after the reset and the replacement, before the unreachable count — and its collect catch never names it", () => {
    const run = method("run");
    const split = run.indexOf("await this.clearRuntimeUnreachable();");
    expect(split, "the spawn is the proof the control port answers").toBeGreaterThan(-1);
    const spawn = run.slice(0, split);
    const collect = run.slice(split);
    expect(spawn).toMatch(
      /if \(isRuntimeBusy\(err\)\) \{\s*throw new SandboxRuntimeBusyError\(\{ containerId: this\.ctx\.id\.toString\(\), cause: errMsg\(err\) \}\);/,
    );
    expect(spawn.indexOf("isControlReset(err)")).toBeLessThan(spawn.indexOf("isRuntimeBusy(err)"));
    expect(spawn.indexOf("!isRuntimeReplacement(err)")).toBeLessThan(spawn.indexOf("isRuntimeBusy(err)"));
    expect(spawn.indexOf("isRuntimeBusy(err)")).toBeLessThan(spawn.indexOf("isRuntimeUnreachable(err)"));
    expect(collect).not.toMatch(/RuntimeBusy/);
  });

  it("the recognizer is the platform's wording over the cause chain, and nothing counts it as unreachable", () => {
    expect(source).toMatch(
      /^function isRuntimeBusy\(err: unknown\): boolean \{\s*for \(const link of selfAndCauses\(err\)\) if \(isRuntimeBusySignal\(link\)\) return true;/m,
    );
    expect(method("noteRuntimeUnreachable")).not.toMatch(/RuntimeBusy/);
  });
});

describe("the thread data plane answers the word as the 503 with the token", () => {
  it("every thread method that runs a command answers the typed error with runtimeBusyErr, beside the reset and the replaced words", () => {
    for (const name of ["execThreadImpl", "readThreadFileImpl", "readThreadBytes", "writeThreadFileImpl"]) {
      const body = method(name);
      expect(body, name).toMatch(/if \(err instanceof SandboxRuntimeBusyError\) return runtimeBusyErr\(err\);/);
      expect(body.indexOf("instanceof RuntimeReplacedError"), name).toBeLessThan(
        body.indexOf("instanceof SandboxRuntimeBusyError"),
      );
    }
    // The body converts nothing before the gate sees it (execReplacedWord.test.ts's line, held for this word too).
    expect(method("execThreadBody")).not.toMatch(/RuntimeBusy/);
  });

  it("the rejection mapper the streamed /exec and the file routes share names the word after the stub boundary", () => {
    const threadErr = readSource("threadErr.ts");
    expect(threadErr).toMatch(/if \(isRuntimeBusyError\(err\)\) return runtimeBusyErr\(/);
    expect(threadErr).toMatch(
      /export function runtimeBusyErr\(err: Error\): ThreadErr \{\s*return \{ error: err\.message, status: 503, reason: RUNTIME_BUSY_REASON, cause: "system" \};/,
    );
  });
});
