import { describe, expect, it } from "vitest";
import { DRAIN_DEFAULT_MINUTES, DRAIN_MAX_MINUTES, drainRefusal, liveDrain, parseDrainRequest } from "./drain";
import { readSource } from "./testing/sourceScan";

// Feature: docs/reference/specs/resident-repos.md item 69 — the fleet drain: a
// record in the registry Durable Object with an end, read by `POST /attach`
// before any work, set and lifted by two admin routes, shown on `/residents`.
// Plain Node: the decision module is loaded; the Worker's wiring is read as text
// (testing/sourceScan.ts), as every scan in this directory does.

const NOW = Date.parse("2026-09-18T05:00:00.000Z");

describe("parseDrainRequest — the record a drain asks for", () => {
  it("defaults: an empty body drains for the default minutes as `admin` for `a deploy`, since now", () => {
    const r = parseDrainRequest({}, NOW);
    expect(r).toEqual({
      ok: true,
      record: {
        since: "2026-09-18T05:00:00.000Z",
        until: new Date(NOW + DRAIN_DEFAULT_MINUTES * 60_000).toISOString(),
        by: "admin",
        reason: "a deploy",
      },
    });
  });

  it("minutes, reason and by are taken as given, trimmed; `until` is since + minutes", () => {
    const r = parseDrainRequest({ minutes: 65, reason: "  deploy 62e4e9a ", by: "deploy all" }, NOW);
    expect(r).toEqual({
      ok: true,
      record: {
        since: "2026-09-18T05:00:00.000Z",
        until: "2026-09-18T06:05:00.000Z",
        by: "deploy all",
        reason: "deploy 62e4e9a",
      },
    });
  });

  it("refuses by name — never clamps — a non-integer, zero, or a drain past the cap, and an empty or overlong word", () => {
    expect(parseDrainRequest({ minutes: 1.5 }, NOW)).toEqual({
      ok: false,
      error: "minutes must be an integer number of minutes",
    });
    expect(parseDrainRequest({ minutes: "60" }, NOW)).toEqual({
      ok: false,
      error: "minutes must be an integer number of minutes",
    });
    expect(parseDrainRequest({ minutes: 0 }, NOW)).toEqual({
      ok: false,
      error: `minutes must be between 1 and ${DRAIN_MAX_MINUTES}`,
    });
    expect(parseDrainRequest({ minutes: DRAIN_MAX_MINUTES + 1 }, NOW)).toEqual({
      ok: false,
      error: `minutes must be between 1 and ${DRAIN_MAX_MINUTES}`,
    });
    expect(parseDrainRequest({ reason: "   " }, NOW)).toEqual({
      ok: false,
      error: "reason must be a non-empty string",
    });
    expect(parseDrainRequest({ by: "x".repeat(81) }, NOW)).toEqual({
      ok: false,
      error: "by must be at most 80 characters",
    });
    expect(parseDrainRequest({ minutes: DRAIN_MAX_MINUTES }, NOW).ok).toBe(true);
    // Length is judged after the trim: padding never refuses a value that fits.
    expect(parseDrainRequest({ by: `  ${"x".repeat(80)}  ` }, NOW).ok).toBe(true);
  });
});

describe("liveDrain — the drain in force, or none", () => {
  const record = parseDrainRequest({ minutes: 10, reason: "deploy abc1234", by: "deploy all" }, NOW);
  const stored = record.ok ? record.record : undefined;

  it("a stored record whose `until` is ahead is the drain; at and past `until` it is nothing — whoever forgot to lift it", () => {
    expect(liveDrain(stored, NOW)).toEqual(stored);
    expect(liveDrain(stored, NOW + 10 * 60_000 - 1)).toEqual(stored);
    expect(liveDrain(stored, NOW + 10 * 60_000)).toBeNull();
    expect(liveDrain(stored, NOW + 24 * 3_600_000)).toBeNull();
  });

  it("nothing stored, or a shape this build cannot read, is no drain — never a closed fleet", () => {
    expect(liveDrain(undefined, NOW)).toBeNull();
    expect(liveDrain(null, NOW)).toBeNull();
    expect(liveDrain("2026-09-18T06:00:00.000Z", NOW)).toBeNull();
    expect(liveDrain({ until: "2026-09-18T06:00:00.000Z" }, NOW)).toBeNull();
    expect(liveDrain({ ...stored, until: "not a time" }, NOW)).toBeNull();
  });
});

describe("drainRefusal — what /attach answers while drained", () => {
  it("is a 503 whose error opens with `draining:`, names the reason, who asked, when it ends, and says the run waits; the record rides beside it", () => {
    const record = parseDrainRequest({ minutes: 60, reason: "deploy 62e4e9a", by: "deploy all" }, NOW);
    if (!record.ok) throw new Error("fixture");
    const refusal = drainRefusal(record.record);
    expect(refusal.status).toBe(503);
    expect(refusal.draining).toEqual(record.record);
    expect(refusal.error).toBe(
      "draining: the resident fleet is closed to new runs for deploy 62e4e9a (asked by deploy all at 2026-09-18T05:00:00.000Z, " +
        "ends by 2026-09-18T06:00:00.000Z) — the run waits at its attach and starts when the fleet reopens",
    );
  });
});

describe("the Worker's wiring (by scan)", () => {
  const source = readSource("worker.ts");

  it("`/drain` and `/undrain` are POST routes of the drain scope, dispatched to their handlers; the drain bearer is a fourth scope that passes only its own routes, admin passes everything", () => {
    expect(source).toMatch(/"\/drain": \{ scope: "drain", method: "POST" \}/);
    expect(source).toMatch(/"\/undrain": \{ scope: "drain", method: "POST" \}/);
    expect(source).toMatch(/case "\/drain":\s*\n\s*return await handleDrain\(env, body\);/);
    expect(source).toMatch(/case "\/undrain":\s*\n\s*return await handleUndrain\(env\);/);
    expect(source).toMatch(/type Scope = "admin" \| "operator" \| "read" \| "drain";/);
    expect(source).toMatch(
      /env\.RESIDENT_DRAIN_TOKEN && timingSafeEqual\(token, env\.RESIDENT_DRAIN_TOKEN\)\) return "drain";/,
    );
    const hasScope = source.slice(source.indexOf("function hasScope("), source.indexOf("const READ_DEBUG_OPS"));
    expect(hasScope).toMatch(/if \(have === "admin"\) return true;\s*return have === scope;/);
  });

  it("the registry Durable Object stores the drain under its own key outside the `resident:` prefix and offers get, set and clear", () => {
    expect(source).toMatch(/const DRAIN_KEY = "drain";/);
    expect(source).toMatch(/async getDrain\(\): Promise<unknown>/);
    expect(source).toMatch(/async setDrain\(record: DrainRecord\): Promise<DrainRecord>/);
    expect(source).toMatch(/async clearDrain\(\): Promise<boolean>/);
  });

  it("the gate is the Durable Object's — after hydration, before the image reconcile — and refuses only a thread with NO run registration, so a run in flight re-attaches through; the Worker-level handler gates nothing; `/residents` carries `draining`", () => {
    const start = source.indexOf("private async attachThreadTraced(");
    const attach = source.slice(start, start + 4000);
    const hydrate = attach.indexOf("await this.ensureHydrated();");
    const gate = attach.indexOf("const drain = await this.fleetDrain();");
    const reconcile = attach.indexOf('this.reconcileImage("attach")');
    expect(hydrate).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(hydrate);
    expect(reconcile).toBeGreaterThan(gate);
    // One registration read serves the drain gate and the memory gate (item 70).
    expect(attach).toMatch(
      /const registered = \(await this\.ctx\.storage\.get\(runRegKey\(threadKey\)\)\) !== undefined;/,
    );
    expect(attach).toMatch(/if \(drain && !registered\) \{/);
    expect(attach).toMatch(/drainRefusal\(drain\)/);
    const handler = source.slice(
      source.indexOf("async function handleAttach("),
      source.indexOf("async function handleDetach("),
    );
    expect(handler).not.toContain("liveDrain(");
    // A registry that cannot be read is no drain: the run never fails on a flag it could not read.
    const helper = source.slice(source.indexOf("private async fleetDrain("), source.indexOf("async getInFlightCount("));
    expect(helper).toMatch(/return liveDrain\(await this\.registry\(\)\.getDrain\(\), systemClock\(\)\);/);
    expect(helper).toMatch(/catch \(err\) \{[\s\S]*return null;/);
    const residents = source.slice(
      source.indexOf("async function handleResidents("),
      source.indexOf("async function handleStatus("),
    );
    expect(residents).toMatch(/draining: liveDrain\(await registryStub\(env\)\.getDrain\(\), systemClock\(\)\)/);
  });

  it("the reconcile route is a drain-scope POST dispatched to its handler, which asks every resident's Durable Object to reconcile its container onto the current image — the deploy runner posts it after its Worker deploy landed and before its lift, so a stale container restarts inside the drain window, never under a run the reopened fleet admits", () => {
    expect(source).toMatch(/"\/reconcile": \{ scope: "drain", method: "POST" \}/);
    expect(source).toMatch(/case "\/reconcile":\s*\n\s*return await handleReconcile\(env\);/);
    const handler = source.slice(
      source.indexOf("async function handleReconcile("),
      source.indexOf("async function handleResidents("),
    );
    expect(handler).toMatch(/registryStub\(env\)\.list\(\)/);
    expect(handler).toMatch(/residentStub\(env, record\.resource\)\.reconcileForDeploy\(\)/);
    // A failing resident degrades to its own error row, never its neighbors'.
    expect(handler).toMatch(/Promise\.allSettled/);
    expect(handler).toMatch(/result: "error" as const, error: errMsg\(s\.reason\)/);
    // The DO method is the one image reconcile, under the deploy's own name.
    expect(source).toMatch(
      /async reconcileForDeploy\(\): Promise<\{ result: ImageReconcileResult \}> \{\s*\n\s*return \{ result: await this\.reconcileImage\("deploy"\) \};/,
    );
  });

  it("the image reconcile defers while a run registration is live on the resident — a harness run's process lives in the container between the bot's operator calls, so the op counters alone would restart the container under it — and answers a word, so the deploy's pass can say what each resident decided", () => {
    const reconcile = source.slice(
      source.indexOf("private async reconcileImage("),
      source.indexOf("async reconcileForDeploy("),
    );
    expect(reconcile).toMatch(/Promise<ImageReconcileResult>/);
    expect(reconcile).toMatch(/const registered = await this\.registeredRunsBeyondOps\(\);/);
    expect(reconcile).toMatch(/run registration\(s\) live — deferring restart until the resident is quiet/);
    expect(reconcile).toMatch(/return "deferred";[\s\S]*return "restarted";/);
    // The registration read sits between the op-counter check and the stop, so
    // a busy container is still named by its operations first.
    expect(reconcile.indexOf("this.inFlightCount()")).toBeLessThan(reconcile.indexOf("registeredRunsBeyondOps"));
    expect(reconcile.indexOf("registeredRunsBeyondOps")).toBeLessThan(reconcile.indexOf("this.swapIncarnation()"));
    // The call sites act only on a stop (`restarted`): a deferral never
    // answers `image-stale` to an attach and never restarts a refresh cycle.
    expect(source).toMatch(/\(await this\.reconcileImage\("refresh"\)\) === "restarted"/);
    expect(source).toMatch(/\(await this\.reconcileImage\("attach"\)\) === "restarted"/);
  });
});
