import { describe, expect, it } from "vitest";
import ts from "typescript";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { recoveryEvidenceUrl, recoveryViewsAreIdle } from "./admissionRecovery";
import {
  DRAIN_DEFAULT_MINUTES,
  DRAIN_MAX_MINUTES,
  HOLD_CYCLE_BOUND_MINUTES,
  deployFenceReady,
  drainRefusal,
  holdDrain,
  liftDrain,
  liveDrain,
  parseDrainRequest,
  postUploadVersion,
  reportImageCurrent,
  staleHolds,
} from "./drain";
import { DRAIN } from "../../src/core/budgets";
import { methodOf, readSource } from "./testing/sourceScan";

describe("global deploy admission evidence", () => {
  function fixture() {
    const source = readSource("worker.ts");
    const registry = source.slice(
      source.indexOf("export class ResidentRegistryDO"),
      source.indexOf("export class ResidentDO"),
    );
    const ast = ts.createSourceFile("worker.ts", source, ts.ScriptTarget.Latest, true);
    const helpers = ast.statements
      .filter(
        (node) =>
          ts.isFunctionDeclaration(node) &&
          ["deployAdmissionOrigin", "emitDeployAdmission", "workerVersionId"].includes(node.name?.text ?? ""),
      )
      .map((node) => node.getText(ast));
    const methods = [
      "beginDeployAdmission",
      "beginDeployReconcileAdmission",
      "endDeployAdmission",
      "listDeployAdmissions",
      "getDeployAdmissionReadback",
      "recordDeployAdmissionResource",
      "verifyDeployFence",
    ]
      .map((name) => methodOf(registry, name) ?? "")
      .join("\n");
    const compiled = ts.transpileModule(
      helpers.join("\n") +
        `\nclass Registry { ${methods} } class Resident { ${methodOf(source.slice(source.indexOf("export class ResidentDO")), "withDeployAdmission")} }`,
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      },
    ).outputText;
    const rows = new Map<string, unknown>();
    const events: Array<Record<string, unknown>> = [];
    let now = 1000,
      failDelete = false,
      loseDeleteAck = false,
      failOrigin = false;
    const storage = {
      get: async (key: string) => rows.get(key),
      put: async (key: string, value: unknown) => {
        if (failOrigin) throw new Error("private-origin-error");
        rows.set(key, value);
      },
      delete: async (key: string) => {
        if (failDelete) throw new Error("private-delete-error");
        const deleted = rows.delete(key);
        if (loseDeleteAck) throw new Error("private-delete-ack-error");
        return deleted;
      },
      list: async ({ prefix }: { prefix: string }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
      transaction: async <T>(fn: (store: unknown) => Promise<T>): Promise<T> => fn(storage),
    };
    const { Registry, Resident } = runInNewContext(compiled + "\n({Registry, Resident})", {
      crypto: webcrypto,
      systemClock: () => now,
      liveDrain,
      postUploadVersion,
      deployFenceReady,
      DRAIN_KEY: "drain",
      DEPLOY_ADMISSION_KEY_PREFIX: "deploy:admission:",
      BUILD_ID: "a".repeat(40),
      RESOURCE_KEY: "resource",
      console: { log: (line: string) => events.push(JSON.parse(line.slice("[resident-deploy-admission] ".length))) },
    });
    const api = new Registry();
    api.ctx = { storage };
    return {
      api,
      resident: (failure: "read" | "rpc") => {
        const instance = new Resident();
        instance.env = {};
        instance.ctx = {
          storage: {
            get: async () => {
              if (failure === "read") throw new Error("private-read-error");
              return "repo:acme/api";
            },
          },
        };
        instance.registry = () => ({
          beginDeployAdmission: (origin: unknown) => api.beginDeployAdmission(origin),
          endDeployAdmission: (id: string) => api.endDeployAdmission(id),
          recordDeployAdmissionResource: async () => {
            throw new Error("private-rpc-error");
          },
        });
        return instance;
      },
      rows,
      events,
      advance: () => {
        now = 2000;
      },
      failDelete: () => {
        failDelete = true;
      },
      loseDeleteAck: () => {
        loseDeleteAck = true;
      },
      failOrigin: () => {
        failOrigin = true;
      },
    };
  }
  const origin = {
    kind: "watchdog",
    component: "scheduler",
    build: "a".repeat(40),
    workerVersion: "00000000-0000-4000-8000-000000000001",
    traceId: "b".repeat(32),
  };

  it.each(["read", "rpc"] as const)(
    "reports unavailable origin after %s failure while preserving the work result",
    async (failure) => {
      const h = fixture();
      const result = await h.resident(failure).withDeployAdmission(async () => "work-completed");
      const id = h.events[0].id;
      expect(result).toBe("work-completed");
      expect(h.events).toContainEqual({
        schema: 1,
        phase: "origin-unverified",
        id,
        observedAt: 1000,
        failure: "storage-or-rpc",
      });
      expect(h.events.at(-1)).toEqual({
        schema: 1,
        phase: "permit-release",
        id,
        observedAt: 1000,
        commit: "acknowledged",
        nativeOutcome: "unverified",
      });
    },
  );

  it("persists original internal work and joins a committed permit release by id", async () => {
    const h = fixture();
    const id = await h.api.beginDeployAdmission(origin);
    const stored = h.rows.get(`deploy:admission:${id}`);
    expect(stored).toEqual({
      schema: 1,
      startedAt: 1000,
      ...origin,
      resource: null,
      sourceId: null,
      requesterScope: null,
    });
    h.advance();
    await h.api.endDeployAdmission(id);
    expect(h.events).toEqual([
      { schema: 1, phase: "admitted", id, observedAt: 1000, ...(stored as object) },
      { schema: 1, phase: "permit-release", id, observedAt: 2000, commit: "acknowledged", nativeOutcome: "unverified" },
    ]);
    expect(await h.api.listDeployAdmissions()).toEqual([]);
  });

  it("keeps failed release debt and emits only a closed storage category", async () => {
    const h = fixture();
    const id = await h.api.beginDeployAdmission(origin);
    h.failDelete();
    await expect(h.api.endDeployAdmission(id)).rejects.toThrow("private-delete-error");
    expect(h.events[1]).toEqual({
      schema: 1,
      phase: "permit-release",
      id,
      observedAt: 1000,
      commit: "unverified",
      failure: "storage",
      nativeOutcome: "unverified",
    });
    expect(await h.api.listDeployAdmissions()).toEqual([{ id, startedAt: 1000, kind: "watchdog" }]);
  });

  it("keeps a lost release acknowledgement unverified even when storage removed the permit", async () => {
    const h = fixture();
    const id = await h.api.beginDeployAdmission(origin);
    h.loseDeleteAck();
    await expect(h.api.endDeployAdmission(id)).rejects.toThrow("private-delete-ack-error");
    expect(h.events.at(-1)).toEqual({
      schema: 1,
      phase: "permit-release",
      id,
      observedAt: 1000,
      commit: "unverified",
      failure: "storage",
      nativeOutcome: "unverified",
    });
    expect(await h.api.getDeployAdmissionReadback()).toEqual({
      schema: 1,
      observedAt: 1000,
      observedActiveCount: 0,
      omittedCount: 0,
      rows: [],
    });
  });

  it("returns bounded stored rows without discarding legacy, foreign or old permits", async () => {
    const h = fixture();
    const id = await h.api.beginDeployAdmission(origin);
    h.rows.set("deploy:admission:00000000-0000-4000-8000-000000000002", { startedAt: 1, secret: "private-token" });
    h.advance();
    const readback = await h.api.getDeployAdmissionReadback();
    expect(readback).toMatchObject({
      schema: 1,
      observedAt: 2000,
      observedActiveCount: 2,
      omittedCount: 0,
      rows: [
        { id, kind: "watchdog", startedAt: 1000 },
        { id: "00000000-0000-4000-8000-000000000002", startedAt: 1, kind: "unknown" },
      ],
    });
    expect(JSON.stringify(readback)).not.toContain("private-token");
    expect(await h.api.listDeployAdmissions()).toHaveLength(2);
    for (let i = 0; i < 30; i++) h.rows.set(`deploy:admission:extra-${i}`, { startedAt: 2 });
    expect(await h.api.getDeployAdmissionReadback()).toMatchObject({ observedActiveCount: 32, omittedCount: 7 });
  });

  it("admits only post-upload reconcile and retains unrelated permits", async () => {
    const h = fixture();
    const id = await h.api.beginDeployAdmission(origin);
    h.rows.set("drain", {
      since: "1970-01-01T00:00:00.000Z",
      until: "1970-01-01T01:00:00.000Z",
      by: "deploy",
      reason: "release",
      swapFence: true,
      swapVersion: origin.workerVersion,
      swapAt: "1970-01-01T00:00:00.500Z",
    });
    expect(await h.api.beginDeployReconcileAdmission(origin.workerVersion, "1970-01-01T00:00:02.000Z")).toBeNull();
    const successor = "00000000-0000-4000-8000-000000000002";
    const reconcileId = await h.api.beginDeployReconcileAdmission(successor, "1970-01-01T00:00:02.000Z");
    expect(await h.api.listDeployAdmissions()).toEqual([
      { id, startedAt: 1000, kind: "watchdog" },
      { id: reconcileId, startedAt: 1000, kind: "reconcile" },
    ]);
    expect(h.rows.get(`deploy:admission:${reconcileId}`)).toMatchObject({
      schema: 1,
      component: "http",
      kind: "reconcile",
      workerVersion: successor,
    });
  });

  it("does not resurrect a released permit or erase debt after failed annotation", async () => {
    const h = fixture();
    const id = await h.api.beginDeployAdmission(origin);
    h.failOrigin();
    await h.api.recordDeployAdmissionResource(id, "repo:acme/api");
    expect(h.rows.get(`deploy:admission:${id}`)).toMatchObject({ startedAt: 1000, resource: null, kind: "watchdog" });
    expect(h.events.at(-1)).toEqual({
      schema: 1,
      phase: "origin-unverified",
      id,
      observedAt: 1000,
      failure: "storage",
    });
    await h.api.endDeployAdmission(id);
    await h.api.recordDeployAdmissionResource(id, "repo:acme/api");
    expect(await h.api.listDeployAdmissions()).toEqual([]);
    expect(h.events.at(-1)).toMatchObject({ id, commit: "acknowledged" });
  });

  it("records a safe resource without overwriting the permit identity or admitting work behind a fence", async () => {
    const h = fixture();
    const id = await h.api.beginDeployAdmission(origin);
    await h.api.recordDeployAdmissionResource(id, "repo:acme/api");
    expect(h.rows.get(`deploy:admission:${id}`)).toMatchObject({
      startedAt: 1000,
      kind: "watchdog",
      resource: "repo:acme/api",
    });
    await h.api.recordDeployAdmissionResource(id, "/workspace/private");
    expect(h.rows.get(`deploy:admission:${id}`)).toMatchObject({ resource: "repo:acme/api" });
    h.rows.set("drain", {
      since: "1970-01-01T00:00:00.000Z",
      until: "2099-01-01T00:00:00.000Z",
      by: "deploy",
      reason: "release",
      swapFence: true,
    });
    expect(await h.api.beginDeployAdmission(origin)).toBeNull();
    expect(await h.api.listDeployAdmissions()).toEqual([{ id, startedAt: 1000, kind: "watchdog" }]);
  });
});

describe("targeted deploy admission recovery", () => {
  const idle = { state: "warm", executingRuns: 0, unknownRuns: 0, activeProcesses: 0 };

  it("requires settled residents with no executing or unknown runs and no container processes", () => {
    expect(recoveryViewsAreIdle([idle, { ...idle, state: "degraded" }])).toBe(true);
    expect(recoveryViewsAreIdle([{ ...idle, state: "refreshing" }])).toBe(false);
    expect(recoveryViewsAreIdle([{ ...idle, state: "onboarding" }])).toBe(false);
    expect(recoveryViewsAreIdle([{ ...idle, executingRuns: 1 }])).toBe(false);
    expect(recoveryViewsAreIdle([{ ...idle, unknownRuns: 1 }])).toBe(false);
    expect(recoveryViewsAreIdle([{ ...idle, activeProcesses: 1 }])).toBe(false);
    expect(recoveryViewsAreIdle([{ ...idle, activeProcesses: null }])).toBe(false);
    expect(recoveryViewsAreIdle([{ error: "probe failed" }])).toBe(false);
  });

  it("requires a link to an external request-end receipt", () => {
    expect(recoveryEvidenceUrl("https://dash.cloudflare.com/audit/request-123")).toBe(
      "https://dash.cloudflare.com/audit/request-123",
    );
    expect(recoveryEvidenceUrl("operator says request ended")).toBeNull();
    expect(recoveryEvidenceUrl("http://example.com/receipt")).toBeNull();
    expect(recoveryEvidenceUrl("https://user:pass@example.com/receipt")).toBeNull();
  });
});

describe("deploy upload phase proof", () => {
  const fence = {
    since: "2026-10-02T17:00:00.000Z",
    until: "2026-10-02T18:00:00.000Z",
    by: "deploy",
    reason: "release",
    swapFence: true as const,
    swapVersion: "old-version",
    swapAt: "2026-10-02T17:05:00.000Z",
  };

  it("requires a distinct Worker version created after the upload fence", () => {
    expect(postUploadVersion(fence, "old-version", "2026-10-02T17:10:00.000Z")).toBe(false);
    expect(postUploadVersion(fence, "other-old-version", "2026-10-02T16:59:00.000Z")).toBe(false);
    expect(postUploadVersion(fence, "other-old-version", "2026-10-02T17:03:00.000Z")).toBe(false);
    expect(postUploadVersion(fence, "new-version", "2026-10-02T17:10:00.000Z")).toBe(true);
    expect(postUploadVersion(fence, "new-version", null)).toBe(false);
  });
});

// Feature: docs/reference/specs/resident-repos.md item 69 — the fleet drain: a
// record in the registry Durable Object with an end, read by `POST /attach`
// before any work, set and lifted by two admin routes, shown on `/residents`.
// Plain Node: the decision module is loaded; the Worker's wiring is read as text
// (testing/sourceScan.ts), as every scan in this directory does.

const NOW = Date.parse("2026-09-18T05:00:00.000Z");

describe("deploy fence lifetime", () => {
  it("refuses a drain that expires before upload and readiness can finish", () => {
    const parsed = parseDrainRequest({ minutes: DRAIN.maxMinutes }, NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fenced = { ...parsed.record, swapFence: true } as const;
    const latestStart = Date.parse(fenced.until) - DRAIN.deployFenceMinRemainingMinutes * 60_000;
    expect(deployFenceReady(fenced, latestStart)).toBe(true);
    expect(deployFenceReady(fenced, latestStart + 1)).toBe(false);
    expect(deployFenceReady({ ...fenced, liftAsked: true }, NOW)).toBe(false);
    expect(deployFenceReady({ ...fenced, holds: ["repo:x/y"] }, NOW)).toBe(false);
    expect(deployFenceReady({ ...parsed.record }, NOW)).toBe(false);
  });
});

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

  it("the two-idle two-restarted fleet reopens on its last report, before the backstop", () => {
    const resources = ["repo:a/idle-one", "repo:a/idle-two", "repo:a/restarted-one", "repo:a/restarted-two"];
    const held = holdDrain(record, resources, NOW);
    const gated = liftDrain(held);
    if (gated.cleared) throw new Error("fixture");

    const restartedOne = reportImageCurrent(gated.record, "repo:a/restarted-one");
    const idleOne = reportImageCurrent(restartedOne.record!, "repo:a/idle-one");
    const idleTwo = reportImageCurrent(idleOne.record!, "repo:a/idle-two");
    expect(idleTwo.record?.holds).toEqual(["repo:a/restarted-two"]);
    expect(liveDrain(idleTwo.record, NOW + 7 * 60_000)).not.toBeNull();

    const restartedTwo = reportImageCurrent(idleTwo.record!, "repo:a/restarted-two");
    expect(restartedTwo).toEqual({ lifted: true, record: null });
    expect(NOW + 7 * 60_000).toBeLessThan(Date.parse(held.holdsUntil!));
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

  it("repeated deploy reconcile preserves the image report and only retries a cycle that was not issued", () => {
    const method = source.slice(source.indexOf("async reconcileForDeploy("), source.indexOf("// -- watchdog"));
    expect(method).toContain("nextDeployImageReconcile");
    expect(method).toMatch(/action === "verified"[\s\S]*verified: true/);
    expect(method).toMatch(/action === "await-report"[\s\S]*reportPendingImageCurrent/);
    expect(method).toMatch(
      /replacementContainerStarted\([\s\S]*await this\.ensureHydrated\(\);[\s\S]*reportPendingImageCurrent/,
    );
    expect(method).toMatch(/action === "start"[\s\S]*holdDrainFor[\s\S]*IMAGE_REPORT_PENDING_KEY/);
    expect(method).toMatch(
      /const activeBeforeCycle = await this\.isRuntimeActive\(\)\.catch\(\(\) => null\);\s*const containerBeforeCycle = activeBeforeCycle === true \? await this\.containerIdentity\(\) : undefined;/,
    );
    expect(method).toMatch(/this\.reconcileImage\("deploy", true\)/);
  });

  it("the hold's liveness is wired (issue 2044): holdDrainFor stamps the bound and arms the alarm at it, the alarm's reopen names the stale containers, a fresh provision reports its own container current, /op answers the drain, and the admin view carries the image report", () => {
    // The bound stamped and the alarm armed at it — the earlier end fires first.
    expect(source).toMatch(/holdDrain\(record, resources, now\)/);
    expect(source).toMatch(
      /if \(held\?\.holdsUntil !== undefined\) await this\.ctx\.storage\.setAlarm\(Date\.parse\(held\.holdsUntil\)\);/,
    );
    // The reopen past the bound is a warning naming who never cycled, never a silence.
    expect(source).toMatch(/const stale = staleHolds\(stored, now\);/);
    expect(source).toMatch(/async alarm\(\): Promise<void> \{\s*const result = await this\.ctx\.storage\.transaction/);
    expect(source).toMatch(/fleet reopened with \$\{result\.stale\.join\(", "\)\} still on the pre-deploy image/);
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
    expect(source).toMatch(/async setDrain\(record: DrainRecord\): Promise<DrainRecord \| null>/);
    expect(source).toContain("async clearDrain(");
    expect(source).toContain("versionTimestamp: string | null,");
    expect(source).toMatch(/async holdDrainFor\(resources: string\[\]\): Promise<void>/);
    expect(source).toMatch(/async reportContainerImageCurrent\(resource: string\): Promise<\{ lifted: boolean \}>/);
    // The lift with holds outstanding keeps the record standing (liftAsked);
    // the last report deletes it and posts `below` — the fleet reopens on the
    // container's own fact, never on the reconcile call's return.
    const clear = source.slice(source.indexOf("async clearDrain("), source.indexOf("async holdDrainFor("));
    expect(clear).toMatch(/const lift = liftDrain\(record\);/);
    expect(clear).toMatch(/if \(!lift\.cleared\) \{\s*\n\s*await txn\.put\(DRAIN_KEY, lift\.record\);/);
    const report = source.slice(
      source.indexOf("async reportContainerImageCurrent("),
      source.indexOf("/** The one alarm"),
    );
    expect(report).toMatch(/reportImageCurrent\(record, resource\)/);
    expect(report).toMatch(/if \(report\.record === null\) return txn\.delete\(DRAIN_KEY\);/);
    expect(report).toMatch(/if \(lifted\) \{\s*await this\.pushDrainPost\("below"\);/);
  });

  it("the gate is the Durable Object's — after hydration, before the image reconcile — and only a live registration owned by this run permits reattach; the Worker-level handler gates nothing; `/residents` carries `draining`", () => {
    const attach = methodOf(source.slice(source.indexOf("export class ResidentDO")), "attachThreadTraced")!;
    const hydrate = attach.indexOf("await this.ensureHydrated();");
    const gate = attach.indexOf("const drain = await this.fleetDrain();");
    const reconcile = attach.indexOf('this.reconcileImage("attach")');
    expect(hydrate).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(hydrate);
    expect(reconcile).toBeGreaterThan(gate);
    // One owned, live registration decision serves the drain, memory, and image gates.
    expect(attach).toMatch(
      /const registration = await this\.ctx\.storage\.get<RunRegistration>\(runRegKey\(threadKey\)\);\s*const registered = registeredRunAllowsReattach\(\s*registration,\s*runId,\s*systemClock\(\),\s*RUN_REGISTRATION_GRACE_MS,\s*ownerGen,\s*ownerFence,\s*\);/,
    );
    expect(attach).toMatch(/if \(drain && \(drain\.swapFence \|\| !registered\)\) \{/);
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
    expect(handler).toMatch(/const residents = await registry\.list\(\)/);
    expect(handler).toMatch(/beginDeployReconcileAdmission\(workerVersionId\(env\), workerVersionTimestamp\(env\)\)/);
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
    // container is cycled (force), and only the replacement's completed
    // hydration to `warm` provides the report.
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
    expect(forDeploy.indexOf("holdDrainFor([resource])")).toBeLessThan(
      forDeploy.indexOf("storage.put(IMAGE_REPORT_PENDING_KEY"),
    );
    // The later report stands on either an inactive runtime (whose next start
    // is on the deployed image by construction), or an active replacement
    // completing its own hydration to `warm` — never on the stop or the
    // pool-user probe.
    const reconcile = source.slice(
      source.indexOf("private async reconcileImage("),
      source.indexOf("/** The report a held drain waits for"),
    );
    expect(reconcile).toMatch(/if \(!force && pending === undefined\) \{/);
    expect(reconcile).toContain("reportPendingImageCurrent");
    const hydrate = source.slice(source.indexOf("private async doHydrate()"), source.indexOf("// -- freshness"));
    expect(hydrate.match(/setResidentState\("warm"\)/g)).toHaveLength(2);
    expect(hydrate.match(/reportPendingImageCurrent\("hydrate"\)/g)).toHaveLength(2);
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
    // The call sites act on their own words: a refresh cycle restarts only on
    // a stop (`restarted`); an attach acts only on `stale` — a refusal, never
    // a stop (issue 2101). A deferral never answers `image-stale` to an attach
    // and never restarts a refresh cycle.
    expect(source).toMatch(/\(await this\.reconcileImage\("refresh"\)\) === "restarted"/);
    expect(source).toMatch(/\(await this\.reconcileImage\("attach"\)\) === "stale" && !registered/);
  });

  it("an idle DO marked pending after its reconcile still reports current on the next cycle", () => {
    const reconcile = source.slice(
      source.indexOf("private async reconcileImage("),
      source.indexOf("/** The report a held drain waits for"),
    );
    const inactive = reconcile.slice(
      reconcile.indexOf("const active = await this.isRuntimeActive()"),
      reconcile.indexOf("const last = THREAD_USERS"),
    );
    // The helper reads the marker at call time. A reconcile before the marker
    // is a no-op; the first cycle after the marker reports it.
    expect(inactive).toMatch(
      /if \(!active\) \{[\s\S]*await this\.reportPendingImageCurrent\(where\);\s*return "inactive";/,
    );
  });

  it("a failed activity probe preserves the pending marker and drain hold, and refuses a new attach", () => {
    const reconcile = source.slice(
      source.indexOf("private async reconcileImage("),
      source.indexOf("/** The report a held drain waits for"),
    );
    const activity = reconcile.slice(
      reconcile.indexOf("const active = await this.isRuntimeActive()"),
      reconcile.indexOf("const last = THREAD_USERS"),
    );
    expect(activity).toMatch(
      /\.catch\(\(err\) => \{[\s\S]*return null;[\s\S]*if \(active === null\) \{[\s\S]*where === "attach"[\s\S]*IMAGE_REPORT_PENDING_KEY[\s\S]*return "stale";[\s\S]*return "deferred";/,
    );
    expect(activity.indexOf("if (active === null) {")).toBeLessThan(activity.indexOf("if (!active)"));
    expect(activity.indexOf('where === "attach"')).toBeLessThan(activity.indexOf('return "stale";'));
    expect(activity.indexOf("IMAGE_REPORT_PENDING_KEY")).toBeLessThan(activity.indexOf('return "stale";'));
    expect(activity.indexOf('return "stale";')).toBeLessThan(activity.indexOf('return "deferred";'));
    expect(activity.indexOf("if (!active)")).toBeLessThan(activity.indexOf("reportPendingImageCurrent(where)"));
  });

  it("a report from a non-running container reaches the registry", () => {
    const reconcile = source.slice(
      source.indexOf("private async reconcileImage("),
      source.indexOf("/** The report a held drain waits for"),
    );
    const inactive = reconcile.slice(
      reconcile.indexOf("const active = await this.isRuntimeActive()"),
      reconcile.indexOf("const last = THREAD_USERS"),
    );
    expect(inactive).toContain("reportPendingImageCurrent(where)");
    const report = source.slice(
      source.indexOf("private async reportPendingImageCurrent("),
      source.indexOf("async reconcileForDeploy("),
    );
    expect(report).toContain("registryStub(this.env).reportContainerImageCurrent(pending.resource)");
  });

  it("an attach never stops an active container, and its replacement reports only after hydration (issue 2101)", () => {
    const reconcile = source.slice(
      source.indexOf("private async reconcileImage("),
      source.indexOf("/** The report a held drain waits for"),
    );
    // The attach branch answers before any stop: `stale` (refused — the run
    // takes the fallback sandbox) or `deferred` (a stale pool with no marker
    // keeps admitting onto a busy container); while the marker is pending
    // every new attach is refused, so the resident can go quiet for the
    // refresh cycle's restart.
    const attachBranch = reconcile.slice(reconcile.indexOf('if (where === "attach")'), reconcile.indexOf("const busy"));
    expect(attachBranch).toMatch(/return "stale";/);
    expect(attachBranch).not.toMatch(/this\.stop\(/);
    expect(attachBranch).not.toMatch(/swapIncarnation/);
    expect(attachBranch).toMatch(/if \(pending === undefined && \(this\.inFlightCount\(\) > 0/);
    // The one pool-user probe left runs only with NO pending marker (the
    // current-image shortcut), while `doHydrate` reports only after an active
    // replacement reaches `warm`, so the active path cannot race the restore.
    expect(reconcile.match(/this\.run\(capability\)/g)).toHaveLength(1);
    const hydrate = source.slice(source.indexOf("private async doHydrate()"), source.indexOf("// -- freshness"));
    expect(hydrate).toContain('reportPendingImageCurrent("hydrate")');
    // The attach route refuses a `stale` verdict only for a thread with no run
    // registration — a registered run's re-attach passes as it passes the
    // drain and the memory gate.
    expect(source).toMatch(/=== "stale" && !registered/);
  });
});
