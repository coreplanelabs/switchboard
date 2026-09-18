import { describe, expect, it } from "vitest";
import {
  DRAINED_GAVE_UP_SUFFIX,
  drainBeganLine,
  drainBody,
  drainLiftedLine,
  drainSet,
  drainSkippedLine,
  drainUntil,
  RESIDENT_DRAINED_WAIT_MAX_MS,
  RESIDENT_DRAIN_TOKEN_ENV,
  type PostAnswer,
} from "./residentDrain.js";
import { RESIDENT_WAIT_MAX_MS, type DeployStep } from "./plan.js";
import { deployStep, type SandboxGateDeps, type StepExec } from "./run.js";

// Feature: docs/reference/specs/release-and-deploy.md item 31 — the resident
// step drains the fleet: `POST /drain` before its first attempt when the admin
// bearer is in the env, a wait past a run's whole lease while the runs in
// flight end, `POST /undrain` after the step whatever it ended as; without the
// bearer, today's wait and a line that says so. Every I/O is injected.

const HEAD = "62e4e9ad464820900b07bed176e140af6682c598";
const UNTIL = "2026-09-18T06:10:00.000Z";
const drained: PostAnswer = {
  status: 200,
  body: { draining: { since: "…", until: UNTIL, by: "deploy all", reason: "deploy 62e4e9a" } },
};
const lifted: PostAnswer = { status: 200, body: { draining: null, cleared: true } };
const REFUSED = [
  "[resident-preflight] preflight REFUSED: a Worker deploy swaps every ResidentDO isolate and kills in-flight runs and provisions —",
  "  - in flight: repo:acme/api (2 in flight)",
  "  wait for them to finish and retry",
].join("\n");
const DEPLOYED = "Uploaded switchboard-resident\nCurrent Version ID: 0c48b341-f216-4262-81c0-bc62ecb5669a";

const residentStep: DeployStep = {
  name: "resident",
  script: "switchboard-resident",
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
const plan = { waitMaxMs: 10 * 60_000, pollMs: 60_000 };

function harness(env: Record<string, string>, posts: PostAnswer[] = [drained, lifted]) {
  const calls: { dep: string; args: unknown[] }[] = [];
  const lines: string[] = [];
  let clock = 0;
  const deps: SandboxGateDeps = {
    env,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    readHealth: async () => ({ error: "unscripted" }),
    readAppState: async () => ({ error: "unscripted" }),
    readInstances: async () => ({ error: "unscripted" }),
    probeExec: async () => ({ body: { stdout: "", stderr: "", exitCode: 1 } }),
    postJson: async (...args) => {
      calls.push({ dep: "postJson", args });
      return posts.shift() ?? { error: "unscripted POST" };
    },
  };
  const io = { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(`WARN ${l}`), stream: () => {} };
  /** The runner's own lines, without the span log lines. */
  const plain = () => lines.filter((l) => !l.startsWith("{"));
  return { deps, io, calls, plain };
}

/** The step's command: `refusals` REFUSED exits, then the deploy. */
const exec =
  (h: ReturnType<typeof harness>, refusals: number): StepExec =>
  async () => {
    h.calls.push({ dep: "exec", args: [] });
    if (refusals-- > 0) return { code: 1, output: REFUSED };
    return { code: 0, output: DEPLOYED };
  };

describe("the pure pieces", () => {
  it("the drain asks for the drained wait plus the margin, named by the commit; `drainSet` and `drainUntil` read the answer", () => {
    expect(drainBody(RESIDENT_DRAINED_WAIT_MAX_MS, HEAD)).toEqual({
      minutes: 65,
      reason: "deploy 62e4e9a",
      by: "deploy all",
    });
    expect(drainSet(drained)).toBe(true);
    expect(drainUntil(drained)).toBe(UNTIL);
    expect(drainSet({ status: 401, body: { error: "unauthorized" } })).toBe(false);
    expect(drainSet({ error: "POST … failed: fetch failed" })).toBe(false);
  });

  it("the lines: drained (with the end), refused (with the words), skipped (naming the env var), reopened, not reopened (with the self-end)", () => {
    expect(drainBeganLine("resident", drained)).toBe(
      `[deploy:all] resident: fleet drained — /attach refuses new runs until ${UNTIL}; the runs in flight finish, new ones wait at their attach`,
    );
    expect(drainBeganLine("resident", { status: 401, body: { error: "unauthorized" } })).toContain(
      "could NOT be drained (HTTP 401: unauthorized) — waiting without a drain",
    );
    expect(drainSkippedLine("resident", RESIDENT_DRAIN_TOKEN_ENV)).toContain(
      "RESIDENT_DRAIN_TOKEN is not set — waiting without a drain",
    );
    const stood = { drained: true, until: UNTIL };
    expect(drainLiftedLine("resident", lifted, stood)).toBe("[deploy:all] resident: fleet reopened");
    expect(drainLiftedLine("resident", { error: "POST x failed: fetch failed" }, stood)).toBe(
      `[deploy:all] resident: fleet NOT reopened (POST x failed: fetch failed) — it reopens by itself at ${UNTIL}; \`POST /undrain\` with the drain or admin bearer reopens it now`,
    );
  });

  it("the lift line after a drain the runner never saw land tells the truth: cleared → it had landed; not cleared → nothing stood; a failed lift names the doubt, never a drain that ends", () => {
    const unconfirmed = { drained: false, until: undefined };
    expect(drainLiftedLine("resident", lifted, unconfirmed)).toBe(
      "[deploy:all] resident: fleet reopened — the drain had landed although its answer was lost",
    );
    expect(drainLiftedLine("resident", { status: 200, body: { draining: null, cleared: false } }, unconfirmed)).toBe(
      "[deploy:all] resident: no drain stood to lift — the fleet was never closed",
    );
    expect(drainLiftedLine("resident", { status: 401, body: { error: "unauthorized" } }, unconfirmed)).toBe(
      "[deploy:all] resident: the lift answered HTTP 401: unauthorized and no drain was confirmed — the fleet should be open; `GET /residents` says (`draining`), and `POST /undrain` with the drain or admin bearer reopens it if not",
    );
  });
});

describe("deployStep (resident) drains the fleet", () => {
  it("with the admin bearer: /drain is posted BEFORE the first attempt, the refusals are waited out, the deploy lands, /undrain is posted after", async () => {
    const h = harness({ RESIDENT_DRAIN_TOKEN: "drn" });
    const r = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 2));
    expect(r).toEqual({ ok: true, versionId: "0c48b341-f216-4262-81c0-bc62ecb5669a", live: "n/a" });
    expect(h.calls.map((c) => c.dep)).toEqual(["postJson", "exec", "exec", "exec", "postJson"]);
    expect(h.calls[0].args).toEqual([
      "https://switchboard-resident.example.test/drain",
      "drn",
      { minutes: 65, reason: "deploy 62e4e9a", by: "deploy all" },
    ]);
    expect(h.calls[4].args).toEqual(["https://switchboard-resident.example.test/undrain", "drn", {}]);
    const lines = h.plain();
    expect(lines[0]).toBe(drainBeganLine("resident", drained));
    expect(lines.at(-1)).toBe("[deploy:all] resident: fleet reopened");
    // The drained wait is the longer budget: the heartbeat counts against 60 min, not 30.
    expect(lines.some((l) => l.includes("(60 min left)"))).toBe(true);
  });

  it("without the bearer: no POST at all, the line says the step waits without a drain, and the budget is the step's own", async () => {
    const h = harness({});
    const r = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 1));
    expect(r.ok).toBe(true);
    expect(h.calls.map((c) => c.dep)).toEqual(["exec", "exec"]);
    expect(h.plain()[0]).toBe(drainSkippedLine("resident", RESIDENT_DRAIN_TOKEN_ENV));
    expect(h.plain().some((l) => l.includes("(30 min left)"))).toBe(true);
  });

  it("a drain the Worker refused (a rejected bearer) is said, the wait is today's — and /undrain is still posted after: a drain whose answer was lost may have landed", async () => {
    const h = harness({ RESIDENT_DRAIN_TOKEN: "stale" }, [
      { status: 401, body: { error: "unauthorized" } },
      { status: 401, body: { error: "unauthorized" } },
    ]);
    const r = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 0));
    expect(r.ok).toBe(true);
    expect(h.calls.map((c) => c.dep)).toEqual(["postJson", "exec", "postJson"]);
    expect(h.plain()[0]).toContain("could NOT be drained (HTTP 401: unauthorized)");
    expect(h.plain().at(-1)).toContain("the lift answered HTTP 401: unauthorized and no drain was confirmed");
  });

  it("a /drain whose answer was lost (the transport failed after the record may have landed) waits the undrained budget and still lifts the drain after", async () => {
    const h = harness({ RESIDENT_DRAIN_TOKEN: "drn" }, [{ error: "POST … failed: The operation was aborted" }, lifted]);
    const r = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 1));
    expect(r.ok).toBe(true);
    expect(h.calls.map((c) => c.dep)).toEqual(["postJson", "exec", "exec", "postJson"]);
    expect(h.plain().some((l) => l.includes("(30 min left)"))).toBe(true);
    expect(h.plain().at(-1)).toBe(
      "[deploy:all] resident: fleet reopened — the drain had landed although its answer was lost",
    );
  });

  it("refusing past the drained budget fails by name with the drained suffix — and the fleet is still reopened", async () => {
    const h = harness({ RESIDENT_DRAIN_TOKEN: "drn" });
    const r = await deployStep(residentStep, plan, HEAD, h.io, h.deps, exec(h, 1_000));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("preflight still refusing after 60 min (in flight: repo:acme/api (2 in flight))");
    expect(r.reason).toContain(DRAINED_GAVE_UP_SUFFIX);
    expect(h.calls.at(-1)?.args[0]).toBe("https://switchboard-resident.example.test/undrain");
    expect(h.plain().at(-1)).toBe("[deploy:all] resident: fleet reopened");
    expect(h.calls.filter((c) => c.dep === "exec")).toHaveLength(RESIDENT_DRAINED_WAIT_MAX_MS / plan.pollMs + 1);
  });

  it("a failed deploy command (not a refusal) ends the step at once and still reopens the fleet", async () => {
    const h = harness({ RESIDENT_DRAIN_TOKEN: "drn" });
    const failing: StepExec = async () => ({ code: 1, output: "✘ [ERROR] A request to the Cloudflare API failed." });
    const r = await deployStep(residentStep, plan, HEAD, h.io, h.deps, failing);
    expect(r.ok).toBe(false);
    expect(h.calls.map((c) => c.dep)).toEqual(["postJson", "postJson"]);
  });
});
