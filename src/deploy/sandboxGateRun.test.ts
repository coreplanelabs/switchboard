import { describe, expect, it } from "vitest";
import { LIVE_GATE_DEADLINE_MS, LIVE_GATE_POLL_MS } from "./liveGate.js";
import { SANDBOX_BEARER_ENV, workersFor, type DeployStep, type SandboxLiveGate } from "./plan.js";
import { deployStep, waitUntilSandboxLive, type SandboxGateDeps, type SandboxRollout, type StepExec } from "./run.js";
import type { LogLine } from "../core/trace/sinks.js";
import {
  probeThreadKey,
  type AppState,
  type ContainerInstance,
  type HealthRead,
  type ProbeResult,
  type Read,
} from "./sandboxLiveGate.js";
import { TEST_PROFILE } from "./testing/profile.js";

// The sandbox live gate's LOOP (src/deploy/run.ts `waitUntilSandboxLive`,
// docs/reference/specs/release-and-deploy.md item 16): read the Worker's /healthz with the
// bearer; once it serves the deployed commit, probe `echo ok` through the gate's
// thread and read the container application's state and instances; live only
// when all three agree — the application having LEFT the version read before
// the upload when wrangler printed a container change — waiting through
// everything a rollout can cause, failing at the shared deadline with the last
// reason. Every I/O is injected: nothing here reaches the network, wrangler or
// the clock. `deployStep` is driven with the step's command injected too, so
// the order "read the application, THEN upload" is a fact this file pins.

const HEAD = "e6af1aa0b7c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9";
const OLD = "610682f7abcdef0123456789abcdef0123456789";
const KEY = probeThreadKey(HEAD);
const V = 12;
const PRE = 11;
const REGISTRY = "registry.cloudflare.com/0123456789abcdef0123456789abcdef/switchboard-sandbox-switchboardsandbox";
const OLD_IMAGE = `${REGISTRY}@sha256:23e69f9ee5513879b8a44019e9a21b2981cf81bb242236955a0dc59ee96f5367`;
const NEW_IMAGE = `${REGISTRY}@sha256:eb7d4f2863a3ccd1970d76c5505402bd458ffdaacbb6bf777afdcbedf465ef2f`;
const before: Read<AppState> = { value: { version: PRE, image: OLD_IMAGE } };
const after: Read<AppState> = { value: { version: V, image: NEW_IMAGE } };
const rollout: SandboxRollout = { before, target: { image: NEW_IMAGE } };
const gate = workersFor(TEST_PROFILE).find((w) => w.name === "sandbox")!.liveGate as SandboxLiveGate;
const SANDBOX_HEALTH_URL = "https://switchboard-sandbox.example.test/healthz";
const SANDBOX_CONTAINER_APP = "switchboard-sandbox-switchboardsandbox";
const step = { name: "sandbox" as const, dir: "deploy/cloudflare-sandbox" };

const serving = (commit: string): HealthRead => ({ status: 200, body: { ok: true, build: { commit } } });
const inst = (name: string | null, state: string, version: number | null = V): ContainerInstance => ({
  name,
  state,
  version,
});
const settled = (...extra: ContainerInstance[]): Read<ContainerInstance[]> => ({
  value: [inst("slack:C1234567890:1788824120.915519", "running"), inst(KEY, "running"), ...extra],
});
/** The fleet before the rollout moved anything: every instance on the pre-deploy version. */
const preDeployFleet: Read<ContainerInstance[]> = {
  value: [inst("slack:C1234567890:1788824120.915519", "running", PRE), inst(KEY, "running", PRE)],
};
const ok: ProbeResult = { body: { stdout: "ok\n", stderr: "", exitCode: 0 } };
const fleetBusy: ProbeResult = {
  body: { error: "fleet-busy: …", reason: "fleet-busy", stdout: "", stderr: "", exitCode: 127 },
};
const LIVE_DETAIL = `Worker serves e6af1aa; rollout complete (2 running instance(s) on version 12, up from 11); probe \`echo ok\` exit 0 from ${KEY} (version 12)`;

interface Scripted {
  /** Successive answers per dep; the last one repeats. */
  health: HealthRead[];
  probe?: ProbeResult[];
  appState?: Read<AppState>[];
  instances?: Read<ContainerInstance[]>[];
}

function harness(script: Scripted, env: Record<string, string> = { SANDBOX_TOKEN: "tok-sandbox" }) {
  const calls: { dep: string; args: unknown[] }[] = [];
  const lines: string[] = [];
  const idx: Record<string, number> = {};
  let clock = 0;
  const next = <T>(dep: string, arr: T[] | undefined, fallback: T): T => {
    const i = idx[dep] ?? 0;
    idx[dep] = i + 1;
    return arr ? arr[Math.min(i, arr.length - 1)] : fallback;
  };
  const deps: SandboxGateDeps = {
    env,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    readHealth: async (...args) => {
      calls.push({ dep: "readHealth", args });
      return next("health", script.health, { error: "unscripted" });
    },
    probeExec: async (...args) => {
      calls.push({ dep: "probeExec", args });
      return next("probe", script.probe, ok);
    },
    readAppState: async (...args) => {
      calls.push({ dep: "readAppState", args });
      return next("appState", script.appState, after);
    },
    readInstances: async (...args) => {
      calls.push({ dep: "readInstances", args });
      return next("instances", script.instances, settled());
    },
  };
  const io = { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(`WARN ${l}`), stream: () => {} };
  const count = (dep: string) => calls.filter((c) => c.dep === dep).length;
  /** The runner's own lines, without the span log lines `deployStep` writes to the same output. */
  const plain = () => lines.filter((l) => !l.startsWith("{"));
  /** The span log lines, parsed (docs/reference/specs/tracing.md item 20). */
  const spans = () => lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as LogLine);
  return { deps, io, calls, lines, count, plain, spans };
}

describe("waitUntilSandboxLive", () => {
  it("refuses without the bearer in the env — nothing is read or probed", async () => {
    const h = harness({ health: [serving(HEAD)] }, {});
    expect(await waitUntilSandboxLive(step, gate, HEAD, rollout, h.io, h.deps)).toEqual({
      live: false,
      reason: "SANDBOX_TOKEN is not set — the sandbox live gate reads /healthz and probes /exec with it",
    });
    expect(h.calls).toEqual([]);
    expect(gate.bearerEnv).toBe(SANDBOX_BEARER_ENV);
  });

  it("live once every signal agrees: the Worker is read with the bearer, then the probe goes to /exec on the gate's thread BEFORE the application and its instances are read, and the summary names all three", async () => {
    const h = harness({ health: [serving(HEAD)] });
    const r = await waitUntilSandboxLive(step, gate, HEAD, rollout, h.io, h.deps);
    expect(r).toEqual({ live: true, waitedMs: 0, detail: LIVE_DETAIL });
    expect(h.calls.map((c) => c.dep)).toEqual(["readHealth", "probeExec", "readAppState", "readInstances"]);
    expect(h.calls[0].args).toEqual([SANDBOX_HEALTH_URL, "tok-sandbox"]);
    expect(gate).toEqual({
      kind: "sandbox",
      healthUrl: SANDBOX_HEALTH_URL,
      bearerEnv: SANDBOX_BEARER_ENV,
      containerApp: SANDBOX_CONTAINER_APP,
    });
    expect(h.calls[1].args).toEqual(["https://switchboard-sandbox.example.test/exec", "tok-sandbox", KEY]);
    expect(h.calls[2].args).toEqual(["deploy/cloudflare-sandbox", SANDBOX_CONTAINER_APP]);
    expect(h.calls[3].args).toEqual(["deploy/cloudflare-sandbox", SANDBOX_CONTAINER_APP]);
    expect(h.lines).toEqual([]);
  });

  it("while the Worker still serves the old commit only /healthz is read — no probe, no wrangler — and each poll logs the reason", async () => {
    const h = harness({ health: [serving(OLD), { status: 502, body: undefined }, serving(HEAD)] });
    const r = await waitUntilSandboxLive(step, gate, HEAD, rollout, h.io, h.deps);
    expect(r).toMatchObject({ live: true, waitedMs: 2 * LIVE_GATE_POLL_MS });
    expect(h.count("readHealth")).toBe(3);
    expect(h.count("probeExec")).toBe(1);
    expect(h.count("readAppState")).toBe(1);
    expect(h.lines).toEqual([
      "[deploy:all] sandbox: deployed, not live yet — Worker: serving commit 610682f, expected e6af1aa (old container still up) (0m 0s)",
      "[deploy:all] sandbox: deployed, not live yet — Worker: /healthz not answering with JSON (container restarting, or unreachable) (0m 15s)",
    ]);
  });

  it("the application still at the pre-deploy version for two polls — instances all on it, probe ok — is waiting both times; live on the third poll, once it advanced and the instances followed", async () => {
    const h = harness({
      health: [serving(HEAD)],
      appState: [before, before, after],
      instances: [preDeployFleet, preDeployFleet, settled()],
    });
    const r = await waitUntilSandboxLive(step, gate, HEAD, rollout, h.io, h.deps);
    expect(r).toEqual({ live: true, waitedMs: 2 * LIVE_GATE_POLL_MS, detail: LIVE_DETAIL });
    expect(h.count("readAppState")).toBe(3);
    expect(h.count("probeExec")).toBe(3);
    expect(h.lines).toEqual([
      "[deploy:all] sandbox: deployed, not live yet — rollout: application still at pre-deploy version 11 / image sha256:23e69f9e — the deploy's new version is not registered yet (0m 0s)",
      "[deploy:all] sandbox: deployed, not live yet — rollout: application still at pre-deploy version 11 / image sha256:23e69f9e — the deploy's new version is not registered yet (0m 15s)",
    ]);
  });

  it("a Worker-only deploy (no target) is live against the current version at once — no advance awaited", async () => {
    const h = harness({ health: [serving(HEAD)], appState: [before], instances: [preDeployFleet] });
    const r = await waitUntilSandboxLive(step, gate, HEAD, { before, target: null }, h.io, h.deps);
    expect(r).toEqual({
      live: true,
      waitedMs: 0,
      detail: `Worker serves e6af1aa; Worker-only deploy — no container change (2 running instance(s) on version 11); probe \`echo ok\` exit 0 from ${KEY} (version 11)`,
    });
  });

  it("waits through a full fleet and a rollout in progress — the probe is re-sent on the SAME thread every poll (one fleet slot, not one per poll) — then goes live", async () => {
    const h = harness({
      health: [serving(HEAD)],
      probe: [fleetBusy, fleetBusy, ok],
      instances: [settled(inst("slack:old", "running", 11)), settled()],
    });
    const r = await waitUntilSandboxLive(step, gate, HEAD, rollout, h.io, h.deps);
    expect(r).toMatchObject({ live: true, waitedMs: 2 * LIVE_GATE_POLL_MS });
    const probes = h.calls.filter((c) => c.dep === "probeExec");
    expect(probes).toHaveLength(3);
    expect(new Set(probes.map((c) => c.args[2]))).toEqual(new Set([KEY]));
    expect(h.lines).toEqual([
      "[deploy:all] sandbox: deployed, not live yet — rollout in progress — 1 of 3 running instance(s) still on version 11, app version 12 (0m 0s)",
      "[deploy:all] sandbox: deployed, not live yet — probe: fleet busy — no free instance for the probe thread (max_instances reached) (0m 15s)",
    ]);
  });

  it("gives up at the live-gate deadline with the LAST reason (never a false success), polling every 15 s until then", async () => {
    const h = harness({
      health: [serving(HEAD)],
      probe: [{ body: { error: "", stdout: "", stderr: "", exitCode: 127 } }],
    });
    const r = await waitUntilSandboxLive(step, gate, HEAD, rollout, h.io, h.deps);
    expect(r).toEqual({
      live: false,
      reason:
        "probe: /exec failed with an EMPTY error — the probe's container may still run the previous image — still not live after 20 min (deadline 20 min)",
    });
    expect(h.count("readHealth")).toBe(LIVE_GATE_DEADLINE_MS / LIVE_GATE_POLL_MS + 1);
    expect(h.lines).toHaveLength(LIVE_GATE_DEADLINE_MS / LIVE_GATE_POLL_MS);
  });

  it("a rejected bearer fails at once — no 20-minute wait on a credential", async () => {
    const h = harness({ health: [{ status: 401, body: { ok: false } }] });
    const r = await waitUntilSandboxLive(step, gate, HEAD, rollout, h.io, h.deps);
    expect(r).toEqual({
      live: false,
      reason: "Worker: GET /healthz → HTTP 401 — the SANDBOX_TOKEN bearer is rejected; waiting cannot fix a credential",
    });
    expect(h.calls.map((c) => c.dep)).toEqual(["readHealth"]);
  });
});

describe("deployStep (sandbox)", () => {
  const sandboxStep: DeployStep = {
    name: "sandbox",
    script: "switchboard-sandbox",
    dir: "deploy/cloudflare-sandbox",
    command: ["npm", "run", "deploy"],
    unsetEnv: ["CLOUDFLARE_ACCOUNT_ID"],
    setEnv: {},
    requiredEnv: [],
    capabilities: [],
    retryOnPreflightRefusal: false,
    liveGate: gate,
    why: "per-thread exec proxy",
  };
  const plan = { waitMaxMs: 30 * 60_000, pollMs: 60_000 };
  const diff = [
    "│ Container application changes",
    "├ EDIT switchboard-sandbox-switchboardsandbox",
    `│ -         "image": "${OLD_IMAGE}",`,
    `│ +         "image": "${NEW_IMAGE}",`,
    "╰ Applied changes ",
    "Current Version ID: 0c48b341-f216-4262-81c0-bc62ecb5669a",
  ].join("\n");
  const noChange =
    "│ Container application changes\n├ no changes x\n╰ No changes to be made\nCurrent Version ID: 0c48b341-f216-4262-81c0-bc62ecb5669a";
  /** The step's command, recorded among the deps' calls so the order is visible. */
  const exec =
    (h: ReturnType<typeof harness>, output: string): StepExec =>
    async (s) => {
      h.calls.push({ dep: "exec", args: [s.command] });
      return { code: 0, output };
    };

  it("reads the application BEFORE the deploy command runs, takes the rollout target from what the command printed, and gates against both — polls name the pre-deploy version until it advanced", async () => {
    const h = harness({
      health: [serving(HEAD)],
      appState: [before, before, before, after],
      instances: [preDeployFleet, preDeployFleet, settled()],
    });
    const r = await deployStep(sandboxStep, plan, HEAD, h.io, h.deps, exec(h, diff));
    expect(r).toEqual({ ok: true, versionId: "0c48b341-f216-4262-81c0-bc62ecb5669a", live: "live" });
    expect(h.calls.map((c) => c.dep).slice(0, 6)).toEqual([
      "readAppState",
      "exec",
      "readHealth",
      "probeExec",
      "readAppState",
      "readInstances",
    ]);
    expect(h.calls[0].args).toEqual(["deploy/cloudflare-sandbox", SANDBOX_CONTAINER_APP]);
    expect(h.calls[1].args).toEqual([["npm", "run", "deploy"]]);
    expect(h.count("readAppState")).toBe(4);
    expect(h.plain()).toEqual([
      "\n[deploy:all] ▶ sandbox (switchboard-sandbox) — deploy/cloudflare-sandbox: npm run deploy",
      "[deploy:all] sandbox: container application at version 11 (image sha256:23e69f9e) before the upload",
      "[deploy:all] sandbox: version 0c48b341-f216-4262-81c0-bc62ecb5669a uploaded — waiting until live (commit e6af1aa)",
      "[deploy:all] sandbox: wrangler printed a container change — image sha256:eb7d4f28; the application must leave version 11",
      "[deploy:all] sandbox: deployed, not live yet — rollout: application still at pre-deploy version 11 / image sha256:23e69f9e — the deploy's new version is not registered yet (0m 0s)",
      "[deploy:all] sandbox: deployed, not live yet — rollout: application still at pre-deploy version 11 / image sha256:23e69f9e — the deploy's new version is not registered yet (0m 15s)",
      `[deploy:all] sandbox: live (${LIVE_DETAIL}; 30s after the upload)`,
    ]);
  });

  // Feature: docs/reference/specs/tracing.md item 20; docs/reference/specs/release-and-deploy.md item
  // 19 — the step is a root on the runner's own log and its live gate a child
  // whose `waitedMs` is the number the "live" line prints.
  it("the step is a `deploy.step.sandbox` root on the runner's log and its live gate a `deploy.wait_live` child whose waitedMs is the seconds the live line prints", async () => {
    const h = harness({
      health: [serving(HEAD)],
      appState: [before, before, before, after],
      instances: [preDeployFleet, preDeployFleet, settled()],
    });
    await deployStep(sandboxStep, plan, HEAD, h.io, h.deps, exec(h, diff));
    const spans = h.spans();
    expect(spans.map((s) => s.span)).toEqual(["deploy.wait_live", "deploy.step.sandbox"]);
    const [wait, step] = spans as [LogLine, LogLine];
    expect(wait.parentSpanId).toBe(step.spanId);
    expect(step.parentSpanId).toBeUndefined();
    expect(wait).toMatchObject({ status: "ok", ms: 30_000, attrs: { outcome: "live", waitedMs: 30_000 } });
    expect(h.plain().at(-1)).toContain(`${Math.round((wait.attrs.waitedMs as number) / 1000)}s after the upload`);
    expect(step).toMatchObject({ status: "ok", attrs: { outcome: "live" } });
    // The line carries the documented fields and no text.
    for (const s of spans) expect(Object.keys(s).filter((k) => ["text", "summary", "output"].includes(k))).toEqual([]);
    // The step root's line comes after every plain line: it ends last.
    expect(h.lines.at(-1)?.startsWith("{")).toBe(true);
  });

  it("a deploy that printed no container change is a Worker-only deploy: the pre-deploy read still happens, no advance is awaited, and the log says so", async () => {
    const h = harness({ health: [serving(HEAD)], appState: [before], instances: [preDeployFleet] });
    const r = await deployStep(sandboxStep, plan, HEAD, h.io, h.deps, exec(h, noChange));
    expect(r).toEqual({ ok: true, versionId: "0c48b341-f216-4262-81c0-bc62ecb5669a", live: "live" });
    expect(h.calls.map((c) => c.dep)).toEqual([
      "readAppState",
      "exec",
      "readHealth",
      "probeExec",
      "readAppState",
      "readInstances",
    ]);
    expect(h.lines).toContain(
      "[deploy:all] sandbox: wrangler printed no container change — Worker-only deploy, no rollout expected",
    );
    expect(h.plain().at(-1)).toBe(
      `[deploy:all] sandbox: live (Worker serves e6af1aa; Worker-only deploy — no container change (2 running instance(s) on version 11); probe \`echo ok\` exit 0 from ${KEY} (version 11); 0s after the upload)`,
    );
  });

  it("a failed pre-deploy read is logged and carried into the gate (waiting with wrangler's words until the diff's image shows), never a refusal to deploy", async () => {
    const unread: Read<AppState> = { error: "wrangler containers info failed: exit 1" };
    const h = harness({
      health: [serving(HEAD)],
      appState: [unread, before, after],
      instances: [preDeployFleet, settled()],
    });
    const r = await deployStep(sandboxStep, plan, HEAD, h.io, h.deps, exec(h, diff));
    expect(r).toEqual({ ok: true, versionId: "0c48b341-f216-4262-81c0-bc62ecb5669a", live: "live" });
    expect(h.lines).toContain(
      "[deploy:all] sandbox: could not read the container application before the upload — wrangler containers info failed: exit 1; the gate will need the deploy's image to show",
    );
    expect(h.lines).toContain(
      "[deploy:all] sandbox: deployed, not live yet — rollout: pre-deploy version unreadable (wrangler containers info failed: exit 1); application image sha256:23e69f9e is not the deploy's sha256:eb7d4f28 (0m 0s)",
    );
  });

  it("a gate that never holds is the step's failure with the last reason — deployed but NOT live", async () => {
    const h = harness({ health: [serving(HEAD)], appState: [before], instances: [preDeployFleet] });
    const r = await deployStep(sandboxStep, plan, HEAD, h.io, h.deps, exec(h, diff));
    expect(r).toEqual({
      ok: false,
      versionId: "0c48b341-f216-4262-81c0-bc62ecb5669a",
      live: "deployed, not live: rollout: application still at pre-deploy version 11 / image sha256:23e69f9e — the deploy's new version is not registered yet — still not live after 20 min (deadline 20 min)",
      reason:
        "deployed but NOT live — rollout: application still at pre-deploy version 11 / image sha256:23e69f9e — the deploy's new version is not registered yet — still not live after 20 min (deadline 20 min)",
    });
    // The step's root ends in error naming the outcome; the wait child says not_live and carries no waitedMs.
    expect(h.spans().map((s) => [s.span, s.status, s.attrs])).toEqual([
      ["deploy.wait_live", "ok", { outcome: "not_live" }],
      ["deploy.step.sandbox", "error", { outcome: "not_live" }],
    ]);
  });
});
