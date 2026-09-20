import { describe, expect, it } from "vitest";
import {
  DRAIN_DEFAULT_MINUTES,
  DRAIN_MAX_MINUTES,
  HOLD_CYCLE_BOUND_MINUTES,
  drainRefusal,
  holdDrain,
  liftDrain,
  liveDrain,
  parseDrainRequest,
  reportImageCurrent,
  staleHolds,
} from "./drain";
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

describe("the reopen gate — the fleet reopens on the last container's new-image report, never on the reconcile's return (issue 1931)", () => {
  const parsed = parseDrainRequest({ minutes: 60, reason: "deploy 62e4e9a", by: "deploy all" }, NOW);
  if (!parsed.ok) throw new Error("fixture");
  const record = parsed.record;

  it("holdDrain marks the residents whose containers still report the pre-deploy image, deduplicated; an empty set changes nothing", () => {
    expect(holdDrain(record, [], NOW)).toEqual(record);
    const held = holdDrain(record, ["repo:a/x", "repo:a/y"], NOW);
    expect(held.holds).toEqual(["repo:a/x", "repo:a/y"]);
    expect(holdDrain(held, ["repo:a/y", "repo:a/z"], NOW).holds).toEqual(["repo:a/x", "repo:a/y", "repo:a/z"]);
  });

  it("the first hold stamps the record's cycle bound (issue 2044): now + the measured bound, clamped to `until`, kept by later holds", () => {
    const held = holdDrain(record, ["repo:a/x"], NOW);
    expect(held.holdsUntil).toBe(new Date(NOW + HOLD_CYCLE_BOUND_MINUTES * 60_000).toISOString());
    // A later hold keeps the first stamp — the bound is the reconcile's ask, not the last holdout's.
    expect(holdDrain(held, ["repo:a/y"], NOW + 60_000).holdsUntil).toBe(held.holdsUntil);
    // A drain shorter than the bound clamps to its own end — `until` stays the last resort.
    const short = parseDrainRequest({ minutes: 1 }, NOW);
    if (!short.ok) throw new Error("fixture");
    expect(holdDrain(short.record, ["repo:a/x"], NOW).holdsUntil).toBe(short.record.until);
  });

  it("the lift does NOT reopen while a container still reports the old image: the record stands with liftAsked, and liveDrain keeps refusing attaches", () => {
    const held = holdDrain(record, ["repo:a/x"], NOW);
    const lift = liftDrain(held);
    expect(lift.cleared).toBe(false);
    if (lift.cleared) throw new Error("unreachable");
    expect(lift.record).toEqual({ ...held, liftAsked: true });
    // The gated record is still the drain in force — the fleet stays closed.
    expect(liveDrain(lift.record, NOW + 60_000)).toEqual({ ...held, liftAsked: true });
  });

  it("the lift with no holds clears as before", () => {
    expect(liftDrain(record)).toEqual({ cleared: true });
  });

  it("a report while another container is still old drops only that hold; the LAST container's new-image report lifts the asked drain", () => {
    const gated = liftDrain(holdDrain(record, ["repo:a/x", "repo:a/y"], NOW));
    if (gated.cleared) throw new Error("fixture");
    const first = reportImageCurrent(gated.record, "repo:a/x");
    expect(first.lifted).toBe(false);
    expect(first.record?.holds).toEqual(["repo:a/y"]);
    const last = reportImageCurrent(first.record!, "repo:a/y");
    expect(last).toEqual({ lifted: true, record: null });
  });

  it("the last report before any lift was asked keeps the drain standing without holds — the deploy's own lift still decides", () => {
    const held = holdDrain(record, ["repo:a/x"], NOW);
    const reported = reportImageCurrent(held, "repo:a/x");
    expect(reported.lifted).toBe(false);
    expect(reported.record).toEqual(record);
    expect(liftDrain(reported.record!)).toEqual({ cleared: true });
  });

  it("liveDrain carries holds and liftAsked through a stored record, and drops malformed holds", () => {
    const gated = { ...record, holds: ["repo:a/x", 7], liftAsked: true };
    expect(liveDrain(gated, NOW)).toEqual({ ...record, holds: ["repo:a/x"], liftAsked: true });
  });
});

describe("the hold's liveness — a cycle that never happens reopens the fleet with the container named, never a silence to the record's own until (issue 2044)", () => {
  const parsed = parseDrainRequest({ minutes: 65, reason: "deploy fd814ee", by: "deploy all" }, NOW);
  if (!parsed.ok) throw new Error("fixture");
  const record = parsed.record;
  const boundMs = HOLD_CYCLE_BOUND_MINUTES * 60_000;

  it("a held record whose cycle bound passed reads as NO drain — the fleet reopens by construction, liftAsked or not", () => {
    const held = holdDrain(record, ["repo:acme/api"], NOW);
    expect(liveDrain(held, NOW + boundMs - 1)).not.toBeNull();
    expect(liveDrain(held, NOW + boundMs)).toBeNull();
    const gated = liftDrain(held);
    if (gated.cleared) throw new Error("fixture");
    expect(liveDrain(gated.record, NOW + boundMs)).toBeNull();
  });

  it("staleHolds names the containers the reopen left stale — and nothing for a record that expired on `until`, has no holds, or whose bound is still ahead", () => {
    const held = holdDrain(record, ["repo:acme/api"], NOW);
    expect(staleHolds(held, NOW + boundMs)).toEqual(["repo:acme/api"]);
    expect(staleHolds(held, NOW + boundMs - 1)).toBeNull();
    expect(staleHolds(record, NOW + boundMs)).toBeNull();
    expect(staleHolds(held, Date.parse(record.until))).toBeNull();
  });

  it("a record from before the bound (holds, no holdsUntil) keeps `until` as its only end — the last resort", () => {
    const legacy = { ...record, holds: ["repo:a/x"], liftAsked: true };
    expect(liveDrain(legacy, NOW + boundMs)).not.toBeNull();
    expect(liveDrain(legacy, Date.parse(record.until))).toBeNull();
    expect(staleHolds(legacy, NOW + boundMs)).toBeNull();
  });

  it("replays the incident's deploy: drain, reconcile holds the one container that never reports, the lift is asked, the cycle bound elapses — the fleet is open and the container is named", () => {
    // 04:48Z: the deploy drains the fleet and the swap lands.
    const drained = record;
    // The reconcile cannot verify the switchboard container on the new image: held.
    const held = holdDrain(drained, ["repo:acme/api"], NOW);
    // The runner's `/undrain` meets the hold: the fleet stays closed…
    const gated = liftDrain(held);
    if (gated.cleared) throw new Error("the lift must hold");
    expect(liveDrain(gated.record, NOW + 60_000)).not.toBeNull();
    // …the container never cycles, so no report ever lands; the bound elapses…
    const at = NOW + boundMs;
    // …and the fleet is OPEN — not closed to the drain's 65-minute `until` —
    // with the stale container named for the warning.
    expect(liveDrain(gated.record, at)).toBeNull();
    expect(staleHolds(gated.record, at)).toEqual(["repo:acme/api"]);
    // A rebuild that DID report would have lifted it earlier: the report is the fact.
    expect(reportImageCurrent(gated.record, "repo:acme/api")).toEqual({ lifted: true, record: null });
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

  it("the hold's liveness is wired (issue 2044): holdDrainFor stamps the bound and arms the alarm at it, the alarm's reopen names the stale containers, a fresh provision reports its own container current, /op answers the drain, and the admin view carries the image report", () => {
    // The bound stamped and the alarm armed at it — the earlier end fires first.
    expect(source).toMatch(/holdDrain\(record, resources, now\)/);
    expect(source).toMatch(
      /if \(held\.holdsUntil !== undefined\) await this\.ctx\.storage\.setAlarm\(Date\.parse\(held\.holdsUntil\)\);/,
    );
    // The reopen past the bound is a warning naming who never cycled, never a silence.
    expect(source).toMatch(/const stale = staleHolds\(stored, now\);/);
    expect(source).toMatch(/fleet reopened with \$\{stale\.join\(", "\)\} still on the pre-deploy image/);
    // A rebuild or fresh provision counts as the report: provisioning reports right after warm.
    const provision = source.slice(
      source.indexOf("async runProvisioning("),
      source.indexOf("private async provisionTimedOut("),
    );
    expect(provision).toMatch(
      /await this\.ctx\.storage\.put\(IMAGE_REPORT_PENDING_KEY, \{ resource \}\);\s*\n\s*await this\.reportPendingImageCurrent\("provision"\);/,
    );
    // A typed op on a drained fleet answers with the drain instead of hanging.
    const op = source.slice(source.indexOf("private async runOpTraced("));
    expect(op).toMatch(/op-refused: the resident fleet is drained for \$\{drain\.reason\}/);
    // Readiness tells the truth: the admin view says whether the container's report is owed.
    expect(source).toMatch(/imageReport: map\.get\(IMAGE_REPORT_PENDING_KEY\) !== undefined \? "pending" : "current"/);
  });

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

  it("the registry Durable Object stores the drain under its own key outside the `resident:` prefix and offers get, set, a gated clear, the deploy's holds and the per-container new-image report (issue 1931)", () => {
    expect(source).toMatch(/const DRAIN_KEY = "drain";/);
    expect(source).toMatch(/async getDrain\(\): Promise<unknown>/);
    expect(source).toMatch(/async setDrain\(record: DrainRecord\): Promise<DrainRecord>/);
    expect(source).toMatch(/async clearDrain\(\): Promise<\{ cleared: boolean; held: string\[\] \}>/);
    expect(source).toMatch(/async holdDrainFor\(resources: string\[\]\): Promise<void>/);
    expect(source).toMatch(/async reportContainerImageCurrent\(resource: string\): Promise<\{ lifted: boolean \}>/);
    // The lift with holds outstanding keeps the record standing (liftAsked);
    // the last report deletes it and posts `below` — the fleet reopens on the
    // container's own fact, never on the reconcile call's return.
    const clear = source.slice(source.indexOf("async clearDrain("), source.indexOf("async holdDrainFor("));
    expect(clear).toMatch(/const lift = liftDrain\(record\);/);
    expect(clear).toMatch(/if \(!lift\.cleared\) \{\s*\n\s*await this\.ctx\.storage\.put\(DRAIN_KEY, lift\.record\);/);
    const report = source.slice(
      source.indexOf("async reportContainerImageCurrent("),
      source.indexOf("/** The one alarm"),
    );
    expect(report).toMatch(/reportImageCurrent\(record, resource\)/);
    expect(report).toMatch(
      /await this\.ctx\.storage\.delete\(DRAIN_KEY\);\s*\n\s*await this\.pushDrainPost\("below"\);/,
    );
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

  it("the reconcile route is a drain-scope POST dispatched to its handler, which asks every resident's Durable Object to cycle its container onto the current image and VERIFY the fresh start (issue 1931: 'reconciled' is not 'swapped') — an unverified resident holds the drain until its own report", () => {
    expect(source).toMatch(/"\/reconcile": \{ scope: "drain", method: "POST" \}/);
    expect(source).toMatch(/case "\/reconcile":\s*\n\s*return await handleReconcile\(env\);/);
    const handler = source.slice(
      source.indexOf("async function handleReconcile("),
      source.indexOf("async function handleResidents("),
    );
    expect(handler).toMatch(/registryStub\(env\)\.list\(\)/);
    expect(handler).toMatch(/residentStub\(env, record\.resource\)\.reconcileForDeploy\(record\.resource\)/);
    // A failing resident degrades to its own error row, never its neighbors'.
    expect(handler).toMatch(/Promise\.allSettled/);
    expect(handler).toMatch(/result: "error" as const, verified: false, error: errMsg\(s\.reason\)/);
    // Every unverified resident becomes a hold on the drain, so the reopen
    // waits for its report, never for the reconcile call's return.
    expect(handler).toMatch(
      /const unverified = reconciled\.filter\(\(r\) => !r\.verified\)\.map\(\(r\) => r\.resource\);/,
    );
    expect(handler).toMatch(/if \(unverified\.length > 0\) await registryStub\(env\)\.holdDrainFor\(unverified\);/);
    // The DO method never trusts the pool-user probe on the deploy path (the
    // pre-deploy image passes it when the pool did not change): the active
    // container is cycled (force) and the fresh start probed as the fact.
    expect(source).toMatch(
      /async reconcileForDeploy\(resource: string\): Promise<\{ result: ImageReconcileResult; verified: boolean \}>/,
    );
    const forDeploy = source.slice(source.indexOf("async reconcileForDeploy("), source.indexOf("// -- watchdog"));
    expect(forDeploy).toMatch(/this\.reconcileImage\("deploy", true\)/);
    expect(forDeploy).toMatch(/IMAGE_REPORT_PENDING_KEY, \{ resource \}/);
    // The hold lands at the registry BEFORE the marker that enables reports: a
    // report that outruns its hold is a no-op that consumes the marker and
    // leaves a hold nothing will report (the `until` backstop alone).
    expect(forDeploy).toMatch(/registryStub\(this\.env\)\.holdDrainFor\(\[resource\]\)/);
    expect(forDeploy.indexOf("holdDrainFor([resource])")).toBeLessThan(forDeploy.indexOf("IMAGE_REPORT_PENDING_KEY"));
    // The later report stands on the post-deploy cycle's fresh start, never on
    // the pool-user probe: the probe shortcut is gated on NO pending marker,
    // and the fresh probe's report fires only after the stop.
    const reconcile = source.slice(
      source.indexOf("private async reconcileImage("),
      source.indexOf("async reconcileForDeploy("),
    );
    expect(reconcile).toMatch(/if \(!force && pending === undefined\) \{/);
    expect(reconcile.indexOf("this.stop()")).toBeLessThan(
      reconcile.lastIndexOf("this.reportPendingImageCurrent(where)"),
    );
    // A held resident whose container went inactive has no other reporter left
    // (the drain refuses new attaches), so the inactive early-return reports a
    // pending marker before answering — else the fleet stays closed until the
    // drain's `until` backstop.
    const inactiveReturn = reconcile.slice(0, reconcile.indexOf('return "inactive"'));
    expect(inactiveReturn).toContain("this.reportPendingImageCurrent(where)");
    expect(source).toMatch(/private async reportPendingImageCurrent\(where: string\): Promise<boolean>/);
    expect(source).toMatch(/registryStub\(this\.env\)\.reportContainerImageCurrent\(pending\.resource\)/);
    // The marker is deleted only AFTER a successful report, so a transient
    // report failure keeps the retry-on-next-reconcile behavior.
    const report = source.slice(
      source.indexOf("private async reportPendingImageCurrent("),
      source.indexOf("async reconcileForDeploy("),
    );
    expect(report.indexOf("reportContainerImageCurrent(pending.resource)")).toBeLessThan(
      report.indexOf("storage.delete(IMAGE_REPORT_PENDING_KEY)"),
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
