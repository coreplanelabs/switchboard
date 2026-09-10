import { describe, expect, it } from "vitest";
import {
  INSTANCE_ID_MAX_LENGTH,
  INSTANCE_ID_PATTERN,
  REFRESH_BUCKET_MS,
  REFRESH_STEP_RETRIES,
  STEP_TIMEOUT_MAX_MS,
  instanceSlug,
  isDuplicateInstanceError,
  lifecycleOf,
  parseLifecycle,
  refreshBucket,
  refreshInstanceId,
  retryWindowMs,
  shouldCreateRefreshInstance,
  stepTimeoutMs,
  type RefreshRow,
} from "./residentInstanceId.js";
import { STALE_MIDFLIGHT_MS } from "./residentIncarnation.js";

const NOW = 1_700_000_400_000 + 200_000; // 200 s past a 10-minute boundary (1_700_000_400_000 is one)
const CADENCE = { intervalS: 600, idleIntervalS: 6 * 60 * 60 };

const row = (over: Partial<RefreshRow> = {}): RefreshRow => ({
  lifecycle: "workflow",
  instanceRunning: false,
  state: "warm",
  updatedAt: NOW - 60_000,
  idleSince: null,
  lastInstanceAt: NOW - REFRESH_BUCKET_MS,
  ...over,
});

describe("lifecycleOf / parseLifecycle — the per-resident flag, alarm by default", () => {
  it("a missing or unknown stored value reads as `alarm`; the two words parse; anything else is refused", () => {
    expect(lifecycleOf(undefined)).toBe("alarm");
    expect(lifecycleOf("nonsense")).toBe("alarm");
    expect(lifecycleOf("workflow")).toBe("workflow");
    expect(parseLifecycle("alarm")).toBe("alarm");
    expect(parseLifecycle("workflow")).toBe("workflow");
    expect(parseLifecycle("Workflow")).toBeUndefined();
    expect(parseLifecycle(1)).toBeUndefined();
  });
});

describe("refreshInstanceId — deterministic per resident and 10-minute bucket, platform-legal", () => {
  it("is the same id for the same resident anywhere inside one bucket, and a new id at the boundary", () => {
    const start = refreshBucket(NOW) * REFRESH_BUCKET_MS;
    const a = refreshInstanceId("Acme", "Mono.Repo", start);
    expect(a).toBe(refreshInstanceId("Acme", "Mono.Repo", start + REFRESH_BUCKET_MS - 1));
    expect(a).toBe(refreshInstanceId("acme", "mono.repo", start + 1));
    expect(refreshInstanceId("Acme", "Mono.Repo", start + REFRESH_BUCKET_MS)).not.toBe(a);
    expect(a).toBe(`refresh_acme-mono-repo_${refreshBucket(start)}`);
  });
  it("lower-cases owner and name and maps every character outside [A-Za-z0-9_-] to `-`", () => {
    expect(instanceSlug("Some.Org", "a repo/with:odd~chars")).toBe("some-org-a-repo-with-odd-chars");
    expect(instanceSlug("under_score", "dash-ok")).toBe("under_score-dash-ok");
  });
  it("matches the platform's id pattern and stays within 100 characters for the longest plausible owner and name, falling back to a short hash of the slug", () => {
    const owner = "o".repeat(39); // the longest owner name the code host allows
    const name = "n".repeat(100); // the longest repository name
    const id = refreshInstanceId(owner, name, NOW);
    expect(id).toMatch(INSTANCE_ID_PATTERN);
    expect(id.length).toBeLessThanOrEqual(INSTANCE_ID_MAX_LENGTH);
    expect(id.startsWith("refresh_")).toBe(true);
    expect(id.endsWith(`_${refreshBucket(NOW)}`)).toBe(true);
    // Two long names that share a prefix still get distinct ids (the hash, not the truncation, decides).
    const other = refreshInstanceId(owner, `${"n".repeat(99)}x`, NOW);
    expect(other).not.toBe(id);
    expect(other.length).toBeLessThanOrEqual(INSTANCE_ID_MAX_LENGTH);
    // A short slug is used verbatim: no hash.
    expect(refreshInstanceId("a", "b", NOW)).toBe(`refresh_a-b_${refreshBucket(NOW)}`);
  });
  it("recognizes the platform's duplicate-id refusal by its wording and nothing else", () => {
    expect(isDuplicateInstanceError("instance with id refresh_a-b_1 already exists")).toBe(true);
    expect(isDuplicateInstanceError("Duplicate instance ID")).toBe(true);
    expect(isDuplicateInstanceError("network error")).toBe(false);
    expect(isDuplicateInstanceError("")).toBe(false);
  });
});

describe("shouldCreateRefreshInstance — the cron's decision per resident", () => {
  it("creates only for a `workflow` row; an `alarm` row (the default) is never given an instance", () => {
    expect(shouldCreateRefreshInstance(row(), NOW, CADENCE)).toEqual({ create: true, why: "due" });
    expect(shouldCreateRefreshInstance(row({ lifecycle: "alarm" }), NOW, CADENCE)).toEqual({
      create: false,
      why: "alarm-lifecycle",
    });
  });
  it("never creates for a resident that is onboarding or down (provisioning owns the first, a rebuild is the second's escape hatch)", () => {
    expect(shouldCreateRefreshInstance(row({ state: "onboarding" }), NOW, CADENCE)).toEqual({
      create: false,
      why: "not-serving",
    });
    expect(shouldCreateRefreshInstance(row({ state: "down" }), NOW, CADENCE)).toEqual({
      create: false,
      why: "not-serving",
    });
  });
  it("skips a row that is `refreshing` and younger than the stale bound (a live cycle), and creates once the marker is older (an orphan the cycle normalizes)", () => {
    const young = row({ state: "refreshing", updatedAt: NOW - STALE_MIDFLIGHT_MS + 1 });
    expect(shouldCreateRefreshInstance(young, NOW, CADENCE)).toEqual({ create: false, why: "mid-cycle" });
    const old = row({ state: "refreshing", updatedAt: NOW - STALE_MIDFLIGHT_MS - 1 });
    expect(shouldCreateRefreshInstance(old, NOW, CADENCE)).toEqual({ create: true, why: "due" });
    // A `refreshing` marker with no timestamp at all cannot be judged live: treated as stale.
    expect(shouldCreateRefreshInstance(row({ state: "refreshing", updatedAt: null }), NOW, CADENCE)).toEqual({
      create: true,
      why: "due",
    });
  });
  it("never creates while the engine still runs the last instance, whatever the marker's age: a step between retry attempts is a live cycle", () => {
    const stale = row({ state: "refreshing", updatedAt: NOW - STALE_MIDFLIGHT_MS - 1, instanceRunning: true });
    expect(shouldCreateRefreshInstance(stale, NOW, CADENCE)).toEqual({ create: false, why: "running" });
    expect(shouldCreateRefreshInstance(row({ instanceRunning: true }), NOW, CADENCE)).toEqual({
      create: false,
      why: "running",
    });
  });
  it("an idle resident gets an instance only at the idle cadence the row records, counted in whole buckets since the last instance", () => {
    const idle = row({ idleSince: NOW - 2 * 60 * 60_000 });
    const idleBuckets = Math.ceil((CADENCE.idleIntervalS * 1000) / REFRESH_BUCKET_MS);
    expect(shouldCreateRefreshInstance({ ...idle, lastInstanceAt: NOW - REFRESH_BUCKET_MS }, NOW, CADENCE)).toEqual({
      create: false,
      why: "not-due",
    });
    expect(
      shouldCreateRefreshInstance(
        { ...idle, lastInstanceAt: NOW - (idleBuckets - 1) * REFRESH_BUCKET_MS },
        NOW,
        CADENCE,
      ),
    ).toEqual({ create: false, why: "not-due" });
    expect(
      shouldCreateRefreshInstance({ ...idle, lastInstanceAt: NOW - idleBuckets * REFRESH_BUCKET_MS }, NOW, CADENCE),
    ).toEqual({ create: true, why: "due" });
    // No instance yet: the first one is due now, idle or not.
    expect(shouldCreateRefreshInstance({ ...idle, lastInstanceAt: null }, NOW, CADENCE)).toEqual({
      create: true,
      why: "due",
    });
  });
  it("an awake resident is due every bucket: a second firing inside the same bucket is not (the id would be a duplicate anyway)", () => {
    expect(shouldCreateRefreshInstance(row({ lastInstanceAt: NOW - 1 }), NOW, CADENCE)).toEqual({
      create: false,
      why: "not-due",
    });
  });
});

describe("the step retry policy and budgets", () => {
  it("six attempts thirty seconds apart doubling sum to about 15.5 minutes of delay — past the 3 to 10 minutes a resident rollover takes to settle", () => {
    expect(REFRESH_STEP_RETRIES).toEqual({ limit: 6, delay: "30 seconds", backoff: "exponential" });
    const window = retryWindowMs(REFRESH_STEP_RETRIES);
    expect(window).toBe((30 + 60 + 120 + 240 + 480) * 1000);
    expect(window).toBeGreaterThan(10 * 60_000);
  });
  it("a step's timeout is the method's own budget, capped at the platform's 30 minutes, never zero", () => {
    expect(STEP_TIMEOUT_MAX_MS).toBe(30 * 60_000);
    expect(stepTimeoutMs(10 * 60_000)).toBe(10 * 60_000);
    expect(stepTimeoutMs(31 * 60_000)).toBe(STEP_TIMEOUT_MAX_MS);
    expect(() => stepTimeoutMs(0)).toThrow(/budget/);
  });
});
