import { describe, expect, it } from "vitest";
import { LIVE_GATE_DEADLINE_MS } from "./liveGate.js";
import {
  containerAppId,
  decideSandboxLive,
  decideWorker,
  parseAppVersion,
  parseExecStream,
  parseInstancesPage,
  parseWranglerJson,
  PROBE_COMMAND,
  probeThreadKey,
  type ContainerInstance,
  type SandboxLiveInput,
} from "./sandboxLiveGate.js";

// features/release-and-deploy.md item 16 — the sandbox is live when the Worker,
// the rollout and a probe agree. Incident 2026-09-07 (#569): a thread created
// 111 s after the Worker upload landed on a container still running the
// previous image and every exec failed with an EMPTY error for 90 s; the
// deploy had said "deployed" and exited 0.

const HEAD = "e6af1aa0b7c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9";
const KEY = probeThreadKey(HEAD);
const APP_VERSION = 12;

const healthy = (commit = HEAD) => ({
  status: 200,
  body: { ok: true, build: { commit, builtAt: "2026-09-07T23:33:53.000Z" } },
});
const inst = (name: string | null, state: string, version: number | null = APP_VERSION): ContainerInstance => ({
  name,
  state,
  version,
});
const fleet = (...extra: ContainerInstance[]) => [
  inst("slack:C0BQS7KPJHK:1788824120.915519", "running"),
  inst("slack:C0BQS7KPJHK:1788820000.000001", "stopped", 11),
  inst(KEY, "running"),
  ...extra,
];
const ok = { body: { stdout: "ok\n", stderr: "", exitCode: 0 } };

const input = (over: Partial<SandboxLiveInput> = {}): SandboxLiveInput => ({
  health: healthy(),
  appVersion: { value: APP_VERSION },
  instances: { value: fleet() },
  probe: ok,
  probeThreadKey: KEY,
  deployedCommit: HEAD,
  elapsedMs: 30_000,
  ...over,
});

describe("decideSandboxLive", () => {
  it("live only when the Worker serves the commit, every running instance is on the app version and the probe answered ok from an instance on it — and says all three", () => {
    const d = decideSandboxLive(input());
    expect(d).toEqual({
      kind: "live",
      summary: `Worker serves e6af1aa; rollout complete (2 running instance(s) on version 12); probe \`echo ok\` exit 0 from ${KEY} (version 12)`,
    });
    // Live is live regardless of elapsed time.
    expect(decideSandboxLive(input({ elapsedMs: LIVE_GATE_DEADLINE_MS * 2 })).kind).toBe("live");
    expect(PROBE_COMMAND).toBe("echo ok");
    expect(KEY).toBe(`deploy-gate:${HEAD}`);
  });

  it("the Worker first: an old commit, a non-JSON answer or a transport failure is waiting with decideLive's reason — the rollout and probe are not even consulted", () => {
    expect(decideSandboxLive(input({ health: healthy("610682f7abcdef0123456789") }))).toEqual({
      kind: "waiting",
      reason: "Worker: serving commit 610682f, expected e6af1aa (old container still up)",
    });
    expect(decideSandboxLive(input({ health: { status: 502, body: undefined } }))).toEqual({
      kind: "waiting",
      reason: "Worker: /healthz not answering with JSON (container restarting, or unreachable)",
    });
    expect(decideSandboxLive(input({ health: { error: "fetch failed" } }))).toEqual({
      kind: "waiting",
      reason: "Worker: GET /healthz failed: fetch failed",
    });
    // The same verdict with nothing else read — what the runner passes while the Worker is not live yet.
    expect(
      decideSandboxLive(
        input({ health: healthy("610682f7abcdef0123456789"), appVersion: null, instances: null, probe: null }),
      ),
    ).toMatchObject({ kind: "waiting", reason: expect.stringContaining("Worker: serving commit 610682f") });
  });

  it("a rejected bearer fails at once — waiting cannot fix a credential", () => {
    for (const status of [401, 403]) {
      expect(decideSandboxLive(input({ health: { status, body: { ok: false } } }))).toEqual({
        kind: "failed",
        reason: `Worker: GET /healthz → HTTP ${status} — the SANDBOX_TOKEN bearer is rejected; waiting cannot fix a credential`,
      });
    }
    expect(decideWorker({ status: 401, body: undefined }, HEAD)).toMatchObject({ ok: false, fatal: true });
    expect(decideWorker(healthy(), HEAD)).toEqual({ ok: true, commit: HEAD });
  });

  it("rollout in progress: a RUNNING instance on another version (or an unknown one) keeps it waiting, naming the counts and versions; stopped/stopping/failed/provisioning instances on old versions are ignored", () => {
    const rolling = fleet(inst("slack:old-thread", "running", 11), inst("slack:older", "running", null));
    expect(decideSandboxLive(input({ instances: { value: rolling } }))).toEqual({
      kind: "waiting",
      reason: "rollout in progress — 2 of 4 running instance(s) still on version 11/?, app version 12",
    });
    const settling = fleet(
      inst("a", "stopping", 11),
      inst("b", "stopped", 11),
      inst("c", "failed", 11),
      inst("d", "provisioning", 11),
      inst("e", "unhealthy", 11),
    );
    expect(decideSandboxLive(input({ instances: { value: settling } })).kind).toBe("live");
    // No running instance at all is a complete rollout (the probe creates one).
    expect(
      decideSandboxLive(input({ instances: { value: [inst("x", "stopped", 11), inst(KEY, "stopping")] } })).kind,
    ).toBe("live");
  });

  it("an unreadable app version or instance list is waiting with wrangler's words, never live and never a hard failure", () => {
    expect(decideSandboxLive(input({ appVersion: { error: "wrangler containers info failed: exit 1" } }))).toEqual({
      kind: "waiting",
      reason: "rollout: wrangler containers info failed: exit 1",
    });
    expect(decideSandboxLive(input({ instances: { error: "containers instances: no JSON" } }))).toEqual({
      kind: "waiting",
      reason: "rollout: containers instances: no JSON",
    });
    expect(decideSandboxLive(input({ appVersion: null, instances: null }))).toEqual({
      kind: "waiting",
      reason: "rollout: not read yet",
    });
  });

  it("the probe: fleet-busy, a starting container, ANY in-body error (the empty #569 shape included), a nonzero exit or the wrong stdout are all waiting, each named", () => {
    const probe = (body: Record<string, unknown>) => decideSandboxLive(input({ probe: { body } }));
    expect(probe({ error: "fleet-busy: …", reason: "fleet-busy", stdout: "", stderr: "", exitCode: 127 })).toEqual({
      kind: "waiting",
      reason: "probe: fleet busy — no free instance for the probe thread (max_instances reached)",
    });
    expect(probe({ error: "Container is starting. Please retry in a moment.", exitCode: 127 })).toEqual({
      kind: "waiting",
      reason: "probe: container starting",
    });
    expect(probe({ error: "", stdout: "", stderr: "", exitCode: 127 })).toEqual({
      kind: "waiting",
      reason: "probe: /exec failed with an EMPTY error — the probe's container may still run the previous image (#569)",
    });
    expect(probe({ error: "sandbox recycled mid-command after 61s — …", exitCode: 127 })).toEqual({
      kind: "waiting",
      reason: "probe: /exec failed — sandbox recycled mid-command after 61s — …",
    });
    expect(probe({ stdout: "", stderr: "bash: echo: not found", exitCode: 127 })).toEqual({
      kind: "waiting",
      reason: "probe: `echo ok` exited 127: bash: echo: not found",
    });
    expect(probe({ stdout: "", stderr: "", exitCode: 124 })).toEqual({
      kind: "waiting",
      reason: "probe: `echo ok` exited 124",
    });
    expect(probe({ stdout: "nope\n", stderr: "", exitCode: 0 })).toEqual({
      kind: "waiting",
      reason: 'probe: `echo ok` printed "nope"',
    });
    expect(decideSandboxLive(input({ probe: { error: "POST /exec → HTTP 502: <html>" } }))).toEqual({
      kind: "waiting",
      reason: "probe: POST /exec → HTTP 502: <html>",
    });
    expect(decideSandboxLive(input({ probe: null }))).toEqual({ kind: "waiting", reason: "probe: not sent yet" });
  });

  it("a probe that answered from an instance not yet listed, or listed on a previous version, is waiting — ok from the old image proves nothing", () => {
    const without = fleet().filter((i) => i.name !== KEY);
    expect(decideSandboxLive(input({ instances: { value: without } }))).toEqual({
      kind: "waiting",
      reason: `probe instance ${KEY} not listed yet`,
    });
    // A RUNNING probe instance on an old version is already "rollout in progress"; the probe-specific
    // reason is for the instance the rollout is replacing right after it answered.
    expect(decideSandboxLive(input({ instances: { value: [...without, inst(KEY, "stopping", 11)] } }))).toEqual({
      kind: "waiting",
      reason: `probe instance ${KEY} is on version 11, app version 12 — the probe landed on a previous image`,
    });
  });

  it("the last waiting reason becomes a failure at the shared live-gate deadline (20 min), never before", () => {
    const rolling = input({ instances: { value: fleet(inst("t", "running", 11)) } });
    expect(decideSandboxLive({ ...rolling, elapsedMs: LIVE_GATE_DEADLINE_MS - 1 }).kind).toBe("waiting");
    expect(decideSandboxLive({ ...rolling, elapsedMs: LIVE_GATE_DEADLINE_MS })).toEqual({
      kind: "failed",
      reason:
        "rollout in progress — 1 of 3 running instance(s) still on version 11, app version 12 — still not live after 20 min (deadline 20 min)",
    });
    expect(LIVE_GATE_DEADLINE_MS).toBe(20 * 60_000);
  });
});

describe("wrangler and /exec parsers", () => {
  const banner = " ⛅️ wrangler 4.129.1\n───────────────────\n";
  const listing = [
    { id: "0a1b2c3d", name: "switchboard-switchboardserver", version: 40 },
    { id: "9f8e7d6c", name: "switchboard-sandbox-switchboardsandbox", version: APP_VERSION },
  ];

  it("parseWranglerJson skips the banner and reads an array or an object; garbage is undefined", () => {
    expect(parseWranglerJson(`${banner}${JSON.stringify(listing)}`)).toEqual(listing);
    expect(parseWranglerJson(`${banner}{"version":12}`)).toEqual({ version: 12 });
    expect(parseWranglerJson(JSON.stringify(listing))).toEqual(listing);
    expect(parseWranglerJson("✘ [ERROR] Authentication error [code: 10000]")).toBeUndefined();
    expect(parseWranglerJson(`${banner}[not json`)).toBeUndefined();
  });

  it("containerAppId finds the application by name; parseAppVersion reads a numeric version (string form accepted)", () => {
    expect(containerAppId(listing, "switchboard-sandbox-switchboardsandbox")).toBe("9f8e7d6c");
    expect(containerAppId(listing, "switchboard-nope")).toBeUndefined();
    expect(containerAppId({ not: "an array" }, "x")).toBeUndefined();
    expect(parseAppVersion({ id: "9f8e7d6c", version: 12, configuration: { image: "registry/…:abc" } })).toBe(12);
    expect(parseAppVersion({ version: "13" })).toBe(13);
    expect(parseAppVersion({ version: "v13" })).toBeNull();
    expect(parseAppVersion(undefined)).toBeNull();
  });

  it("parseInstancesPage reads the bare array wrangler prints unpaginated AND the {instances, result_info} shape --per-page switches to, keeping name/state/version and the next page token", () => {
    const rows = [
      { id: "i1", name: KEY, state: "running", location: "sjc", version: 12, created: "2026-09-07T23:35:00Z" },
      { id: null, name: "slack:old", state: "inactive", location: null, version: null, created: null },
      { id: "i3", state: "provisioning", version: "12" }, // no DO name (a bare-instances listing)
    ];
    expect(parseInstancesPage(rows)).toEqual({
      rows: [inst(KEY, "running", 12), inst("slack:old", "inactive", null), inst(null, "provisioning", 12)],
      nextPageToken: null,
    });
    expect(
      parseInstancesPage({ instances: rows.slice(0, 1), result_info: { per_page: 100, next_page_token: "tok2" } }),
    ).toEqual({ rows: [inst(KEY, "running", 12)], nextPageToken: "tok2" });
    expect(parseInstancesPage({ instances: [], result_info: { next_page_token: null } })).toEqual({
      rows: [],
      nextPageToken: null,
    });
    expect(parseInstancesPage({ error: "nope" })).toBeUndefined();
    expect(parseInstancesPage(undefined)).toBeUndefined();
  });

  it("parseExecStream reads the one JSON document after the whitespace heartbeats; anything else is a named error", () => {
    expect(parseExecStream('   \n \n{"stdout":"ok\\n","stderr":"","exitCode":0}\n')).toEqual(ok);
    expect(parseExecStream('{"error":"","stdout":"","stderr":"","exitCode":127}')).toEqual({
      body: { error: "", stdout: "", stderr: "", exitCode: 127 },
    });
    expect(parseExecStream("   ")).toEqual({ error: '/exec answered no JSON document: ""' });
    expect(parseExecStream("<html>502</html>")).toMatchObject({ error: expect.stringContaining("no JSON document") });
    expect(parseExecStream("[1]")).toEqual({ error: "/exec answered non-object JSON: [1]" });
  });
});
