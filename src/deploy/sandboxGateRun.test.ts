import { describe, expect, it } from "vitest";
import { LIVE_GATE_DEADLINE_MS, LIVE_GATE_POLL_MS } from "./liveGate.js";
import { SANDBOX_BEARER_ENV, workersFor, type SandboxLiveGate } from "./plan.js";
import { waitUntilSandboxLive, type SandboxGateDeps } from "./run.js";
import {
  probeThreadKey,
  type ContainerInstance,
  type HealthRead,
  type ProbeResult,
  type Read,
} from "./sandboxLiveGate.js";
import { TEST_PROFILE } from "./testing/profile.js";

// The sandbox live gate's LOOP (src/deploy/run.ts `waitUntilSandboxLive`,
// features/release-and-deploy.md item 16): read the Worker's /healthz with the
// bearer; once it serves the deployed commit, probe `echo ok` through the gate's
// thread and read the container application's version and instances; live only
// when all three agree, waiting through everything a rollout can cause, failing
// at the shared deadline with the last reason. Every I/O is injected: nothing
// here reaches the network, wrangler or the clock.

const HEAD = "e6af1aa0b7c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9";
const OLD = "610682f7abcdef0123456789abcdef0123456789";
const KEY = probeThreadKey(HEAD);
const V = 12;
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
  value: [inst("slack:C0BQS7KPJHK:1788824120.915519", "running"), inst(KEY, "running"), ...extra],
});
const ok: ProbeResult = { body: { stdout: "ok\n", stderr: "", exitCode: 0 } };
const fleetBusy: ProbeResult = {
  body: { error: "fleet-busy: …", reason: "fleet-busy", stdout: "", stderr: "", exitCode: 127 },
};

interface Scripted {
  /** Successive answers per dep; the last one repeats. */
  health: HealthRead[];
  probe?: ProbeResult[];
  appVersion?: Read<number>[];
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
    readAppVersion: async (...args) => {
      calls.push({ dep: "readAppVersion", args });
      return next("appVersion", script.appVersion, { value: V });
    },
    readInstances: async (...args) => {
      calls.push({ dep: "readInstances", args });
      return next("instances", script.instances, settled());
    },
  };
  const io = { log: (l: string) => lines.push(l) };
  const count = (dep: string) => calls.filter((c) => c.dep === dep).length;
  return { deps, io, calls, lines, count };
}

describe("waitUntilSandboxLive", () => {
  it("refuses without the bearer in the env — nothing is read or probed", async () => {
    const h = harness({ health: [serving(HEAD)] }, {});
    expect(await waitUntilSandboxLive(step, gate, HEAD, h.io, h.deps)).toEqual({
      live: false,
      reason: "SANDBOX_TOKEN is not set — the sandbox live gate reads /healthz and probes /exec with it",
    });
    expect(h.calls).toEqual([]);
    expect(gate.bearerEnv).toBe(SANDBOX_BEARER_ENV);
  });

  it("live once every signal agrees: the Worker is read with the bearer, then the probe goes to /exec on the gate's thread BEFORE the instances are listed, and the summary names all three", async () => {
    const h = harness({ health: [serving(HEAD)] });
    const r = await waitUntilSandboxLive(step, gate, HEAD, h.io, h.deps);
    expect(r).toEqual({
      live: true,
      waitedMs: 0,
      detail: `Worker serves e6af1aa; rollout complete (2 running instance(s) on version 12); probe \`echo ok\` exit 0 from ${KEY} (version 12)`,
    });
    expect(h.calls.map((c) => c.dep)).toEqual(["readHealth", "probeExec", "readAppVersion", "readInstances"]);
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
    const r = await waitUntilSandboxLive(step, gate, HEAD, h.io, h.deps);
    expect(r).toMatchObject({ live: true, waitedMs: 2 * LIVE_GATE_POLL_MS });
    expect(h.count("readHealth")).toBe(3);
    expect(h.count("probeExec")).toBe(1);
    expect(h.count("readAppVersion")).toBe(1);
    expect(h.lines).toEqual([
      "[deploy:all] sandbox: deployed, not live yet — Worker: serving commit 610682f, expected e6af1aa (old container still up) (0m 0s)",
      "[deploy:all] sandbox: deployed, not live yet — Worker: /healthz not answering with JSON (container restarting, or unreachable) (0m 15s)",
    ]);
  });

  it("waits through a full fleet and a rollout in progress — the probe is re-sent on the SAME thread every poll (one fleet slot, not one per poll) — then goes live", async () => {
    const h = harness({
      health: [serving(HEAD)],
      probe: [fleetBusy, fleetBusy, ok],
      instances: [settled(inst("slack:old", "running", 11)), settled()],
    });
    const r = await waitUntilSandboxLive(step, gate, HEAD, h.io, h.deps);
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
    const r = await waitUntilSandboxLive(step, gate, HEAD, h.io, h.deps);
    expect(r).toEqual({
      live: false,
      reason:
        "probe: /exec failed with an EMPTY error — the probe's container may still run the previous image (#569) — still not live after 20 min (deadline 20 min)",
    });
    expect(h.count("readHealth")).toBe(LIVE_GATE_DEADLINE_MS / LIVE_GATE_POLL_MS + 1);
    expect(h.lines).toHaveLength(LIVE_GATE_DEADLINE_MS / LIVE_GATE_POLL_MS);
  });

  it("a rejected bearer fails at once — no 20-minute wait on a credential", async () => {
    const h = harness({ health: [{ status: 401, body: { ok: false } }] });
    const r = await waitUntilSandboxLive(step, gate, HEAD, h.io, h.deps);
    expect(r).toEqual({
      live: false,
      reason: "Worker: GET /healthz → HTTP 401 — the SANDBOX_TOKEN bearer is rejected; waiting cannot fix a credential",
    });
    expect(h.calls.map((c) => c.dep)).toEqual(["readHealth"]);
  });
});
