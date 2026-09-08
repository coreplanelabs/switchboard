import { describe, expect, it } from "vitest";
import { LIVE_GATE_DEADLINE_MS } from "./liveGate.js";
import {
  containerAppId,
  decideSandboxLive,
  decideWorker,
  parseAppState,
  parseExecStream,
  parseInstancesPage,
  parseWranglerJson,
  PROBE_COMMAND,
  probeThreadKey,
  rolloutTargetFromDeployOutput,
  type AppState,
  type ContainerInstance,
  type Read,
  type SandboxLiveInput,
} from "./sandboxLiveGate.js";

// docs/reference/specs/release-and-deploy.md item 16 — the sandbox is live when the Worker,
// the rollout and a probe agree. A sandbox deploy is two artifacts: the Worker
// upload is instant, the image rollout is not, so a thread created in between
// lands on a container still running the previous image and every exec fails
// with an EMPTY error while the deploy has said "deployed" and exited 0. And
// seconds after the upload the application can still report the PRE-deploy
// version — the deploy's version has not registered yet, so every running
// instance trivially matches it — which is why the rollout has a target: what
// wrangler's own diff said the application moves to, judged against what it
// was before the upload.

const HEAD = "e6af1aa0b7c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9";
const KEY = probeThreadKey(HEAD);
const APP_VERSION = 12;
const PRE_VERSION = 11;
const REGISTRY = "registry.cloudflare.com/0123456789abcdef0123456789abcdef/switchboard-sandbox-switchboardsandbox";
const OLD_IMAGE = `${REGISTRY}@sha256:23e69f9ee5513879b8a44019e9a21b2981cf81bb242236955a0dc59ee96f5367`;
const NEW_IMAGE = `${REGISTRY}@sha256:eb7d4f2863a3ccd1970d76c5505402bd458ffdaacbb6bf777afdcbedf465ef2f`;
const BEFORE: Read<AppState> = { value: { version: PRE_VERSION, image: OLD_IMAGE } };
const PRE_DEPLOY: Read<AppState> = BEFORE;
const AFTER: Read<AppState> = { value: { version: APP_VERSION, image: NEW_IMAGE } };

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
  inst("slack:C1234567890:1788824120.915519", "running"),
  inst("slack:C1234567890:1788820000.000001", "stopped", PRE_VERSION),
  inst(KEY, "running"),
  ...extra,
];
/** The fleet seconds after the upload: every instance still on the pre-deploy version. */
const preDeployFleet = (...extra: ContainerInstance[]) => [
  inst("slack:C1234567890:1788824120.915519", "running", PRE_VERSION),
  inst(KEY, "running", PRE_VERSION),
  ...extra,
];
const ok = { body: { stdout: "ok\n", stderr: "", exitCode: 0 } };

const input = (over: Partial<SandboxLiveInput> = {}): SandboxLiveInput => ({
  health: healthy(),
  app: AFTER,
  instances: { value: fleet() },
  probe: ok,
  probeThreadKey: KEY,
  deployedCommit: HEAD,
  before: BEFORE,
  target: { image: NEW_IMAGE },
  elapsedMs: 30_000,
  ...over,
});

describe("decideSandboxLive", () => {
  it("live only when the Worker serves the commit, the application left its pre-deploy version, every running instance is on the new version and the probe answered ok from an instance on it — and says all three", () => {
    const d = decideSandboxLive(input());
    expect(d).toEqual({
      kind: "live",
      summary: `Worker serves e6af1aa; rollout complete (2 running instance(s) on version 12, up from 11); probe \`echo ok\` exit 0 from ${KEY} (version 12)`,
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
        input({ health: healthy("610682f7abcdef0123456789"), app: null, instances: null, probe: null }),
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

  it("a target from wrangler's diff: while the application still reports the pre-deploy version and image the rollout is waiting — running instances all on that version, and a probe ok from one, prove nothing", () => {
    const stillBefore = input({ app: PRE_DEPLOY, instances: { value: preDeployFleet() } });
    expect(decideSandboxLive(stillBefore)).toEqual({
      kind: "waiting",
      reason:
        "rollout: application still at pre-deploy version 11 / image sha256:23e69f9e — the deploy's new version is not registered yet",
    });
    // The same wait when only the version is known before (image not reported), and when the diff
    // changed configuration without a new image (target without an image: only the version can advance).
    expect(
      decideSandboxLive(input({ app: { value: { version: PRE_VERSION, image: null } }, before: PRE_DEPLOY })),
    ).toEqual({
      kind: "waiting",
      reason: "rollout: application still at pre-deploy version 11 — the deploy's new version is not registered yet",
    });
    expect(decideSandboxLive({ ...stillBefore, target: { image: null } })).toMatchObject({
      kind: "waiting",
      reason: expect.stringContaining("still at pre-deploy version 11"),
    });
    // Never "complete" against the pre-deploy version when a target exists — even at the deadline it is a failure.
    expect(decideSandboxLive({ ...stillBefore, elapsedMs: LIVE_GATE_DEADLINE_MS })).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("application still at pre-deploy version 11"),
    });
  });

  it("live only after the version advanced AND the running instances and the probe's instance are on the new version — each remaining gap named in order", () => {
    // Version advanced, instances not yet replaced: the rollout is in progress.
    expect(decideSandboxLive(input({ instances: { value: preDeployFleet() } }))).toEqual({
      kind: "waiting",
      reason: "rollout in progress — 2 of 2 running instance(s) still on version 11, app version 12",
    });
    // Advanced and replaced, but the probe answered from the old one on its way out.
    const replaced = fleet().filter((i) => i.name !== KEY);
    expect(decideSandboxLive(input({ instances: { value: [...replaced, inst(KEY, "stopping", 11)] } }))).toEqual({
      kind: "waiting",
      reason: `probe instance ${KEY} is on version 11, app version 12 — the probe landed on a previous image`,
    });
    // A configuration-only change (no new image in the diff) advances by version alone.
    expect(decideSandboxLive(input({ target: { image: null } }))).toMatchObject({
      kind: "live",
      summary: expect.stringContaining("rollout complete (2 running instance(s) on version 12, up from 11)"),
    });
    // The version is the primary signal: a version above the pre-deploy one is an advance whatever the image reads.
    expect(decideSandboxLive(input({ app: { value: { version: APP_VERSION, image: null } } })).kind).toBe("live");
  });

  it("when the pre-deploy read failed, the diff's image is the only evidence: live once the application reports it, waiting (with wrangler's words) while it does not, and with no image printed the advance can never be told", () => {
    const unread: Read<AppState> = { error: "wrangler containers info failed: exit 1" };
    expect(decideSandboxLive(input({ before: unread }))).toEqual({
      kind: "live",
      summary: `Worker serves e6af1aa; rollout complete (2 running instance(s) on version 12, image sha256:eb7d4f28); probe \`echo ok\` exit 0 from ${KEY} (version 12)`,
    });
    expect(
      decideSandboxLive(input({ before: unread, app: PRE_DEPLOY, instances: { value: preDeployFleet() } })),
    ).toEqual({
      kind: "waiting",
      reason:
        "rollout: pre-deploy version unreadable (wrangler containers info failed: exit 1); application image sha256:23e69f9e is not the deploy's sha256:eb7d4f28",
    });
    expect(decideSandboxLive(input({ before: unread, target: { image: null } }))).toEqual({
      kind: "waiting",
      reason:
        "rollout: pre-deploy version unreadable (wrangler containers info failed: exit 1) and the deploy printed no image — cannot tell when the new version registers",
    });
  });

  it("a Worker-only deploy (wrangler printed no container change, target null) expects no advance: every running instance on the current version and a probe from one is live, a straggler is still a rollout in progress", () => {
    const workerOnly = input({ target: null, app: PRE_DEPLOY, instances: { value: preDeployFleet() } });
    expect(decideSandboxLive(workerOnly)).toEqual({
      kind: "live",
      summary: `Worker serves e6af1aa; Worker-only deploy — no container change (2 running instance(s) on version 11); probe \`echo ok\` exit 0 from ${KEY} (version 11)`,
    });
    expect(
      decideSandboxLive({ ...workerOnly, instances: { value: preDeployFleet(inst("slack:older", "running", 10)) } }),
    ).toEqual({
      kind: "waiting",
      reason: "rollout in progress — 1 of 3 running instance(s) still on version 10, app version 11",
    });
    // Whatever `before` read (or failed to), a Worker-only deploy never waits on it.
    expect(
      decideSandboxLive({ ...workerOnly, before: { error: "wrangler containers info failed: exit 1" } }).kind,
    ).toBe("live");
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

  it("an unreadable app state or instance list is waiting with wrangler's words, never live and never a hard failure", () => {
    expect(decideSandboxLive(input({ app: { error: "wrangler containers info failed: exit 1" } }))).toEqual({
      kind: "waiting",
      reason: "rollout: wrangler containers info failed: exit 1",
    });
    expect(decideSandboxLive(input({ instances: { error: "containers instances: no JSON" } }))).toEqual({
      kind: "waiting",
      reason: "rollout: containers instances: no JSON",
    });
    expect(decideSandboxLive(input({ app: null, instances: null }))).toEqual({
      kind: "waiting",
      reason: "rollout: not read yet",
    });
  });

  it("the probe: fleet-busy, a starting container, ANY in-body error (an EMPTY one included), a nonzero exit or the wrong stdout are all waiting, each named", () => {
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
      reason: "probe: /exec failed with an EMPTY error — the probe's container may still run the previous image",
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

  it("containerAppId finds the application by name; parseAppState reads the numeric version (string form accepted) and configuration.image (null when absent); no numeric version is null", () => {
    expect(containerAppId(listing, "switchboard-sandbox-switchboardsandbox")).toBe("9f8e7d6c");
    expect(containerAppId(listing, "switchboard-nope")).toBeUndefined();
    expect(containerAppId({ not: "an array" }, "x")).toBeUndefined();
    // The shape of `wrangler containers info <id> --json` after a rollout (reduced).
    const info = {
      id: "a030b6eb-42de-4c30-ad2b-e692327ca813",
      name: "switchboard-sandbox-switchboardsandbox",
      version: 12,
      instances: 7,
      max_instances: 25,
      configuration: { image: NEW_IMAGE, vcpu: 2, memory: "8GiB", network: { mode: "private" } },
      health: { instances: { healthy: 7, scheduling: 0 } },
    };
    expect(parseAppState(info)).toEqual({ version: 12, image: NEW_IMAGE });
    expect(parseAppState({ version: "13" })).toEqual({ version: 13, image: null });
    expect(parseAppState({ version: 13, configuration: { image: 42 } })).toEqual({ version: 13, image: null });
    expect(parseAppState({ version: "v13", configuration: { image: NEW_IMAGE } })).toBeNull();
    expect(parseAppState(undefined)).toBeNull();
  });

  it("rolloutTargetFromDeployOutput reads the image wrangler's `Container application changes` diff adds (the 0.5.0 log's shape, gutter and colours included); a diff without an image line is a target without one; `no changes`, a NEW application's snippet, or no containers section at all", () => {
    // wrangler's deploy output for a container change, verbatim (gutter included).
    const edit = [
      "0c48b341: digest: sha256:eb7d4f2863a3ccd1970d76c5505402bd458ffdaacbb6bf777afdcbedf465ef2f size: 4293",
      "╭ Deploy a container application deploy changes to your application",
      "│",
      "│ Container application changes",
      "│",
      "├ EDIT switchboard-sandbox-switchboardsandbox",
      "│",
      '│         "configuration": {',
      '│           "command": [],',
      '│           "entrypoint": [],',
      `│ -         "image": "${OLD_IMAGE}",`,
      `│ +         "image": "${NEW_IMAGE}",`,
      '│           "instance_type": "standard-3",',
      '│           "network": {',
      '│             "assign_ipv4": "none",',
      "│",
      "│",
      "│  SUCCESS  Modified application switchboard-sandbox-switchboardsandbox (Application ID: a030b6eb-42de-4c30-ad2b-e692327ca813)",
      "│",
      "╰ Applied changes ",
      "",
      "Deployed switchboard-sandbox triggers (0.98 sec)",
      "  switchboard-sandbox.example.test (custom domain)",
      "Current Version ID: 0c48b341-f216-4262-81c0-bc62ecb5669a",
    ].join("\n");
    expect(rolloutTargetFromDeployOutput(edit)).toEqual({ image: NEW_IMAGE });
    // A TTY colours the status and the diff signs; the target is the same.
    const esc = String.fromCharCode(27);
    const coloured = edit
      .replace("EDIT", `${esc}[4m${esc}[38;2;245;130;32mEDIT${esc}[39m${esc}[24m`)
      .replace(`+         "image"`, `${esc}[32m+         "image"`)
      .replace(`${NEW_IMAGE}",`, `${NEW_IMAGE}",${esc}[39m`);
    expect(rolloutTargetFromDeployOutput(coloured)).toEqual({ image: NEW_IMAGE });
    // Configuration changed without a new image: a new version is coming, its image unknown.
    const configOnly = edit
      .replace(`│ -         "image": "${OLD_IMAGE}",\n`, "")
      .replace(`│ +         "image": "${NEW_IMAGE}",`, `│           "image": "${OLD_IMAGE}",`)
      .replace(
        '│           "instance_type": "standard-3",',
        '│ -         "instance_type": "standard-2",\n│ +         "instance_type": "standard-3",',
      );
    expect(rolloutTargetFromDeployOutput(configOnly)).toEqual({ image: null });
    // The Worker-only deploy: the image rebuilt to the same digest, wrangler prints no diff.
    const unchanged = [
      "╭ Deploy a container application deploy changes to your application",
      "│",
      "│ Container application changes",
      "│",
      "├ no changes switchboard-sandbox-switchboardsandbox",
      "│",
      "╰ No changes to be made",
      "",
      "Current Version ID: 0c48b341-f216-4262-81c0-bc62ecb5669a",
    ].join("\n");
    expect(rolloutTargetFromDeployOutput(unchanged)).toBeNull();
    // A first deploy prints the whole application as a snippet under NEW — its image is the target.
    const created = [
      "│ Container application changes",
      "│",
      "├ NEW switchboard-sandbox-switchboardsandbox",
      '│   "containers": [',
      "│     {",
      '│       "configuration": {',
      `│         "image": "${NEW_IMAGE}",`,
      '│         "instance_type": "standard-3"',
      "│       },",
      '│       "max_instances": 25',
      "│     }",
      "│   ]",
      "│",
      "╰ Applied changes ",
    ].join("\n");
    expect(rolloutTargetFromDeployOutput(created)).toEqual({ image: NEW_IMAGE });
    // A Worker without containers, or a failed deploy: no section, no target.
    expect(rolloutTargetFromDeployOutput("Deployed switchboard-memory triggers\nCurrent Version ID: abc")).toBeNull();
    expect(rolloutTargetFromDeployOutput("")).toBeNull();
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
