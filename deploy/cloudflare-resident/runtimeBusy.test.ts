import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

// A container that did not accept the connection is a wait on the
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

describe("the refused connect is named at the spawn alone", () => {
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

describe("the refresh cycle yields to the busy container", () => {
  // The cycle's own execs meet the same typed word from `run()`: a run's
  // command has the container's cores. Nothing ran and nothing about the
  // repository is known, so the cycle YIELDS — `stopped (runtime-busy)`, the
  // state it found put back, the lease released — and is never recorded as
  // `degraded`, never a rung of item 67's ladder (three such cycles used to
  // destroy the container under the very run that kept it busy).
  it("the instance step answers a busy verdict as stopped — after the classifier, before any failure is recorded", () => {
    const body = method("runInstanceStep");
    const verdict = body.indexOf("const failure = await this.classifyCycleError(err);");
    const yields = body.indexOf("if (failure.busy) {");
    const records = body.indexOf("await this.refreshFailed(failure,");
    expect(verdict).toBeGreaterThan(-1);
    expect(yields).toBeGreaterThan(verdict);
    expect(records).toBeGreaterThan(yields);
    const branch = body.slice(yields, records);
    expect(branch).toMatch(/await this\.yieldCycle\(instance\);/);
    expect(branch).toMatch(
      /return \{ status: "stopped", why: RUNTIME_BUSY_REASON, startedAt, trace: trace\.steps\(\) \};/,
    );
    expect(branch).not.toMatch(/refreshFailed|noteInfraStreak|recordRefreshError|setResidentState\("degraded"/);
  });

  it("the yield releases the cycle's lease and puts back the settled state the cycle found under its `refreshing`, never a `degraded` of its own", () => {
    const body = method("yieldCycle");
    expect(body).toMatch(/await this\.clearInstanceLease\(instance\);/);
    expect(body).toMatch(/if \(status\.state !== "refreshing"\) return;/);
    expect(body).toMatch(/this\.ctx\.storage\.get<RefreshingFrom>\(REFRESHING_FROM_KEY\)/);
    expect(body).toMatch(/await this\.setResidentState\(from\.state, from\.reason\);/);
    expect(body).not.toMatch(/setResidentState\("degraded"|INFRA_STREAK_KEY|DEGRADED_STREAK_KEY|refreshFailed/);
  });

  it("the fetch step remembers the state it is about to cover before writing `refreshing`, and its catch rethrows the busy word before naming GitHub", () => {
    const body = method("refreshFetch");
    const remembered = body.indexOf("await this.ctx.storage.put(REFRESHING_FROM_KEY,");
    const refreshing = body.indexOf('await this.setResidentState("refreshing");');
    expect(remembered).toBeGreaterThan(-1);
    expect(remembered).toBeLessThan(refreshing);
    const classified = body.indexOf('const failure = await this.classifyFailure("fetch", message);');
    const rethrown = body.indexOf("if (failure.busy) throw err;");
    const github = body.indexOf("const reason = `github-unreachable: ${message}`;");
    expect(classified).toBeGreaterThan(-1);
    expect(rethrown).toBeGreaterThan(classified);
    expect(github).toBeGreaterThan(rethrown);
  });

  it("the classifier's disk probe is skipped on a busy verdict — another exec against the same container would only meet the same refusal", () => {
    expect(method("classifyFailure")).toMatch(
      /if \(direct\.diskFull \|\| direct\.interrupted \|\| direct\.busy\) return direct;/,
    );
  });

  it("the Workflow skips the housekeeping steps on a busy cycle — they exec on the same container", () => {
    const refresh = readSource("refresh.ts");
    expect(refresh).toMatch(/if \(cycle\.outcome !== "offboarded" && cycle\.outcome !== RUNTIME_BUSY_REASON\) \{/);
  });
});
