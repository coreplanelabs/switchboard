import { describe, expect, it, vi } from "vitest";
import {
  DRAINED_GAVE_UP_SUFFIX,
  drainBeganLine,
  drainBody,
  drainLiftedLine,
  drainSet,
  drainSkippedLine,
  drainUntil,
  reconcileLine,
  RESIDENT_DRAINED_WAIT_MAX_MS,
  RESIDENT_DRAIN_TOKEN_ENV,
  type PostAnswer,
} from "./residentDrain.js";
import { RESIDENT_WAIT_MAX_MS, type DeployStep } from "./plan.js";
import { deployStep, type SandboxGateDeps, type StepExec } from "./run.js";
import { TEST_MAINTENANCE } from "./testing/profile.js";
import { RESIDENT_READY_WAIT_MS } from "./residentReadiness.js";
import { closedReadEvidence } from "./pagingDiagnostic.js";

// Feature: docs/reference/specs/release-and-deploy.md item 31 — the resident
// step drains the fleet before upload and lifts only after it can prove no
// upload or reconcile the new image. An uncertain upload leaves the fleet
// closed through the drain backstop. Every I/O is injected.

const HEAD = "62e4e9ad464820900b07bed176e140af6682c598";
const UNTIL = "2026-09-18T06:10:00.000Z";
const drained: PostAnswer = {
  status: 200,
  body: { draining: { since: "…", until: UNTIL, by: "deploy all", reason: "deploy 62e4e9a" } },
};
const lifted: PostAnswer = { status: 200, body: { draining: null, cleared: true } };
const reconciled: PostAnswer = {
  status: 200,
  body: { reconciled: [{ resource: "repo:acme/api", result: "restarted", verified: true }] },
};
const REFUSED = [
  "[resident-preflight] preflight REFUSED: a Worker deploy swaps every ResidentDO isolate and kills in-flight runs and provisions —",
  "  - in flight: repo:acme/api (2 in flight)",
  "  wait for them to finish and retry",
].join("\n");
const DEPLOYED = "Uploaded switchboard-resident\nCurrent Version ID: 0c48b341-f216-4262-81c0-bc62ecb5669a";

const residentStep: DeployStep = {
  name: "resident",
  script: "switchboard-resident",
  residentContainerApp: "switchboard-resident-residentdo",
  residentImage: "registry.example.test/resident:new",
  dir: "deploy/cloudflare-resident",
  command: ["npm", "run", "deploy"],
  unsetEnv: [],
  setEnv: { RESIDENT_BASE_URL: "https://switchboard-resident.example.test" },
  requiredEnv: [],
  capabilities: [],
  retryOnPreflightRefusal: true,
  waitMaxMs: RESIDENT_WAIT_MAX_MS,
  drain: { url: "https://switchboard-resident.example.test", tokenEnv: RESIDENT_DRAIN_TOKEN_ENV },
  why: "per-repo DOs",
};
const app = { value: { version: 17, image: "registry.example.test/resident:stable" } };
const workerOnlyStep = { ...residentStep, residentImage: "registry.example.test/resident:stable" };
const currentRegistry = {
  ok: true,
  draining: null,
  count: 1,
  residents: [
    {
      resource: "repo:acme/api",
      live: {
        imageReport: "current",
        imageTarget: {
          application: "switchboard-resident-residentdo",
          version: 18,
          image: "registry.example.test/resident:new",
        },
      },
    },
  ],
};
const pendingRegistry = {
  ...currentRegistry,
  draining: { holds: ["repo:acme/api"] },
  residents: [{ resource: "repo:acme/api", live: { imageReport: "pending" } }],
};
const held: PostAnswer = { status: 200, body: { cleared: false, held: ["repo:acme/api"] } };
const pendingReconcile: PostAnswer = {
  status: 200,
  body: { reconciled: [{ resource: "repo:acme/api", result: "restarted", verified: false }] },
};
const plan = { waitMaxMs: 10 * 60_000, pollMs: 60_000 };

function harness(env: Record<string, string>, posts: PostAnswer[] = [drained, lifted]) {
  const calls: { dep: string; args: unknown[] }[] = [];
  const lines: string[] = [];
  let clock = 0;
  let uploaded = false;
  const deps: SandboxGateDeps = {
    env,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    readHealth: async (url) =>
      url.endsWith("/residents")
        ? { status: 200, body: currentRegistry }
        : { status: 200, body: { ok: true, build: { commit: HEAD } } },
    readAppState: async () =>
      uploaded ? { value: { version: 18, image: "registry.example.test/resident:new" } } : app,
    readInstances: async () => ({ error: "unscripted" }),
    probeExec: async () => ({ body: { stdout: "", stderr: "", exitCode: 1 } }),
    postJson: async (...args) => {
      calls.push({ dep: "postJson", args });
      const result = posts.shift() ?? { error: "unscripted POST" };
      return args[0].endsWith("/reconcile") && "body" in result && result.status === 200
        ? { ...result, body: { imageTarget: args[2].imageTarget, ...result.body } }
        : result;
    },
  };
  const io = { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(`WARN ${l}`), stream: () => {} };
  /** The runner's own lines, without the span log lines. */
  const plain = () => lines.filter((l) => !l.startsWith("{"));
  return {
    deps,
    io,
    calls,
    plain,
    markUploaded: () => {
      uploaded = true;
    },
  };
}

/** The step's command: `refusals` REFUSED exits, then the deploy. */
const exec =
  (h: ReturnType<typeof harness>, refusals: number): StepExec =>
  async () => {
    h.calls.push({ dep: "exec", args: [] });
    if (refusals-- > 0) return { code: 1, output: REFUSED };
    h.markUploaded();
    return { code: 0, output: DEPLOYED };
  };

async function expectBoundedNativeRead(
  h: ReturnType<typeof harness>,
  step: DeployStep,
  blockRead: () => boolean,
  cancel = false,
) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  h.deps.now = () => Date.now();
  const control = new AbortController();
  h.deps.signal = control.signal;
  const original = h.deps.readAppState;
  let readSignal: AbortSignal | undefined;
  let releaseRead: (() => void) | undefined;
  let enteredRead!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredRead = resolve;
  });
  h.deps.readAppState = async (...args) => {
    if (!blockRead()) return original(...args);
    readSignal = args[3];
    return new Promise((resolve) => {
      releaseRead = () => resolve({ error: "native read interrupted" });
      readSignal?.addEventListener("abort", releaseRead, { once: true });
      enteredRead();
    });
  };
  const pending = deployStep(step, plan, HEAD, h.io, h.deps, exec(h, 0));
  try {
    await entered;
    if (cancel) control.abort();
    else await vi.advanceTimersByTimeAsync(RESIDENT_READY_WAIT_MS);
    expect(readSignal?.aborted).toBe(true);
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(outcome.live).toMatch(/^deployed, not live:/);
  } finally {
    releaseRead?.();
    await pending;
    vi.useRealTimers();
  }
}

describe("Worker-only reopen after a definite refusal", () => {
  const refused: PostAnswer = {
    status: 409,
    body: { error: "deploy-fence: the pre-upload Worker cannot reopen the fleet" },
  };
  function setup(first: PostAnswer = refused, second: PostAnswer = lifted, change = "") {
    const window = {
      since: "1970-01-01T00:00:00.000Z",
      until: UNTIL,
      by: "deploy all",
      reason: `deploy ${HEAD.slice(0, 7)}`,
    };
    const fence = {
      ...window,
      swapFence: true,
      swapVersion: "11111111-1111-4111-8111-111111111111",
      swapAt: "1970-01-01T00:00:01.000Z",
      swapAcquisitionId: "22222222-2222-4222-8222-222222222222",
    };
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" });
    const control = new AbortController();
    h.deps.signal = control.signal;
    let undrains = 0;
    let open = false;
    const reads: string[] = [];
    h.deps.postJson = async (...args) => {
      h.calls.push({ dep: "postJson", args });
      if (args[0].endsWith("/drain")) return { status: 200, body: { draining: window } };
      if (!args[0].endsWith("/undrain")) return { error: "Unexpected control request" };
      undrains++;
      const response = undrains === 1 ? first : second;
      if (undrains === 1 && change === "cancel") control.abort();
      if (undrains === 1 && change === "deadline") await h.deps.sleep(RESIDENT_READY_WAIT_MS);
      if (
        change === "settled unknown" ||
        ("body" in response &&
          response.status === 200 &&
          response.body.error === undefined &&
          response.body.cleared === true)
      )
        open = true;
      return response;
    };
    h.deps.readAppState = async () =>
      (undrains > 0 && change === "application") || (undrains >= 2 && change === "application after retry")
        ? { value: { ...app.value, version: 18 } }
        : app;
    h.deps.readHealth = async (url) => {
      reads.push(url);
      if (undrains === 1 && change === "cancel read") control.abort();
      if (undrains === 1 && change === "deadline read") await h.deps.sleep(RESIDENT_READY_WAIT_MS);
      if (!url.endsWith("/residents"))
        return {
          status: 200,
          body: { ok: true, build: { commit: undrains && change === "source" ? "f".repeat(40) : HEAD } },
        };
      return {
        status: 200,
        body: {
          ...currentRegistry,
          count: undrains && change === "fleet" ? 2 : 1,
          draining: open
            ? null
            : {
                ...fence,
                ...(undrains && change === "window" ? { until: "2026-09-19T06:10:00.000Z" } : {}),
                ...(undrains && change === "acquisition"
                  ? { swapAcquisitionId: "33333333-3333-4333-8333-333333333333" }
                  : {}),
              },
          stagingMaintenance: undrains && change === "maintenance" ? { state: "held" } : null,
          pendingReplicas: 0,
          residents: [
            {
              resource: "repo:acme/api",
              live: {
                imageReport: undrains && change === "image" ? "pending" : "current",
                imageTarget:
                  undrains && change === "image target"
                    ? {
                        application: residentStep.residentContainerApp,
                        version: 99,
                        image: "registry.example.test/foreign",
                      }
                    : null,
              },
            },
            ...(undrains && change === "fleet"
              ? [{ resource: "repo:acme/extra", live: { imageReport: "current", imageTarget: null } }]
              : []),
          ],
        },
      };
    };
    return { ...h, reads, undrains: () => undrains };
  }

  it("reopens once after fresh unchanged-target proof and completes only after registry readback", async () => {
    const h = setup();
    expect(await deployStep(workerOnlyStep, plan, HEAD, h.io, h.deps, exec(h, 0))).toMatchObject({
      ok: true,
      live: "live",
    });
    expect(h.calls.filter((call) => call.dep === "exec")).toHaveLength(1);
    expect(h.calls.filter((call) => call.dep === "postJson").map((call) => call.args)).toEqual([
      ["https://switchboard-resident.example.test/drain", "drn", expect.any(Object)],
      ["https://switchboard-resident.example.test/undrain", "drn", {}],
      ["https://switchboard-resident.example.test/undrain", "drn", {}],
    ]);
    expect(h.reads.at(-1)).toBe("https://switchboard-resident.example.test/residents");
    expect(h.deps.now()).toBeLessThan(RESIDENT_READY_WAIT_MS);
    const diagnostics = h
      .plain()
      .filter((line) => line.startsWith("[resident-reopen-diagnostic] "))
      .map((line) => JSON.parse(line.slice("[resident-reopen-diagnostic] ".length)));
    expect(diagnostics).toEqual([
      {
        schema: 1,
        phase: "initial",
        outcome: "post-upload-unproven",
        httpStatus: 409,
        uploadedVersion: { state: "reported", id: "0c48b341-f216-4262-81c0-bc62ecb5669a" },
        receiverVersion: { state: "unreported" },
        nativeOutcome: "unverified",
      },
      {
        schema: 1,
        phase: "retry",
        outcome: "open",
        httpStatus: 200,
        uploadedVersion: { state: "reported", id: "0c48b341-f216-4262-81c0-bc62ecb5669a" },
        receiverVersion: { state: "unreported" },
        nativeOutcome: "unverified",
      },
    ]);
  });

  it.each([
    ["lost", { error: "private transport error" }],
    ["malformed", { status: 200, body: {} }],
    [
      "contradictory acknowledgement",
      { status: 200, body: { error: "private failure", cleared: true, draining: null } },
    ],
    ["server failure", { status: 503, body: { error: "private server detail" } }],
    [
      "contradictory conflict",
      { status: 409, body: { error: "deploy-fence: the pre-upload Worker cannot reopen the fleet", cleared: true } },
    ],
    ["policy", { status: 403, body: { error: "private policy detail" } }],
    ["maintenance", { status: 409, body: { error: "staging maintenance requires explicit release" } }],
    ["obligation", { status: 409, body: { error: "deploy-fence: admitted work has not settled" } }],
  ] satisfies Array<[string, PostAnswer]>)("does not repeat a %s reopen", async (_name, first) => {
    const h = setup(first);
    expect(await deployStep(workerOnlyStep, plan, HEAD, h.io, h.deps, exec(h, 0))).toMatchObject({ ok: false });
    expect(h.undrains()).toBe(1);
    expect(h.calls.filter((call) => call.dep === "exec")).toHaveLength(1);
    expect(h.calls.some((call) => String(call.args[0]).endsWith("/reconcile"))).toBe(false);
    expect(h.plain().join("\n")).not.toContain("reopens it now");
  });

  it("settles a lost reopen by reads alone when the registry proves it opened", async () => {
    const h = setup({ error: "private transport detail" }, lifted, "settled unknown");
    expect(await deployStep(workerOnlyStep, plan, HEAD, h.io, h.deps, exec(h, 0))).toMatchObject({
      ok: true,
      live: "live",
    });
    expect(h.undrains()).toBe(1);
    expect(h.plain().join("\n")).not.toContain("private transport detail");
  });

  it("stops after the one retry is refused instead of waiting for the drain backstop", async () => {
    const h = setup(refused, refused);
    expect(await deployStep(workerOnlyStep, plan, HEAD, h.io, h.deps, exec(h, 0))).toMatchObject({ ok: false });
    expect(h.undrains()).toBe(2);
    expect(h.deps.now()).toBeLessThan(RESIDENT_READY_WAIT_MS);
  });

  it.each([{ error: "private retry detail" }, { status: 200, body: {} }] satisfies PostAnswer[])(
    "settles an unproven second reply with no third request: %j",
    async (second) => {
      const h = setup(refused, second);
      expect(await deployStep(workerOnlyStep, plan, HEAD, h.io, h.deps, exec(h, 0))).toMatchObject({ ok: false });
      expect(h.undrains()).toBe(2);
      expect(h.plain().join("\n")).not.toContain("private retry detail");
    },
  );

  it.each([
    "window",
    "acquisition",
    "application",
    "source",
    "image",
    "image target",
    "fleet",
    "maintenance",
    "cancel",
    "cancel read",
    "deadline",
    "deadline read",
  ])("keeps the fleet closed without a retry when %s proof changes", async (change) => {
    const h = setup(refused, lifted, change);
    expect(await deployStep(workerOnlyStep, plan, HEAD, h.io, h.deps, exec(h, 0))).toMatchObject({ ok: false });
    expect(h.undrains()).toBe(1);
    expect(h.calls.filter((call) => call.dep === "exec")).toHaveLength(1);
    expect(h.calls.some((call) => String(call.args[0]).endsWith("/reconcile"))).toBe(false);
  });

  it("keeps a changed application unready after a successful retry acknowledgement", async () => {
    const h = setup(refused, lifted, "application after retry");
    expect(await deployStep(workerOnlyStep, plan, HEAD, h.io, h.deps, exec(h, 0))).toMatchObject({ ok: false });
    expect(h.undrains()).toBe(2);
    expect(h.calls.filter((call) => call.dep === "exec")).toHaveLength(1);
  });

  it.each([
    ["retry qualification", refused, 1],
    ["acknowledged registry settlement", lifted, 1],
    ["held registry settlement", held, 1],
    ["unknown registry settlement", { error: "reply lost" }, 1],
    ["registry settlement after the retry", refused, 2],
  ] satisfies Array<[string, PostAnswer, number]>)(
    "bounds a pending native read during %s by the original readiness deadline",
    async (_phase, first, blockAt) => {
      const h = setup(first);
      if (first !== refused) {
        const readHealth = h.deps.readHealth;
        h.deps.readHealth = async (...args) => {
          const answer = await readHealth(...args);
          return h.undrains() > 0 && args[0].endsWith("/residents") && "body" in answer
            ? { ...answer, body: { ...answer.body, draining: null } }
            : answer;
        };
      }
      await expectBoundedNativeRead(h, workerOnlyStep, () => h.undrains() >= blockAt);
      expect(h.undrains()).toBe(blockAt);
      expect(h.calls.filter((call) => call.dep === "exec")).toHaveLength(1);
    },
  );

  it("cancels a pending native qualification read without another reopen request", async () => {
    const h = setup();
    await expectBoundedNativeRead(h, workerOnlyStep, () => h.undrains() > 0, true);
    expect(h.undrains()).toBe(1);
  });
});

describe("retained staging deployment", () => {
  const maintenance = {
    ...TEST_MAINTENANCE,
    attempt: { ...TEST_MAINTENANCE.attempt, sourceCommit: HEAD, deadline: 3_600_000 },
  };
  const step = { ...workerOnlyStep, maintenance, retryOnPreflightRefusal: false };
  const registry = {
    ...currentRegistry,
    draining: drained.body.draining,
    stagingMaintenance: {
      schema: 1,
      state: "held",
      holdId: maintenance.holdId,
      generation: 1,
      fixtureSha256: maintenance.fixtureSha256,
      decisionSha256: maintenance.decisionSha256,
      attempt: maintenance.attempt,
      window: {
        state: "fenced",
        blocking: 0,
        stored: 1,
        excluded: 1,
        requestEnd: "unobserved",
        nativeOutcome: "unverified",
      },
    },
  };

  it("returns image-ready under the exact hold without requesting undrain", async () => {
    const h = harness({ RESIDENT_DRAIN_TOKEN: "drn", RESIDENT_READ_TOKEN: "read" }, [
      drained,
      { status: 200, body: { sealed: true } },
    ]);
    h.deps.readAppState = async () => app;
    h.deps.readHealth = async (url) => ({
      status: 200,
      body: url.endsWith("/residents") ? registry : { ok: true, build: { commit: HEAD } },
    });
    const result = await deployStep(step, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result).toMatchObject({ ok: true, live: "uploaded, image-ready, maintenance held" });
    expect(h.calls.filter((call) => call.dep === "postJson").map((call) => call.args[0])).toEqual([
      "https://switchboard-resident.example.test/drain",
      "https://switchboard-resident.example.test/staging-seal-window",
    ]);
  });

  it("reconciles a selected force bootstrap even when the native image is unchanged", async () => {
    const h = harness({ RESIDENT_DRAIN_TOKEN: "drn", RESIDENT_READ_TOKEN: "read" }, [drained, reconciled]);
    h.deps.readAppState = async () => app;
    h.deps.readHealth = async (url) => ({
      status: 200,
      body: url.endsWith("/residents")
        ? {
            ...registry,
            stagingMaintenance: { ...registry.stagingMaintenance, window: null },
            residents: [
              {
                resource: "repo:acme/api",
                live: {
                  imageReport: "current",
                  imageTarget: {
                    application: "switchboard-resident-residentdo",
                    version: 17,
                    image: "registry.example.test/resident:stable",
                  },
                },
              },
            ],
          }
        : { ok: true, build: { commit: HEAD } },
    });
    const result = await deployStep(
      {
        ...step,
        forcedBy: "RESIDENT_DEPLOY_FORCE",
        setEnv: {
          ...step.setEnv,
          RESIDENT_BOOTSTRAP_PREVIOUS_VERSION: "00000000-0000-4000-8000-000000000001",
        },
      },
      plan,
      HEAD,
      h.io,
      h.deps,
      exec(h, 0),
    );
    expect(result).toMatchObject({ ok: true, live: "uploaded, image-ready, maintenance held" });
    expect(
      h.calls.filter((call) => call.dep === "postJson").map((call) => ({ url: call.args[0], body: call.args[2] })),
    ).toMatchObject([
      { url: "https://switchboard-resident.example.test/drain" },
      {
        url: "https://switchboard-resident.example.test/reconcile",
        body: {
          imageTarget: {
            application: "switchboard-resident-residentdo",
            version: 17,
            image: "registry.example.test/resident:stable",
          },
        },
      },
    ]);
    expect(h.calls.filter((call) => call.dep === "postJson")).toHaveLength(2);
  });

  it("refuses bootstrap upload when native preparation consumes its readiness reserve", async () => {
    const h = harness({ RESIDENT_DRAIN_TOKEN: "drn", RESIDENT_READ_TOKEN: "read" }, [drained]);
    let now = 2_340_000;
    h.deps.now = () => now;
    h.deps.readAppState = async () => {
      now = 2_460_000;
      return app;
    };
    const result = await deployStep(
      {
        ...step,
        forcedBy: "RESIDENT_DEPLOY_FORCE",
        setEnv: {
          ...step.setEnv,
          RESIDENT_BOOTSTRAP_PREVIOUS_VERSION: "00000000-0000-4000-8000-000000000001",
        },
      },
      plan,
      HEAD,
      h.io,
      h.deps,
      exec(h, 0),
    );
    expect(result).toMatchObject({
      ok: false,
      live: "not deployed",
      reason: "selected staging bootstrap upload reserve is exhausted",
    });
    expect(h.calls.filter((call) => call.dep === "exec")).toHaveLength(0);
  });

  it("refuses a different source before upload and retains maintenance on cancellation", async () => {
    const h = harness({ RESIDENT_DRAIN_TOKEN: "drn", RESIDENT_READ_TOKEN: "read" });
    const wrong = await deployStep(step, plan, "b".repeat(40), h.io, h.deps, exec(h, 0));
    expect(wrong).toMatchObject({
      ok: false,
      live: "not deployed",
      reason: "selected staging source does not match the upload",
    });
    const control = new AbortController();
    h.deps.signal = control.signal;
    const original = h.deps.postJson!;
    h.deps.postJson = async (...args) => {
      const value = await original(...args);
      control.abort();
      return value;
    };
    const cancelled = await deployStep(step, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(cancelled).toMatchObject({ ok: false, reason: "deployment cancelled" });
    expect(h.calls.filter((call) => call.dep === "postJson").map((call) => call.args[0])).toEqual([
      "https://switchboard-resident.example.test/drain",
    ]);
  });
});

describe("the pure pieces", () => {
  it("the drain asks for the drained wait plus the margin, named by the commit; `drainSet` and `drainUntil` read the answer", () => {
    expect(drainBody(RESIDENT_DRAINED_WAIT_MAX_MS, HEAD)).toEqual({
      minutes: 90,
      reason: "deploy 62e4e9a",
      by: "deploy all",
    });
    expect(drainSet(drained)).toBe(true);
    expect(drainUntil(drained)).toBe(UNTIL);
    expect(drainSet({ status: 401, body: { error: "unauthorized" } })).toBe(false);
    expect(drainSet({ error: "POST … failed: fetch failed" })).toBe(false);
  });

  it("the lines report drain setup, held reopening and unknown replies without recovery promises", () => {
    expect(drainBeganLine("resident", drained)).toBe(
      `[deploy:all] resident: fleet drained — /attach refuses new runs until ${UNTIL}; the runs in flight finish, new ones wait at their attach`,
    );
    expect(drainBeganLine("resident", { status: 401, body: { error: "unauthorized" } })).toContain(
      "fleet drain was not acknowledged (HTTP 401); deployment stopped",
    );
    expect(drainSkippedLine("resident", RESIDENT_DRAIN_TOKEN_ENV)).toContain(
      "RESIDENT_DRAIN_TOKEN is not set — waiting without a drain",
    );
    const stood = { drained: true, until: UNTIL };
    expect(drainLiftedLine("resident", lifted, stood)).toBe(
      "[deploy:all] resident: fleet reopen acknowledged; registry readback is still required",
    );
    // A hold is not an acknowledgement that the fleet reopened.
    expect(drainLiftedLine("resident", { status: 200, body: { cleared: false, held: ["repo:acme/api"] } }, stood)).toBe(
      "[deploy:all] resident: fleet stays closed with image-report holds; awaiting registry readback",
    );
    expect(drainLiftedLine("resident", { error: "POST x failed: fetch failed" }, stood)).toBe(
      "[deploy:all] resident: fleet reopen outcome is unknown; settling through registry reads only",
    );
  });

  it("the reconcile line: every resident VERIFIED on the new image on a clean pass, the unverified named when one deferred or its fresh probe failed (the drain holds until it reports), and the request's own failure — never a failed deploy", () => {
    expect(reconcileLine("resident", reconciled)).toBe(
      "[deploy:all] resident: fleet reconciled and every container verified on the new image (repo:acme/api restarted)",
    );
    expect(reconcileLine("resident", { status: 200, body: { reconciled: [] } })).toBe(
      "[deploy:all] resident: fleet reconciled and every container verified on the new image (no residents)",
    );
    expect(
      reconcileLine("resident", {
        status: 200,
        body: {
          reconciled: [
            { resource: "repo:acme/api", result: "restarted", verified: true },
            { resource: "repo:acme/web", result: "deferred", verified: false },
          ],
        },
      }),
    ).toBe(
      "[deploy:all] resident: fleet reconciled, but not every container is verified on the new image yet (repo:acme/api restarted, repo:acme/web deferred (unverified)) — the drain holds for the unverified until each reports",
    );
    expect(reconcileLine("resident", { status: 401, body: { error: "unauthorized" } })).toBe(
      "[deploy:all] resident: the fleet could NOT be reconciled onto the new image (HTTP 401: unauthorized) — a stale container restarts on its next quiet attach or refresh instead",
    );
    expect(reconcileLine("resident", { error: "POST x failed: fetch failed" })).toContain(
      "could NOT be reconciled onto the new image (POST x failed: fetch failed)",
    );
  });

  it("an unconfirmed drain does not turn a lift reply into historical proof", () => {
    const unconfirmed = { drained: false, until: undefined };
    expect(drainLiftedLine("resident", lifted, unconfirmed)).toBe(
      "[deploy:all] resident: fleet reopen acknowledged; registry readback is still required",
    );
    expect(drainLiftedLine("resident", { status: 200, body: { draining: null, cleared: false } }, unconfirmed)).toBe(
      "[deploy:all] resident: fleet reopen acknowledged; registry readback is still required",
    );
    expect(drainLiftedLine("resident", { status: 401, body: { error: "unauthorized" } }, unconfirmed)).toBe(
      "[deploy:all] resident: fleet NOT reopened (HTTP 401; refused); the guarded request was refused",
    );
  });
});

describe("deployStep (resident) drains the fleet", () => {
  it("cancellation during the before-upload native read starts no command", async () => {
    const h = harness({ RESIDENT_DRAIN_TOKEN: "drn" }, [drained, lifted]);
    const control = new AbortController();
    Object.assign(h.deps, { signal: control.signal });
    const read = h.deps.readAppState;
    h.deps.readAppState = async (...args) => {
      const result = await read(...args);
      control.abort();
      return result;
    };
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result).toMatchObject({
      ok: false,
      live: "not deployed",
      reason: "deployment cancelled",
      noUpload: true,
    });
    expect(h.calls.filter((c) => c.dep === "exec")).toEqual([]);
    expect(h.plain()).toContain(
      "[deploy:all] resident: fleet reopen acknowledged; registry readback is still required",
    );
  });

  it.each([403, 409, "lost", "held"])("cancel cleanup %s grants no reopened credit", async (ending) => {
    const cleanup =
      typeof ending === "number"
        ? { status: ending, body: { error: "refused" } }
        : ending === "lost"
          ? { error: "connection lost" }
          : { status: 200, body: { cleared: false, draining: { until: UNTIL }, held: ["repo:acme/api"] } };
    const h = harness({ RESIDENT_DRAIN_TOKEN: "drn" }, [drained, cleanup]);
    const control = new AbortController();
    Object.assign(h.deps, { signal: control.signal });
    const sleep = h.deps.sleep;
    h.deps.sleep = async (ms) => {
      control.abort();
      await sleep(ms);
    };
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 100));
    expect(result).toMatchObject({ ok: false, live: "not deployed", reason: "deployment cancelled" });
    expect(h.calls.filter((c) => c.dep === "exec")).toHaveLength(1);
    expect(h.calls.filter((c) => c.dep === "postJson")).toHaveLength(2);
    expect(h.plain().join("\n")).not.toContain("fleet reopened");
  });

  it("a cancelled active command retains unknown upload and cannot lift from partial refusal output", async () => {
    const h = harness({ RESIDENT_DRAIN_TOKEN: "drn" }, [drained]);
    const control = new AbortController();
    Object.assign(h.deps, { signal: control.signal });
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, async () => {
      control.abort();
      return { code: 130, cancelled: true, output: REFUSED };
    });
    expect(result).toEqual({ ok: false, live: "upload outcome uncertain", reason: "deployment cancelled" });
    expect(h.calls.filter((c) => c.dep === "postJson")).toHaveLength(1);
    expect(h.plain().at(-1)).toContain("fleet stays closed");
  });

  it("cancels a completed-refusal retry wait without another attempt and acknowledges guarded cleanup", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, lifted]);
    const control = new AbortController();
    Object.assign(h.deps, { signal: control.signal });
    const sleep = h.deps.sleep;
    h.deps.sleep = async (ms) => {
      control.abort();
      await sleep(ms);
    };
    const result = await deployStep(
      residentStep,
      { ...plan, waitMaxMs: plan.pollMs },
      HEAD,
      h.io,
      h.deps,
      exec(h, 100),
    );
    expect(result).toMatchObject({ ok: false, reason: "deployment cancelled" });
    expect(h.calls.filter((c) => c.dep === "exec")).toHaveLength(1);
    expect(h.calls.filter((c) => c.dep === "postJson").map((c) => c.args[0])).toEqual([
      "https://switchboard-resident.example.test/drain",
      "https://switchboard-resident.example.test/undrain",
    ]);
    expect(h.plain()).toContain(
      "[deploy:all] resident: fleet reopen acknowledged; registry readback is still required",
    );
  });

  it("with the admin bearer: /drain is posted BEFORE the first attempt, the refusals are waited out, the deploy lands, /reconcile is posted INSIDE the drain window, /undrain after it", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, reconciled, lifted]);
    const r = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 2));
    expect(r).toEqual({ ok: true, versionId: "0c48b341-f216-4262-81c0-bc62ecb5669a", live: "live" });
    expect(h.calls.map((c) => c.dep)).toEqual(["postJson", "exec", "exec", "exec", "postJson", "postJson"]);
    expect(h.calls[0].args).toEqual([
      "https://switchboard-resident.example.test/drain",
      "drn",
      { minutes: 90, reason: "deploy 62e4e9a", by: "deploy all" },
    ]);
    // The reconcile runs while the fleet is still drained; the lift follows it.
    expect(h.calls[4].args).toEqual([
      "https://switchboard-resident.example.test/reconcile",
      "drn",
      {
        imageTarget: {
          application: "switchboard-resident-residentdo",
          version: 18,
          image: "registry.example.test/resident:new",
        },
      },
    ]);
    expect(h.calls[5].args).toEqual(["https://switchboard-resident.example.test/undrain", "drn", {}]);
    const lines = h.plain().filter((line) => line.startsWith("[deploy:all]"));
    expect(lines[0]).toBe(drainBeganLine("resident", drained));
    expect(lines.at(-3)).toBe(
      "[deploy:all] resident: fleet reconciled and every container verified on the new image (repo:acme/api restarted)",
    );
    expect(lines.at(-2)).toBe("[deploy:all] resident: fleet reopen acknowledged; registry readback is still required");
    // The drained wait is the longer budget: the heartbeat counts against 60 min, not 30.
    expect(lines.some((l) => l.includes("(60 min left)"))).toBe(true);
  });

  it("without the bearer: no POST at all, the line says the step waits without a drain, the budget is the step's own, and the upload ends partially", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read" });
    const r = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 1));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("partial deployment");
    expect(r.reason).toContain("reconcile");
    expect(h.calls.map((c) => c.dep)).toEqual(["exec", "exec"]);
    expect(h.plain()[0]).toBe(drainSkippedLine("resident", RESIDENT_DRAIN_TOKEN_ENV));
    expect(h.plain().some((l) => l.includes("(30 min left)"))).toBe(true);
  });

  it("a rejected drain stops before upload without lifting another deployment's fence", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "stale" }, [
      { status: 409, body: { error: "deploy-fence: an upload already owns the fleet drain" } },
    ]);
    h.deps.readHealth = async () => ({
      status: 200,
      body: {
        draining: {
          swapFence: true,
          reason: "deploy abc1234",
          since: "2026-09-18T04:40:00.000Z",
          until: "2026-09-18T06:10:00.000Z",
        },
      },
    });
    const r = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(r).toEqual({
      ok: false,
      live: "not deployed",
      reason: "resident fleet drain refused: deployment fence or staging maintenance conflict (HTTP 409)",
      noUpload: true,
    });
    expect(h.calls.map((c) => ({ dep: c.dep, url: c.args[0] }))).toEqual([
      { dep: "postJson", url: "https://switchboard-resident.example.test/drain" },
    ]);
    expect(h.plain()).toContain(
      "[deploy:all] resident: existing deployment fence — commit abc1234; since 2026-09-18T04:40:00.000Z; expires 2026-09-18T06:10:00.000Z; upload outcome remains unverified",
    );
  });

  it("a lost drain response stops before upload and preserves the unknown drain state", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [
      { error: "POST … failed: The operation was aborted" },
    ]);
    const r = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 1));
    expect(r).toEqual({
      ok: false,
      live: "not deployed",
      reason: "resident fleet drain response unavailable; drain state is unknown",
      noUpload: true,
    });
    expect(h.calls.map((c) => ({ dep: c.dep, url: c.args[0] }))).toEqual([
      { dep: "postJson", url: "https://switchboard-resident.example.test/drain" },
    ]);
  });

  it.each([401, 403, 500, 200])(
    "an unacknowledged HTTP %s drain cannot upload or print its response body",
    async (status) => {
      const h = harness({ RESIDENT_DRAIN_TOKEN: "fixture-drain-token" }, [
        { status, body: { error: "private-response fixture-drain-token" } },
      ]);
      const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
      expect(result).toEqual({
        ok: false,
        live: "not deployed",
        reason: `resident fleet drain was not acknowledged (HTTP ${status})`,
        noUpload: true,
      });
      expect(h.calls.map((c) => ({ dep: c.dep, url: c.args[0] }))).toEqual([
        { dep: "postJson", url: "https://switchboard-resident.example.test/drain" },
      ]);
      expect(h.plain().join("\n")).not.toMatch(/private-response|fixture-drain-token/);
    },
  );

  it("an unavailable or malformed conflict readback cannot change the refusal or disclose its body", async () => {
    for (const readback of [
      { status: 403, body: { error: "private-readback" } },
      { status: 200, body: { draining: { swapFence: true, reason: "private-readback" } } },
    ]) {
      const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [
        { status: 409, body: { error: "private-response" } },
      ]);
      h.deps.readHealth = async () => readback;
      const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
      expect(result).toEqual({
        ok: false,
        live: "not deployed",
        reason: "resident fleet drain refused: deployment fence or staging maintenance conflict (HTTP 409)",
        noUpload: true,
      });
      expect(h.plain()).toContain(
        "[deploy:all] resident: existing deployment fence details unavailable; no recovery attempted",
      );
      expect(h.plain().join("\n")).not.toMatch(/private-response|private-readback/);
    }
  });

  it("refusing past the drained budget fails by name with the drained suffix — the fleet is still reopened, and NOT reconciled: nothing deployed, so there is no new image to reconcile onto", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" });
    const r = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 1_000));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("preflight still refusing after 60 min (in flight: repo:acme/api (2 in flight))");
    expect(r.reason).toContain(DRAINED_GAVE_UP_SUFFIX);
    expect(h.calls.at(-1)?.args[0]).toBe("https://switchboard-resident.example.test/undrain");
    expect(
      h
        .plain()
        .filter((line) => line.startsWith("[deploy:all]"))
        .at(-1),
    ).toBe("[deploy:all] resident: fleet reopen acknowledged; registry readback is still required");
    expect(h.calls.filter((c) => c.dep === "exec")).toHaveLength(RESIDENT_DRAINED_WAIT_MAX_MS / plan.pollMs + 1);
  });

  it("a failed deploy command may have uploaded, so it leaves the fleet closed", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" });
    const failing: StepExec = async () => ({ code: 1, output: "✘ [ERROR] A request to the Cloudflare API failed." });
    const r = await deployStep(residentStep, plan, HEAD, h.io, h.deps, failing);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("partial deployment");
    expect(h.calls.map((c) => c.dep)).toEqual(["postJson"]);
    expect(h.plain().at(-1)).toContain("fleet stays closed");
  });

  it("a thrown resident command cannot lift a drain after an uncertain upload", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" });
    const failing: StepExec = async () => {
      throw new Error("deploy connection lost");
    };
    await expect(deployStep(residentStep, plan, HEAD, h.io, h.deps, failing)).rejects.toThrow("deploy connection lost");
    expect(h.calls.map((c) => c.dep)).toEqual(["postJson"]);
    expect(h.plain().at(-1)).toContain("fleet stays closed");
  });

  it("an upload line beside a preflight refusal does not prove that no upload landed", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" });
    const ambiguous: StepExec = async () => ({ code: 1, output: `${REFUSED}\nUploaded switchboard-resident` });
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, ambiguous);
    expect(result.reason).toContain("partial deployment");
    expect(h.calls.map((c) => c.dep)).toEqual(["postJson"]);
    expect(h.plain().at(-1)).toContain("fleet stays closed");
  });
});

describe("resident deployment readiness", () => {
  it("an inactive held container reports on the runner's reconcile retry without another upload", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, pendingReconcile, held]);
    const post = h.deps.postJson!;
    let reconciles = 0;
    h.deps.postJson = async (...args) => {
      if (args[0].endsWith("/reconcile") && ++reconciles === 2) return reconciled;
      return post(...args);
    };
    const health = h.deps.readHealth;
    h.deps.readHealth = async (url, bearer, timeoutMs) =>
      url.endsWith("/residents")
        ? { status: 200, body: reconciles < 2 ? pendingRegistry : currentRegistry }
        : health(url, bearer, timeoutMs);

    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result).toMatchObject({ ok: true, live: "live" });
    expect(reconciles).toBe(2);
    expect(h.calls.filter((c) => c.dep === "exec")).toHaveLength(1);
    expect(h.deps.now()).toBeLessThan(10 * 60_000);
  });

  it("identical pending readbacks do not flood the deploy log", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, pendingReconcile, held]);
    const health = h.deps.readHealth;
    h.deps.readHealth = async (url, bearer, timeoutMs) =>
      url.endsWith("/residents") ? { status: 200, body: pendingRegistry } : health(url, bearer, timeoutMs);
    await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(h.plain().filter((line) => line.includes("waiting for readiness"))).toHaveLength(10);
  });

  it.each([false, true])(
    "a current registry without a drain bearer cannot prove image readiness (force=%s)",
    async (force) => {
      // No pending marker also reads as current: it does not prove this deploy's image.
      const h = harness({ RESIDENT_READ_TOKEN: "read" });
      const step = force
        ? { ...residentStep, forcedBy: "RESIDENT_DEPLOY_FORCE", retryOnPreflightRefusal: false }
        : residentStep;
      const result = await deployStep(step, plan, HEAD, h.io, h.deps, exec(h, 0));
      expect(result).toMatchObject({
        ok: false,
        versionId: "0c48b341-f216-4262-81c0-bc62ecb5669a",
        live: expect.stringContaining("deployed, not live"),
        reason: expect.stringContaining("partial deployment"),
      });
      expect(result.reason).toContain("reconcile");
      expect(h.calls.map((c) => c.dep)).toEqual(["exec"]);
      expect(h.plain().some((line) => line.startsWith("[deploy:all] resident: live"))).toBe(false);
    },
  );

  it.each(["drain endpoint", "POST capability"])(
    "a current registry without the %s cannot bypass reconciliation",
    async (missing) => {
      const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" });
      const step = { ...residentStep };
      if (missing === "drain endpoint") delete step.drain;
      else delete h.deps.postJson;
      const result = await deployStep(step, plan, HEAD, h.io, h.deps, exec(h, 0));
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("partial deployment");
      expect(result.reason).toContain("reconcile");
      expect(h.calls.map((c) => c.dep)).toEqual(["exec"]);
    },
  );

  it("keeps the fleet drained when the uploaded Worker never reports the expected commit", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained]);
    const health = h.deps.readHealth;
    h.deps.readHealth = async (url, bearer, timeoutMs) =>
      url.endsWith("/healthz")
        ? { status: 200, body: { ok: true, build: { commit: "b".repeat(40) } } }
        : health(url, bearer, timeoutMs);
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("partial deployment");
    expect(h.calls.some((call) => call.args[0] === "https://switchboard-resident.example.test/reconcile")).toBe(false);
    expect(h.calls.some((call) => call.args[0] === "https://switchboard-resident.example.test/undrain")).toBe(false);
    expect(h.plain().at(-1)).toContain("fleet stays closed");
  });

  it("a healthy new Worker with cleared:false and pending image reports is a partial deployment, not success", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, pendingReconcile, held]);
    const health = h.deps.readHealth;
    h.deps.readHealth = async (url, bearer) =>
      url.endsWith("/residents") ? { status: 200, body: pendingRegistry } : health(url, bearer);
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result.ok).toBe(false);
    expect(result.live).toContain("deployed, not live");
    expect(result.versionId).toBe("0c48b341-f216-4262-81c0-bc62ecb5669a");
    expect(result.reason).toContain("partial deployment");
    expect(result.reason).toContain("repo:acme/api");
    expect(h.deps.now()).toBe(10 * 60_000);
    expect(h.calls.filter((c) => c.dep === "exec")).toHaveLength(1);
  });

  it("waits for delayed current reports AND an undrained authenticated registry before succeeding", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, pendingReconcile, held]);
    const health = h.deps.readHealth;
    let reads = 0;
    h.deps.readHealth = async (url, bearer) => {
      if (!url.endsWith("/residents")) return health(url, bearer);
      expect(bearer).toBe("read");
      expect(h.calls.some((call) => call.args[0] === "https://switchboard-resident.example.test/undrain")).toBe(true);
      reads++;
      return {
        status: 200,
        body:
          reads === 1
            ? pendingRegistry
            : reads === 2
              ? { ...currentRegistry, draining: pendingRegistry.draining }
              : currentRegistry,
      };
    };
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result).toMatchObject({ ok: true, live: "live" });
    expect(reads).toBe(3);
    expect(h.deps.now()).toBeGreaterThan(0);
  });

  it("a drain cleared by its backstop does not make a pending image report current", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, pendingReconcile, held]);
    const health = h.deps.readHealth;
    h.deps.readHealth = async (url, bearer) =>
      url.endsWith("/residents") ? { status: 200, body: { ...pendingRegistry, draining: null } } : health(url, bearer);
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("repo:acme/api");
    expect(result.reason).toContain("pending");
  });

  it("an old healthy Worker cannot reconcile the old image before the exact deployed build arrives", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, reconciled, lifted]);
    const health = h.deps.readHealth;
    let reads = 0;
    h.deps.readHealth = async (url, bearer) => {
      if (url.endsWith("/healthz") && reads++ === 0) {
        expect(h.calls.filter((c) => c.args[0] === "https://switchboard-resident.example.test/reconcile")).toHaveLength(
          0,
        );
        return { status: 200, body: { ok: true, build: { commit: "b".repeat(40) } } };
      }
      return health(url, bearer);
    };
    expect((await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0))).ok).toBe(true);
    expect(h.deps.now()).toBeGreaterThan(0);
  });

  it("the readiness deadline bounds each read and includes time already spent reconciling", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, pendingReconcile, held]);
    const post = h.deps.postJson!;
    h.deps.postJson = async (...args) => {
      if (args[0].endsWith("/reconcile")) await h.deps.sleep(10 * 60_000 - 1);
      return post(...args);
    };
    const health = h.deps.readHealth;
    h.deps.readHealth = async (url, bearer, timeoutMs) => {
      if (url.endsWith("/residents")) {
        expect(timeoutMs).toBe(1);
        await h.deps.sleep(timeoutMs!);
        return { status: 200, body: pendingRegistry };
      }
      return health(url, bearer);
    };
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result.ok).toBe(false);
    expect(h.deps.now()).toBe(10 * 60_000);
  });

  it("a force bypass with reconciliation does not bypass authenticated registry readiness", async () => {
    const h = harness({ RESIDENT_DRAIN_TOKEN: "drn" }, [drained, reconciled, lifted]);
    const result = await deployStep(
      { ...residentStep, forcedBy: "RESIDENT_DEPLOY_FORCE", retryOnPreflightRefusal: false },
      plan,
      HEAD,
      h.io,
      h.deps,
      exec(h, 0),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("registry unreadable");
    expect(result.reason).toContain("partial deployment");
  });

  it("a missing reconcile answer fails partially and leaves the fleet closed", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [
      drained,
      { error: "lost reconcile" },
      lifted,
    ]);
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("reconcile");
    expect(h.calls.some((call) => call.args[0] === "https://switchboard-resident.example.test/undrain")).toBe(false);
    expect(h.plain().at(-1)).toContain("fleet stays closed");
  });
});

describe("resident application target", () => {
  it("uses structured registry intent when the deploy output omits its container announcement", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, reconciled, lifted]);
    let reads = 0;
    h.deps.readAppState = async () => ({
      value: reads++ < 2 ? app.value : { version: 18, image: "registry.example.test/resident:new" },
    });
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result).toMatchObject({ ok: true, live: "live" });
    expect(h.plain()).toContain(
      "[deploy:all] resident: waiting for the selected container application target to register",
    );
    expect(h.calls.find((c) => c.args[0] === "https://switchboard-resident.example.test/reconcile")?.args[2]).toEqual({
      imageTarget: {
        application: "switchboard-resident-residentdo",
        version: 18,
        image: "registry.example.test/resident:new",
      },
    });
  });

  it("refuses missing, unrecognized or foreign build intent instead of approving an old target", async () => {
    for (const output of [
      DEPLOYED,
      `${DEPLOYED}\nContainer application changes\nunrecognized`,
      `${DEPLOYED}\nContainer application changes\nno changes foreign-residentdo`,
      `${DEPLOYED}\nContainer application changes\nEDIT foreign-residentdo\n+ "image": "registry.example.test/resident:new"`,
      `${DEPLOYED}\nContainer application changes\nEDIT switchboard-resident-residentdo\n+ "instance_type": "standard"\nNEW foreign-residentdo\n+ "image": "registry.example.test/resident:new"`,
      `${DEPLOYED}\nContainer application changes\nno changes switchboard-resident-residentdo\nNEW foreign-residentdo\n+ "image": "registry.example.test/resident:new"`,
    ]) {
      const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained]);
      h.deps.readAppState = async () => app;
      const result = await deployStep(
        { ...residentStep, residentImage: undefined },
        plan,
        HEAD,
        h.io,
        h.deps,
        async () => ({ code: 0, output }),
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("image intent is unverified");
      expect(h.calls.filter((c) => c.dep === "postJson").map((c) => c.args[0])).toEqual([
        "https://switchboard-resident.example.test/drain",
      ]);
    }
  });

  it("accepts a known build no-change hint only with identical structured native reads", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, lifted]);
    h.deps.readAppState = async () => app;
    const result = await deployStep(
      { ...workerOnlyStep, residentImage: undefined },
      plan,
      HEAD,
      h.io,
      h.deps,
      async () => ({
        code: 0,
        output: `${DEPLOYED}\nContainer application changes\n│ no changes switchboard-resident-residentdo\nNo changes to be made`,
      }),
    );
    expect(result).toMatchObject({ ok: true, live: "live" });
    expect(h.calls.filter((c) => c.dep === "postJson").map((c) => c.args[0])).toEqual([
      "https://switchboard-resident.example.test/drain",
      "https://switchboard-resident.example.test/undrain",
    ]);
  });
  it.each([
    { status: 500, body: { ...currentRegistry, pendingReplicas: 1 } },
    {
      status: 200,
      body: {
        ...currentRegistry,
        pendingReplicas: 1,
        count: 2,
        residents: [currentRegistry.residents[0], currentRegistry.residents[0]],
      },
    },
    {
      status: 200,
      body: {
        ...currentRegistry,
        pendingReplicas: 1,
        residents: [{ resource: "repo:acme/api", live: { error: "read failed" } }],
      },
    },
    { status: 200, body: { ...currentRegistry, pendingReplicas: 1.5 } },
  ])("pending activation cannot bypass failed registry evidence: %j", async (registry) => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, reconciled, lifted]);
    h.deps.readAppState = async () => app;
    const read = h.deps.readHealth;
    h.deps.readHealth = async (url, bearer, timeoutMs) =>
      url.endsWith("/residents") ? registry : read(url, bearer, timeoutMs);
    const result = await deployStep(workerOnlyStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result).toMatchObject({ ok: false });
    expect(h.calls.map((c) => c.args[0])).toEqual(["https://switchboard-resident.example.test/drain", undefined]);
  });
  it("reconciles pending pool members even when the uploaded application is unchanged", async () => {
    const member = { resource: "repo:acme/api", residentId: "resident-b", live: { imageReport: "current" } };
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [
      drained,
      {
        status: 200,
        body: {
          reconciled: [
            { resource: "repo:acme/api", result: "current", verified: true },
            { ...member, result: "current", verified: true },
          ],
        },
      },
      lifted,
    ]);
    h.deps.readAppState = async () => app;
    const read = h.deps.readHealth;
    let listings = 0;
    h.deps.readHealth = async (url, bearer, timeoutMs) =>
      url.endsWith("/residents")
        ? {
            status: 200,
            body:
              listings++ === 0
                ? { ...currentRegistry, pendingReplicas: 1 }
                : {
                    ...currentRegistry,
                    count: 2,
                    pendingReplicas: 0,
                    residents: [...currentRegistry.residents, member].map((row) => ({
                      ...row,
                      live: {
                        ...row.live,
                        imageTarget: {
                          application: "switchboard-resident-residentdo",
                          version: 17,
                          image: "registry.example.test/resident:stable",
                        },
                      },
                    })),
                  },
          }
        : read(url, bearer, timeoutMs);
    expect(await deployStep(workerOnlyStep, plan, HEAD, h.io, h.deps, exec(h, 0))).toMatchObject({
      ok: true,
      live: "live",
    });
    expect(h.calls.map((c) => c.args[0])).toEqual([
      "https://switchboard-resident.example.test/drain",
      undefined,
      "https://switchboard-resident.example.test/reconcile",
      "https://switchboard-resident.example.test/undrain",
    ]);
  });
  it("unchanged named application skips image reconcile while retaining terminal workspaces", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, lifted]);
    const reads: string[] = [];
    h.deps.readAppState = async (_dir, name) => {
      reads.push(name);
      return app;
    };
    const original = h.deps.readHealth;
    const protectedThreads = ["first", "second", "third"].map((threadKey) => ({ threadKey, evicted: false }));
    h.deps.readHealth = async (url, bearer, timeoutMs) =>
      url.endsWith("/residents")
        ? {
            status: 200,
            body: {
              ...currentRegistry,
              residents: [
                { ...currentRegistry.residents[0], live: { imageReport: "current", threads: protectedThreads } },
              ],
            },
          }
        : original(url, bearer, timeoutMs);

    const result = await deployStep(workerOnlyStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result).toMatchObject({ ok: true, live: "live" });
    expect(reads).toEqual([
      residentStep.residentContainerApp,
      residentStep.residentContainerApp,
      residentStep.residentContainerApp,
    ]);
    expect(h.calls.map((c) => c.args[0])).toEqual([
      "https://switchboard-resident.example.test/drain",
      undefined,
      "https://switchboard-resident.example.test/undrain",
    ]);
    expect(h.plain().join("\n")).toContain("unchanged container application");
    expect(protectedThreads.every((thread) => thread.evicted === false)).toBe(true);
  });

  it("changed application uses guarded reconcile", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, reconciled, lifted]);
    let reads = 0;
    h.deps.readAppState = async () =>
      reads++ === 0 ? app : { value: { version: 18, image: "registry.example.test/resident:new" } };
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result).toMatchObject({ ok: true, live: "live" });
    expect(h.calls.some((c) => c.args[0] === "https://switchboard-resident.example.test/reconcile")).toBe(true);
  });

  it.each([
    ["lost", { error: "reply lost" }],
    ["malformed", { status: 200, body: {} }],
    ["server failure", { status: 503, body: { error: "unavailable" } }],
  ] satisfies Array<[string, PostAnswer]>)(
    "keeps exact image target proof after a %s changed-image reopen reply",
    async (_name, reply) => {
      for (const imageTarget of [null, { ...currentRegistry.residents[0].live.imageTarget, version: 99 }]) {
        const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, reconciled, reply]);
        const original = h.deps.readHealth;
        h.deps.readHealth = async (url, ...args) =>
          url.endsWith("/residents")
            ? {
                status: 200,
                body: {
                  ...currentRegistry,
                  residents: [{ resource: "repo:acme/api", live: { imageReport: "current", imageTarget } }],
                },
              }
            : original(url, ...args);
        const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
        expect(result.ok).toBe(false);
        expect(result.reason).toContain("selected image target is unverified");
        expect(h.calls.filter((call) => call.dep === "postJson").map((call) => call.args[0])).toEqual([
          "https://switchboard-resident.example.test/drain",
          "https://switchboard-resident.example.test/reconcile",
          "https://switchboard-resident.example.test/undrain",
        ]);
      }
    },
  );

  it("settles a lost changed-image reopen by reads with the original exact target", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [
      drained,
      reconciled,
      { error: "reply lost" },
    ]);
    expect(await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0))).toMatchObject({
      ok: true,
      live: "live",
    });
    expect(h.calls.filter((call) => call.dep === "postJson").map((call) => call.args[0])).toEqual([
      "https://switchboard-resident.example.test/drain",
      "https://switchboard-resident.example.test/reconcile",
      "https://switchboard-resident.example.test/undrain",
    ]);
  });

  it("bounds a pending final native read after a lost changed-image reopen", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [
      drained,
      reconciled,
      { error: "reply lost" },
    ]);
    await expectBoundedNativeRead(h, residentStep, () =>
      h.calls.some((call) => String(call.args[0]).endsWith("/undrain")),
    );
    expect(h.calls.filter((call) => call.dep === "postJson").map((call) => call.args[0])).toEqual([
      "https://switchboard-resident.example.test/drain",
      "https://switchboard-resident.example.test/reconcile",
      "https://switchboard-resident.example.test/undrain",
    ]);
  });

  it("refuses a missing or different image target acknowledgement without lifting the drain", async () => {
    for (const imageTarget of [
      undefined,
      { application: "foreign-residentdo", version: 18, image: "registry.example.test/resident:new" },
    ]) {
      const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [
        drained,
        { ...reconciled, body: { ...reconciled.body, imageTarget } },
      ]);
      const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
      expect(result).toMatchObject({ ok: false });
      expect(result.reason).toContain("reconcile did not confirm the affected fleet");
      expect(h.calls.filter((c) => c.dep === "postJson").map((c) => c.args[0])).toEqual([
        "https://switchboard-resident.example.test/drain",
        "https://switchboard-resident.example.test/reconcile",
      ]);
    }
  });

  it("refuses current reports for another image target on any physical member", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, reconciled, lifted]);
    const original = h.deps.readHealth;
    h.deps.readHealth = async (url, ...args) =>
      url.endsWith("/residents")
        ? {
            status: 200,
            body: {
              ...currentRegistry,
              count: 2,
              residents: [
                currentRegistry.residents[0],
                {
                  resource: "repo:acme/api",
                  residentId: "resident-2",
                  live: {
                    imageReport: "current",
                    imageTarget: {
                      application: "switchboard-resident-residentdo",
                      version: 17,
                      image: "registry.example.test/resident:stable",
                    },
                  },
                },
              ],
            },
          }
        : original(url, ...args);
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("resident-2: selected image target is unverified");
  });

  it("refuses image readiness if the native application target changes after reconciliation", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, reconciled, lifted]);
    let reads = 0;
    h.deps.readAppState = async () => ({
      value:
        reads++ === 0
          ? app.value
          : reads === 2
            ? { version: 18, image: "registry.example.test/resident:new" }
            : { version: 19, image: "registry.example.test/resident:other" },
    });
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(
      "Resident application target changed or could not be verified before image readiness",
    );
    expect(h.calls.find((c) => c.args[0] === "https://switchboard-resident.example.test/reconcile")?.args[2]).toEqual({
      imageTarget: {
        application: "switchboard-resident-residentdo",
        version: 18,
        image: "registry.example.test/resident:new",
      },
    });
  });

  it("a changed image with protected registrations stays pending behind the reconcile guard", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, pendingReconcile, held]);
    const protectedThreads = ["first", "second", "third"].map((threadKey) => ({ threadKey, evicted: false }));
    const original = h.deps.readHealth;
    h.deps.readHealth = async (url, bearer, timeoutMs) =>
      url.endsWith("/residents")
        ? {
            status: 200,
            body: {
              ...pendingRegistry,
              residents: [
                { ...pendingRegistry.residents[0], live: { imageReport: "pending", threads: protectedThreads } },
              ],
            },
          }
        : original(url, bearer, timeoutMs);
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("image report pending");
    expect(h.calls.some((c) => c.args[0] === "https://switchboard-resident.example.test/reconcile")).toBe(true);
    expect(h.calls.some((c) => c.args[0] === "https://switchboard-resident.example.test/undrain")).toBe(true);
    expect(h.plain().some((line) => line.includes("fleet stays closed"))).toBe(true);
    expect(protectedThreads.every((thread) => thread.evicted === false)).toBe(true);
  });

  it("a printed container change refuses an unchanged native target without reconciling or lifting", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, reconciled, lifted]);
    h.deps.readAppState = async () => app;
    h.deps.readHealth = async (url) => ({
      status: 200,
      body: url.endsWith("/residents")
        ? {
            ...currentRegistry,
            residents: [
              {
                resource: "repo:acme/api",
                live: {
                  imageReport: "current",
                  imageTarget: {
                    application: "switchboard-resident-residentdo",
                    version: 17,
                    image: "registry.example.test/resident:stable",
                  },
                },
              },
            ],
          }
        : { ok: true, build: { commit: HEAD } },
    });
    const upload: StepExec = async () => ({
      code: 0,
      output: `${DEPLOYED}\nContainer application changes\nEDIT switchboard-resident-residentdo\n+ "image": "registry.example.test/resident:new"`,
    });
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, upload);
    expect(result.ok).toBe(false);
    expect(h.calls.filter((c) => c.dep === "postJson").map((c) => c.args[0])).toEqual([
      "https://switchboard-resident.example.test/drain",
    ]);
  });

  it("waits for the printed image to register before selecting its native target", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, reconciled, lifted]);
    let reads = 0;
    h.deps.readAppState = async () => ({
      value: reads++ < 2 ? app.value : { version: 18, image: "registry.example.test/resident:new" },
    });
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, async () => ({
      code: 0,
      output: `${DEPLOYED}\nContainer application changes\nEDIT switchboard-resident-residentdo\n+ "image": "registry.example.test/resident:new"`,
    }));
    expect(result).toMatchObject({ ok: true, live: "live" });
    expect(h.plain()).toContain(
      "[deploy:all] resident: waiting for the selected container application target to register",
    );
    expect(h.calls.find((c) => c.args[0] === "https://switchboard-resident.example.test/reconcile")?.args[2]).toEqual({
      imageTarget: {
        application: "switchboard-resident-residentdo",
        version: 18,
        image: "registry.example.test/resident:new",
      },
    });
  });

  it.each([1, 2])(
    "recovers a transient application read at observation %s without repeating the upload",
    async (failedRead) => {
      const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, reconciled, lifted]);
      let reads = 0;
      h.deps.readAppState = async () => {
        const observation = reads++;
        if (observation === failedRead)
          return {
            error: "provider unavailable",
            diagnostic: closedReadEvidence({ stage: "application-info", reason: "command-error", httpStatus: 500 }),
          };
        return observation < failedRead ? app : { value: { version: 18, image: "registry.example.test/resident:new" } };
      };
      const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
      expect(result).toMatchObject({ ok: true, live: "live" });
      expect(h.calls.filter((call) => call.dep === "exec")).toHaveLength(1);
      expect(
        h.calls.find((call) => call.args[0] === "https://switchboard-resident.example.test/reconcile")?.args[2],
      ).toEqual({
        imageTarget: {
          application: "switchboard-resident-residentdo",
          version: 18,
          image: "registry.example.test/resident:new",
        },
      });
      expect(h.plain().join("\n")).toContain("application read unavailable (HTTP 500)");
      expect(h.plain().join("\n")).not.toContain("provider unavailable");
    },
  );

  it("keeps a persistent application read failure held at the original readiness deadline", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained]);
    let reads = 0;
    h.deps.readAppState = async () =>
      reads++ === 0
        ? app
        : {
            error: "provider unavailable",
            diagnostic: closedReadEvidence({ stage: "application-info", reason: "command-error", httpStatus: 500 }),
          };
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result).toMatchObject({ ok: false });
    expect(result.live).toContain("deployed, not live");
    expect(result.reason).toContain("provider unavailable");
    expect(h.deps.now()).toBe(RESIDENT_READY_WAIT_MS);
    expect(h.calls.map((call) => call.args[0])).toEqual(["https://switchboard-resident.example.test/drain", undefined]);
  });

  it("refuses a denied application read without waiting or reconciling", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained]);
    let reads = 0;
    h.deps.readAppState = async () =>
      reads++ === 0
        ? app
        : {
            error: "read denied",
            diagnostic: closedReadEvidence({ stage: "application-info", reason: "command-error", httpStatus: 403 }),
          };
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toContain("read denied");
    expect(h.deps.now()).toBe(0);
    expect(h.calls.map((call) => call.args[0])).toEqual(["https://switchboard-resident.example.test/drain", undefined]);
  });

  it("a recovered read cannot authorize a regressed application target", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained]);
    let reads = 0;
    h.deps.readAppState = async () => {
      if (reads++ === 0) return app;
      return reads === 2
        ? {
            error: "provider unavailable",
            diagnostic: closedReadEvidence({ stage: "application-info", reason: "command-error", httpStatus: 503 }),
          }
        : { value: { version: 16, image: "registry.example.test/resident:new" } };
    };
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toContain("target is incomplete or regressed");
    expect(h.calls.map((call) => call.args[0])).toEqual(["https://switchboard-resident.example.test/drain", undefined]);
  });

  it("operator cancellation stops a transient application read wait with the fleet held", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained]);
    const control = new AbortController();
    h.deps.signal = control.signal;
    h.deps.sleep = async () => control.abort();
    let reads = 0;
    h.deps.readAppState = async () =>
      reads++ === 0
        ? app
        : {
            error: "provider unavailable",
            diagnostic: closedReadEvidence({ stage: "application-info", reason: "command-error", httpStatus: 502 }),
          };
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result).toMatchObject({ ok: false, reason: "deployment cancelled" });
    expect(h.calls.map((call) => call.args[0])).toEqual(["https://switchboard-resident.example.test/drain", undefined]);
  });

  it("retains the drain when native target evidence arrives after the readiness deadline", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, reconciled, lifted]);
    let reads = 0;
    h.deps.readAppState = async () => {
      if (reads++ === 0) return app;
      await h.deps.sleep(10 * 60_000 + 1);
      return { value: { version: 18, image: "registry.example.test/resident:new" } };
    };
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result.ok).toBe(false);
    expect(h.calls.filter((c) => c.dep === "postJson").map((c) => c.args[0])).toEqual([
      "https://switchboard-resident.example.test/drain",
    ]);
  });

  it("unreadable application cannot lift the drain", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained]);
    let reads = 0;
    h.deps.readAppState = async () => (reads++ === 0 ? app : { error: "Cloudflare application unavailable" });
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("application");
    expect(h.calls.some((c) => c.args[0] === "https://switchboard-resident.example.test/reconcile")).toBe(false);
    expect(h.calls.some((c) => c.args[0] === "https://switchboard-resident.example.test/undrain")).toBe(false);
  });

  it("an unreadable application before upload refuses without sending the Worker", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained, lifted]);
    h.deps.readAppState = async () => ({ error: "Cloudflare application unavailable" });
    const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result).toMatchObject({ ok: false, live: "not deployed" });
    expect(result.reason).toContain("container application");
    expect(h.calls.map((c) => c.args[0])).toEqual([
      "https://switchboard-resident.example.test/drain",
      "https://switchboard-resident.example.test/undrain",
    ]);
  });

  it("an incomplete or regressed application target cannot lift the drain", async () => {
    for (const after of [
      { error: "Cloudflare read timed out" },
      { value: { version: 17, image: null } },
      { value: { version: 16, image: app.value.image } },
    ]) {
      const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained]);
      let reads = 0;
      h.deps.readAppState = async () => (reads++ === 0 ? app : after);
      const result = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("container application");
      expect(h.calls.some((c) => c.args[0] === "https://switchboard-resident.example.test/reconcile")).toBe(false);
      expect(h.calls.some((c) => c.args[0] === "https://switchboard-resident.example.test/undrain")).toBe(false);
    }
  });

  it("an older pending image report blocks the Worker-only shortcut without touching the protected workspace", async () => {
    const h = harness({ RESIDENT_READ_TOKEN: "read", RESIDENT_DRAIN_TOKEN: "drn" }, [drained]);
    h.deps.readAppState = async () => app;
    const original = h.deps.readHealth;
    const protectedThreads = ["first", "second", "third"].map((threadKey) => ({ threadKey, evicted: false }));
    h.deps.readHealth = async (url, bearer, timeoutMs) =>
      url.endsWith("/residents")
        ? {
            status: 200,
            body: {
              ...pendingRegistry,
              residents: [
                { ...pendingRegistry.residents[0], live: { imageReport: "pending", threads: protectedThreads } },
              ],
            },
          }
        : original(url, bearer, timeoutMs);

    const result = await deployStep(workerOnlyStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("image report pending");
    expect(h.calls.some((c) => c.args[0] === "https://switchboard-resident.example.test/reconcile")).toBe(false);
    expect(h.calls.some((c) => c.args[0] === "https://switchboard-resident.example.test/undrain")).toBe(false);
    expect(protectedThreads.every((thread) => thread.evicted === false)).toBe(true);
  });
});
