import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  baseConfigDocument,
  ConfigDocumentClient,
  sameConfigPublicationSnapshot,
  sha256Hex,
} from "../configDocument.js";
import { planDeploy, type WorkerName } from "./plan.js";
import {
  defaultRestartRunnerDeps,
  defaultSandboxGateDeps,
  pushConfigForServedConsumer,
  prepareConfigPublication,
  eligibleConfigPublicationConsumer,
  configSourceObservation,
  originalConfigSourceObservation,
  frozenLegacyConfigSourceInput,
  publishConfigPublication,
  pushConfigDocument,
  runDeployPlan,
  type SandboxGateDeps,
} from "./run.js";
import { TEST_PROFILE, TEST_MAINTENANCE } from "./testing/profile.js";
import { maintenanceProfileMaterial, type DeploymentProfile } from "./profile.js";
import * as configSources from "./configSource.js";
import { OPERATOR_ROOT } from "./host.js";

// Exercise the real runner's ordering. Only external process and rendering I/O
// are replaced: config reads, validation and conditional writes stay real.
const processes = vi.hoisted(() => ({
  workArea: "",
  calls: [] as string[],
  uploads: [] as { name: string; account: string; bucketConfig?: string }[],
  onMemory: () => {},
  onBot: () => {},
  onResident: () => {},
  onInstall: () => {},
  memoryCode: 0,
  botCode: 1,
  residentCode: 1,
  botOutput: undefined as string | undefined,
  residentOutput: undefined as string | undefined,
  wrangler: undefined as
    ((args: string[], env: Record<string, string>) => { output: string; code: number }) | undefined,
}));
vi.mock("./operatorRoot.js", async (original) => ({
  ...(await original<typeof import("./operatorRoot.js")>()),
  workPath: (_root: unknown, path: string) => join(processes.workArea, path),
}));
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => true,
    });
    queueMicrotask(() => {
      let output = "";
      let code = 0;
      if (cmd === "npx" && args[0] === "wrangler" && processes.wrangler) {
        ({ output, code } = processes.wrangler(args, opts.env));
      } else if (cmd === "git") output = "a".repeat(40);
      else if (args.includes("whoami")) output = TEST_PROFILE.account;
      else if (cmd === "npm" && args.includes("ci")) {
        processes.calls.push("install");
        processes.onInstall();
      } else if (cmd === "npm" && args.includes("deploy")) {
        const name = opts.cwd.endsWith("cloudflare-memory")
          ? "memory"
          : opts.cwd.endsWith("cloudflare-resident")
            ? "resident"
            : "bot";
        processes.calls.push(`upload:${name}`);
        const configIndex = args.indexOf("--config");
        processes.uploads.push({
          name,
          account:
            configIndex < 0
              ? "unbound"
              : (readFileSync(args[configIndex + 1]!, "utf8").match(/"account_id"\s*:\s*"([^"\n]+)"/)?.[1] ??
                "missing account"),
          bucketConfig: opts.env.SWITCHBOARD_DEPLOY_CONFIG,
        });
        if (name === "memory") {
          processes.onMemory();
          code = processes.memoryCode;
        } else {
          if (name === "resident") processes.onResident();
          else processes.onBot();
          code = name === "resident" ? processes.residentCode : processes.botCode;
        }
        output = code === 0 ? "Current Version ID: worker-version" : "upload failed";
        if (name !== "memory" && processes.botOutput !== undefined) output = processes.botOutput;
        if (name === "resident" && processes.residentOutput !== undefined) output = processes.residentOutput;
      }
      child.stdout.emit("data", Buffer.from(output));
      child.emit("close", code);
    });
    return child;
  },
}));

const otherAccount = "f".repeat(32);
const candidateText = `organization: example
defaults:
  agent: general
  models:
    general: test/general-model
providers:\n  test:\n    wire: openai-responses\n    apiKeyEnv: TEST_API_KEY\nrunHistory:\n  worker:\n    baseUrl: https://state.example\n    tokenEnv: MEMORY_TOKEN\ngrants:\n  'slack:UTEST':\n    actions: [all]\n`;
const read = () => ({ ok: true as const, text: candidateText, how: "config from private.yaml" });
const prior = baseConfigDocument("# original private config\n", "admin", new Date(0));
const successor = baseConfigDocument("# successor admin config\n", "admin", new Date(1));
function stateStore(document = prior, version = 4) {
  const state = { document: document as typeof prior | null, version };
  const slotState = { document: null as typeof prior | null, version: 0 };
  const calls: string[] = [];
  const snapshots = new Map<string, { document: unknown; version: number }>();
  const snapshotCalls: string[] = [];
  let snapshotAck: "positive" | "lost" | "mismatch" = "positive";
  let ack: "positive" | "lost" = "positive";
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(body.key).startsWith("deploy-base-")) {
      if (path === "/config/get") {
        snapshotCalls.push("get");
        const row = snapshots.get(body.key);
        return Response.json(row ?? { document: null, version: 0 });
      }
      snapshotCalls.push("put");
      if (snapshots.has(body.key)) return Response.json({ error: "conflict", version: 1 }, { status: 409 });
      snapshots.set(body.key, {
        document: snapshotAck === "mismatch" ? { ...body.document, candidate: successor } : body.document,
        version: 1,
      });
      return Response.json(snapshotAck === "lost" ? {} : { ok: true, version: 1 });
    }
    const row = body.key === "base" ? state : slotState;
    if (path === "/config/get") {
      calls.push("get");
      return Response.json(row);
    }
    if (path === "/config/put") {
      calls.push("put");
      const body = JSON.parse(String(init?.body));
      const source = body.sourcePrecondition;
      const sourceRow = source?.key === "base" ? state : slotState;
      if (body.expectedVersion !== row.version || (source && source.version !== sourceRow.version))
        return Response.json({ error: "version conflict", version: row.version }, { status: 409 });
      row.document = body.document;
      row.version++;
      if (ack === "lost") return Response.json({});
      return Response.json({ ok: true, version: row.version, ...(source ? { sourcePrecondition: source } : {}) });
    }
    return Response.json({ ok: true });
  };
  const target = {
    stateWorkerUrl: "https://state.example",
    key: "base",
    env: { MEMORY_TOKEN: "test" },
    fetch: fetchImpl,
    now: () => new Date(2),
  };
  return {
    state,
    slotState,
    calls,
    snapshots,
    snapshotCalls,
    loseSnapshotAck: () => {
      snapshotAck = "lost";
    },
    mismatchSnapshot: () => {
      snapshotAck = "mismatch";
    },
    target,
    fetchImpl,
    loseAck: () => {
      ack = "lost";
    },
  };
}
const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  processes.calls = [];
  processes.uploads = [];
  processes.onMemory = () => {};
  processes.memoryCode = 0;
  processes.botCode = 1;
  processes.residentCode = 1;
  processes.botOutput = undefined;
  processes.residentOutput = undefined;
  processes.wrangler = undefined;
  processes.onBot = () => {};
  processes.onResident = () => {};
  processes.onInstall = () => {};
});

function runner(
  store: ReturnType<typeof stateStore>,
  only: WorkerName[] = ["memory", "bot"],
  stateWorker = true,
  retained = false,
) {
  const dir = mkdtempSync(join(tmpdir(), "config-publication-"));
  dirs.push(dir);
  processes.workArea = dir;
  const source = join(dir, "candidate.yaml");
  writeFileSync(source, candidateText);
  const profile: DeploymentProfile = {
    ...TEST_PROFILE,
    configSource: source,
    workers: stateWorker ? TEST_PROFILE.workers : { bot: TEST_PROFILE.workers.bot },
  };
  if (retained) {
    profile.workers.resident = { script: "switchboard-staging-resident", hostname: "resident-staging.example.test" };
    profile.residentMaintenance = {
      ...TEST_MAINTENANCE,
      attempt: {
        ...TEST_MAINTENANCE.attempt,
        profileSha256: sha256Hex(maintenanceProfileMaterial(profile)),
        configSha256: sha256Hex(candidateText),
      },
    };
  }
  const profilePath = join(dir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile));
  vi.stubEnv("SWITCHBOARD_DEPLOY_PROFILE", profilePath);
  vi.stubEnv("MEMORY_TOKEN", "test");
  vi.stubGlobal("fetch", store.fetchImpl);
  const plan = planDeploy(
    {
      dryRun: false,
      force: false,
      allowBranch: true,
      only,
      skip: undefined,
      waitMaxMinutes: 1,
      pollSeconds: 1,
      ...(retained ? { retainMaintenance: true } : {}),
    },
    { root: { mode: "checkout", path: dir }, hasNodeModules: () => true },
    { profile, origin: "profile", path: profilePath },
    { mode: "build" },
  );
  plan.checks.cleanTree = false;
  const logs: string[] = [];
  const app = { value: { version: 3, image: "registry.example/bot:old" } } as const;
  const deps: SandboxGateDeps = {
    env: { RESIDENT_READ_TOKEN: "fixture" },
    now: () => 0,
    sleep: async () => {},
    readAppState: async () => app,
    readListedAppState: async () => app,
    readHealth: async (url) =>
      url.endsWith("/residents")
        ? { status: 200, body: { draining: null, count: 0, residents: [] } }
        : {
            status: 200,
            body: {
              ok: true,
              draining: false,
              features: { nativeRunScopes: "native-v1" },
              loadedBase: {
                schema: 1,
                source: { kind: "state", key: "base", version: 4 },
                sha256: prior.sha256,
                process: { commit: "b".repeat(40) },
              },
            },
          },
    readInstances: async () => ({ value: [{ name: "singleton", state: "running", version: 3 }] }),
    probeExec: async () => {
      throw new Error("not a sandbox deployment");
    },
  };
  return {
    plan,
    deps,
    io: { log: (s: string) => logs.push(s), warn: (s: string) => logs.push(s), stream: () => {} },
    logs,
    source,
    profilePath,
  };
}

describe("config publication inputs", () => {
  it("keeps candidate and prior bytes immutable while an upload races an admin write", async () => {
    const store = stateStore();
    const input = read();
    const prepared = await prepareConfigPublication(input, store.target);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.problem);
    input.text = "# changed source";
    store.state.document = successor;
    store.state.version++;
    expect(await publishConfigPublication(prepared.publication, store.target)).toMatchObject({
      ok: false,
      write: "not-written",
    });
    expect(store.state.document).toEqual(successor);
    expect(prepared.publication.candidate.yaml).toBe(candidateText);
    expect(prepared.publication.prior.document).toEqual(prior);
    expect(Object.isFrozen(prepared.publication.prior.document)).toBe(true);
    expect(store.calls).toEqual(["get", "put"]);
  });

  it("a fresh client recovers both exact input documents after the preparing process is gone", async () => {
    const store = stateStore();
    const prepared = await prepareConfigPublication(read(), store.target);
    if (!prepared.ok) throw new Error(prepared.problem);
    const key = prepared.publication.snapshotKey;
    const fresh = new ConfigDocumentClient({
      baseUrl: store.target.stateWorkerUrl,
      token: "test",
      fetch: store.fetchImpl,
    });
    const recovered = await fresh.readPublicationSnapshot(key);
    if (!recovered.ok) throw new Error(recovered.problem);
    expect(recovered.snapshot.priorDocument).toEqual(prior);
    expect(recovered.snapshot.candidate).toEqual(prepared.publication.candidate);
    expect(recovered.snapshot.expectedCandidateVersion).toBe(5);
    expect(store.calls).toEqual(["get"]);
  });

  it("does not mistake a successor with identical YAML for the original candidate witness", async () => {
    const store = stateStore();
    const prepared = await prepareConfigPublication(read(), store.target);
    if (!prepared.ok) throw new Error(prepared.problem);
    const fresh = new ConfigDocumentClient({
      baseUrl: store.target.stateWorkerUrl,
      token: "test",
      fetch: store.fetchImpl,
    });
    const recovered = await fresh.readPublicationSnapshot(prepared.publication.snapshotKey);
    if (!recovered.ok) throw new Error(recovered.problem);
    const rival = {
      ...recovered.snapshot,
      candidate: { ...recovered.snapshot.candidate, pushedAt: new Date(3).toISOString(), source: "rival" },
    };
    expect(rival.candidate.sha256).toBe(recovered.snapshot.candidate.sha256);
    expect(sameConfigPublicationSnapshot(rival, recovered.snapshot)).toBe(false);
  });

  it("two prepared writers retain their own inputs and only one publishes against the original base", async () => {
    const store = stateStore();
    const one = await prepareConfigPublication(read(), store.target);
    const two = await prepareConfigPublication({ ...read(), text: candidateText + "# another writer\n" }, store.target);
    if (!one.ok || !two.ok) throw new Error("preparation failed");
    expect(one.publication.snapshotKey).not.toBe(two.publication.snapshotKey);
    expect(await publishConfigPublication(one.publication, store.target)).toMatchObject({ ok: true, version: 5 });
    expect(await publishConfigPublication(two.publication, store.target)).toMatchObject({
      ok: false,
      write: "not-written",
    });
    expect(store.state.document).toEqual(one.publication.candidate);
    expect(store.snapshots.size).toBe(2);
  });

  it("refuses an oversized input snapshot before writing any document", async () => {
    const store = stateStore();
    expect(await prepareConfigPublication({ ...read(), text: "€".repeat(100 * 1024) }, store.target)).toMatchObject({
      ok: false,
    });
    expect(store.snapshotCalls).toEqual([]);
    expect(store.calls).toEqual(["get"]);
  });

  it("creates the first document only against an explicit canonical version zero", async () => {
    const store = stateStore();
    store.state.document = null;
    store.state.version = 0;
    expect(await pushConfigDocument(read(), store.target)).toMatchObject({ ok: true, version: 1 });
  });

  it("keeps the captured destination when mutable operation inputs change", async () => {
    const store = stateStore();
    const prepared = await prepareConfigPublication(read(), store.target);
    if (!prepared.ok) throw new Error(prepared.problem);
    store.target.key = "other";
    store.target.stateWorkerUrl = "https://changed.example";
    expect(await publishConfigPublication(prepared.publication, store.target)).toMatchObject({ ok: true, version: 5 });
    expect(prepared.publication.key).toBe("base");
    expect(prepared.publication.stateWorkerUrl).toBe("https://state.example");
    expect(store.calls).toEqual(["get", "put"]);
  });
});

describe("runDeployPlan config publication", () => {
  it("seals the retained Resident window before the same plan uploads Bot", async () => {
    const store = stateStore();
    const h = runner(store, ["memory", "resident", "bot"], true, true);
    for (const step of h.plan.steps) {
      step.requiredEnv = [];
      step.capabilities = [];
    }
    const maintenance = h.plan.steps.find((step) => step.name === "resident")!.maintenance!;
    const commit = "a".repeat(40);
    let clock = 0;
    let state = "fenced";
    const events: string[] = [];
    h.deps.now = () => clock;
    h.deps.sleep = async (ms) => {
      clock += ms;
    };
    h.deps.env.RESIDENT_DRAIN_TOKEN = "fixture";
    const oldHealth = h.deps.readHealth;
    h.deps.readHealth = async (url, ...args) => {
      if (url === "https://resident-staging.example.test/healthz")
        return { status: 200, body: { ok: true, build: { commit }, features: { nativeRunScopes: "native-v1" } } };
      if (url === "https://resident-staging.example.test/residents")
        return {
          status: 200,
          body: {
            draining: { holds: ["selected"] },
            count: 0,
            residents: [],
            stagingMaintenance: {
              schema: 1,
              state: "held",
              fixtureSha256: maintenance.fixtureSha256,
              decisionSha256: maintenance.decisionSha256,
              holdId: maintenance.holdId,
              generation: maintenance.generation,
              attempt: maintenance.attempt,
              window: {
                state,
                blocking: 0,
                excluded: 1,
                stored: 1,
                requestEnd: "unobserved",
                nativeOutcome: "unverified",
              },
            },
          },
        };
      return oldHealth(url, ...args);
    };
    h.deps.postJson = async (url) => {
      if (url.endsWith("/drain")) return { status: 200, body: { draining: { since: "start", until: "later" } } };
      if (url.endsWith("/staging-seal-window")) {
        state = "completed";
        events.push("seal");
        return { status: 200, body: { sealed: true } };
      }
      throw new Error("unexpected control request");
    };
    processes.residentCode = 0;
    processes.residentOutput =
      "Current Version ID: worker-version\nContainer application changes\nno changes switchboard-staging-resident-residentdo\nNo changes to be made";
    processes.onResident = () => {
      expect(store.slotState.document?.yaml).toBe(candidateText);
      events.push("resident upload");
    };
    processes.onBot = () => {
      expect(state).toBe("completed");
      events.push("bot upload");
    };
    const result = await runDeployPlan(h.plan, h.io, h.deps);
    expect(events, JSON.stringify(result)).toEqual(["resident upload", "seal", "bot upload"]);
    expect(processes.calls).toEqual(["upload:memory", "upload:resident", "upload:bot"]);
  });

  it("publishes the frozen configuration before Resident and keeps Bot unattempted after a Resident refusal", async () => {
    const store = stateStore();
    const h = runner(store, ["memory", "resident", "bot"]);
    for (const step of h.plan.steps) {
      step.requiredEnv = [];
      step.capabilities = [];
      step.retryOnPreflightRefusal = false;
    }
    h.deps.env.RESIDENT_DRAIN_TOKEN = "fixture";
    h.deps.postJson = async (url) =>
      url.endsWith("/undrain")
        ? { status: 200, body: { cleared: true, draining: null } }
        : { status: 200, body: { draining: { since: "start", until: "later" } } };
    let observed = false;
    processes.onResident = () => {
      observed = true;
      expect(store.slotState.document?.yaml).toBe(candidateText);
    };
    const result = await runDeployPlan(h.plan, h.io, h.deps);
    expect(observed).toBe(true);
    expect(processes.calls).toEqual(["upload:memory", "upload:resident"]);
    expect(result).toMatchObject({ kind: "ran", ok: false, notAttempted: ["bot"] });
    expect(store.state.document).toEqual(prior);
  });

  it("publishes the checked retained configuration even when its source changes after the read", async () => {
    const store = stateStore();
    const h = runner(store, ["memory", "bot", "resident"], true, true);
    vi.stubEnv("RESIDENT_DRAIN_TOKEN", "synthetic-drain");
    vi.stubEnv("RESIDENT_READ_TOKEN", "synthetic-read");
    const original = configSources.readConfigSource;
    let reads = 0;
    const reader = vi.spyOn(configSources, "readConfigSource").mockImplementation(async (...args) => {
      const value = await original(...args);
      reads++;
      if (reads === 1) writeFileSync(h.source, candidateText.replace("organization: example", "organization: changed"));
      return value;
    });
    try {
      const outcome = await runDeployPlan(h.plan, h.io, h.deps);
      if (outcome.kind !== "ran") throw new Error(JSON.stringify(outcome));
      expect(outcome).toMatchObject({ kind: "ran" });
      expect(
        [...store.snapshots.values()].map(
          (saved) => (saved.document as { candidate: { yaml: string } }).candidate.yaml,
        ),
      ).toEqual([candidateText]);
      expect(reads).toBe(1);
    } finally {
      reader.mockRestore();
    }
  });

  it("waits for lagging native singleton inventory before confirming the published config", async () => {
    const store = stateStore();
    const h = runner(store);
    const commit = "a".repeat(40);
    let uploaded = false;
    let newInventoryReads = 0;
    let clock = 0;
    processes.botCode = 0;
    processes.onBot = () => {
      uploaded = true;
    };
    const oldHealth = h.deps.readHealth;
    h.deps.now = () => clock;
    h.deps.sleep = async (ms) => {
      clock += ms;
    };
    h.deps.readAppState = async () => ({
      value: { version: uploaded ? 4 : 3, image: uploaded ? "registry.example/bot:new" : "registry.example/bot:old" },
    });
    h.deps.readHealth = async (...args) =>
      uploaded
        ? {
            status: 200,
            body: {
              ok: true,
              build: { commit },
              draining: false,
              loadedBase: {
                schema: 1,
                source: { kind: "state", key: `base-${commit}`, version: store.slotState.version },
                sha256: store.slotState.document?.sha256,
                process: { commit },
              },
            },
          }
        : oldHealth(...args);
    h.deps.readInstances = async () => {
      if (!uploaded) return { value: [{ name: "singleton", state: "running", version: 3 }] };
      newInventoryReads++;
      return { value: [{ name: "singleton", state: newInventoryReads < 3 ? "stopped" : "running", version: 4 }] };
    };
    const outcome = await runDeployPlan(h.plan, h.io, h.deps);
    expect(outcome).toMatchObject({ kind: "ran", ok: true });
    expect(store.slotState.document?.yaml).toBe(candidateText);
    expect(store.state.document).toEqual(prior);
    expect(store.slotState.version).toBe(1);
  });
  it("cancellation during an informational wake preserves a completed Memory upload without later Bot work", async () => {
    const store = stateStore();
    const h = runner(store);
    const control = new AbortController();
    h.deps.signal = control.signal;
    const phases: string[] = [];
    vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const path = new URL(String(url)).pathname;
      if (path === "/plane/deploy") {
        phases.push(JSON.parse(String(init?.body)).phase);
        return Response.json({ ok: true, admitted: 0 });
      }
      const response = await store.fetchImpl(url, init);
      if (path === "/healthz" && processes.calls.includes("upload:memory")) control.abort();
      return response;
    });
    expect(await runDeployPlan(h.plan, h.io, h.deps)).toEqual({
      kind: "ran",
      ok: false,
      results: [
        { name: "memory", script: "switchboard-memory", live: "n/a", status: "deployed (no version id in output?)" },
      ],
      notAttempted: ["bot"],
    });
    expect(phases).toEqual(["pending", "landed"]);
    expect(processes.calls).toEqual(["upload:memory"]);
    expect(store.state.document).toEqual(prior);
    expect(store.slotState.document).toBeNull();
  });

  it("an unconfirmed cancelled install retains its waiting window before any Worker upload", async () => {
    const root = OPERATOR_ROOT.root;
    try {
      for (const cancel of [false, true]) {
        const store = stateStore();
        const h = runner(store, ["bot"]);
        OPERATOR_ROOT.root = processes.workArea;
        const control = new AbortController();
        h.deps.signal = control.signal;
        processes.calls = [];
        processes.onInstall = () => {
          if (cancel) control.abort();
        };
        const phases: string[] = [];
        vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          if (new URL(String(url)).pathname === "/plane/deploy") {
            phases.push(JSON.parse(String(init?.body)).phase);
            return Response.json({ ok: true, admitted: 0 });
          }
          return store.fetchImpl(url, init);
        });
        const result = await runDeployPlan(h.plan, h.io, h.deps);
        expect(result).toMatchObject({
          kind: "ran",
          ok: false,
          results: [{ name: "bot", live: "not deployed", status: cancel ? "npm ci failed" : "FAILED: upload failed" }],
          notAttempted: [],
        });
        expect(phases).toEqual(cancel ? ["pending"] : ["pending", "landed"]);
        expect(processes.calls).toEqual(cancel ? ["install"] : ["install", "upload:bot"]);
        expect(store.state.document).toEqual(prior);
        expect(store.slotState.document?.yaml).toBe(candidateText);
      }
    } finally {
      OPERATOR_ROOT.root = root;
    }
  });

  it.each(["pending", "activation", "publication"])(
    "cancellation during %s before a Worker command closes only the waiting window",
    async (stage) => {
      const store = stateStore();
      const h = runner(store, ["bot"]);
      const control = new AbortController();
      h.deps.signal = control.signal;
      let nativeReads = 0;
      const readApp = h.deps.readAppState;
      h.deps.readAppState = async (...args) => {
        const result = await readApp(...args);
        if (stage === "activation" && ++nativeReads === 2) control.abort();
        return result;
      };
      const phases: string[] = [];
      vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const path = new URL(String(url)).pathname;
        if (path === "/plane/deploy") {
          const phase = JSON.parse(String(init?.body)).phase;
          phases.push(phase);
          if (stage === "pending" && phase === "pending") control.abort();
          return Response.json({ ok: true, admitted: 0 });
        }
        const result = await store.fetchImpl(url, init);
        if (
          stage === "publication" &&
          path === "/config/put" &&
          JSON.parse(String(init?.body)).key === `base-${"a".repeat(40)}`
        )
          control.abort();
        return result;
      });
      expect(await runDeployPlan(h.plan, h.io, h.deps)).toEqual({
        kind: "ran",
        ok: false,
        results: [],
        notAttempted: ["bot"],
      });
      expect(phases).toEqual(["pending", "landed"]);
      expect(processes.calls).toEqual([]);
      expect(store.state.document).toEqual(prior);
      expect(store.slotState.document?.yaml ?? null).toBe(stage === "publication" ? candidateText : null);
    },
  );

  it.each(["valid", "error", "malformed", "mismatch", "initial"])(
    "cancelled Bot %s pre-upload evidence closes the settled window without an upload",
    async (evidence) => {
      const store = stateStore();
      const h = runner(store, ["bot"]);
      h.plan.steps[0]!.botImage = "registry.example/bot:new";
      const control = new AbortController();
      h.deps.signal = control.signal;
      if (evidence === "initial") {
        const readApp = h.deps.readAppState;
        let reads = 0;
        h.deps.readAppState = async (...args) => {
          const result = await readApp(...args);
          if (++reads === 3) control.abort();
          return result;
        };
      }
      h.deps.readListedAppState = async () => {
        control.abort();
        return evidence === "error"
          ? { error: "read failed" }
          : evidence === "malformed"
            ? ({ value: {} } as never)
            : {
                value: {
                  version: evidence === "mismatch" ? 4 : 3,
                  image: evidence === "mismatch" ? "registry.example/bot:new" : "registry.example/bot:old",
                },
              };
      };
      const phases: string[] = [];
      vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (new URL(String(url)).pathname === "/plane/deploy") {
          phases.push(JSON.parse(String(init?.body)).phase);
          return Response.json({ ok: true, admitted: 0 });
        }
        return store.fetchImpl(url, init);
      });
      const result = await runDeployPlan(h.plan, h.io, h.deps);
      expect(result, JSON.stringify(result)).toMatchObject({
        kind: "ran",
        ok: false,
        results: [{ name: "bot", live: "not deployed" }],
      });
      expect(phases).toEqual(["pending", "landed"]);
      expect(processes.calls).toEqual([]);
      expect(store.state.document).toEqual(prior);
      expect(store.slotState.document?.yaml).toBe(candidateText);
    },
  );

  it.each(["valid", "error", "incomplete", "regressed"])(
    "cancelled Resident %s pre-upload evidence closes the settled window without an upload",
    async (evidence) => {
      const store = stateStore();
      const h = runner(store, ["resident", "bot"]);
      for (const step of h.plan.steps) {
        step.requiredEnv = [];
        step.capabilities = [];
      }
      const control = new AbortController();
      h.deps.signal = control.signal;
      const readApp = h.deps.readAppState;
      h.deps.readAppState = async (...args) => {
        if (args[0] !== "deploy/cloudflare-resident") return readApp(...args);
        control.abort();
        return evidence === "error"
          ? { error: "read failed" }
          : ({
              value:
                evidence === "incomplete"
                  ? { version: 17 }
                  : { version: evidence === "regressed" ? -1 : 17, image: "registry.example/resident:old" },
            } as never);
      };
      h.deps.env.RESIDENT_DRAIN_TOKEN = "fixture";
      h.deps.postJson = async (url) =>
        url.endsWith("/undrain")
          ? { status: 200, body: { cleared: true, draining: null } }
          : { status: 200, body: { draining: { since: "start", until: "later" } } };
      const phases: string[] = [];
      vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (new URL(String(url)).pathname === "/plane/deploy") {
          phases.push(JSON.parse(String(init?.body)).phase);
          return Response.json({ ok: true, admitted: 0 });
        }
        return store.fetchImpl(url, init);
      });
      const result = await runDeployPlan(h.plan, h.io, h.deps);
      expect(result, JSON.stringify(result)).toMatchObject({
        kind: "ran",
        ok: false,
        results: [{ name: "resident", live: "not deployed" }],
        notAttempted: ["bot"],
      });
      expect(phases).toEqual(["pending", "landed"]);
      expect(processes.calls).toEqual([]);
      expect(store.state.document).toEqual(prior);
      expect(store.slotState.document?.yaml).toBe(candidateText);
    },
  );

  it.each(["ack", "403", "409", "lost", "held"])(
    "cancellation during %s cleanup preserves completed no-upload settlement only",
    async (cleanup) => {
      const store = stateStore();
      const h = runner(store, ["resident", "bot"]);
      for (const step of h.plan.steps) {
        step.requiredEnv = [];
        step.capabilities = [];
      }
      h.plan.steps[0]!.retryOnPreflightRefusal = false;
      const control = new AbortController();
      h.deps.signal = control.signal;
      processes.botOutput = "[resident-preflight] preflight REFUSED: fixture";
      h.deps.env.RESIDENT_DRAIN_TOKEN = "fixture";
      h.deps.postJson = async (url) => {
        if (!url.endsWith("/undrain")) return { status: 200, body: { draining: { since: "start", until: "later" } } };
        control.abort();
        return cleanup === "lost"
          ? { error: "reply lost" }
          : cleanup === "held"
            ? { status: 200, body: { cleared: false, held: ["repo:example/service"] } }
            : {
                status: cleanup === "ack" ? 200 : Number(cleanup),
                body: { cleared: cleanup === "ack", draining: null },
              };
      };
      const phases: string[] = [];
      vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (new URL(String(url)).pathname === "/plane/deploy") {
          phases.push(JSON.parse(String(init?.body)).phase);
          return Response.json({ ok: true, admitted: 0 });
        }
        return store.fetchImpl(url, init);
      });
      const result = await runDeployPlan(h.plan, h.io, h.deps);
      expect(result, JSON.stringify(result)).toMatchObject({
        kind: "ran",
        ok: false,
        results: [{ name: "resident", live: "not deployed" }],
        notAttempted: ["bot"],
      });
      expect(phases).toEqual(["pending", "landed"]);
      expect(h.logs.some((line) => line.includes("fleet reopened"))).toBe(cleanup === "ack");
      expect(processes.calls).toHaveLength(1);
      expect(store.state.document).toEqual(prior);
      expect(store.slotState.document?.yaml).toBe(candidateText);
    },
  );

  it.each(["valid", "observation", "prepare", "supersede"])(
    "%s completion starts no observer window after cancellation",
    async (stage) => {
      const store = stateStore();
      const h = runner(store, ["bot"]);
      const control = new AbortController();
      h.deps.signal = control.signal;
      if (stage === "observation") {
        const readApp = h.deps.readAppState;
        h.deps.readAppState = async (...args) => {
          const result = await readApp(...args);
          control.abort();
          return result;
        };
      }
      const phases: string[] = [];
      vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const path = new URL(String(url)).pathname;
        if (path === "/plane/deploy") {
          phases.push(JSON.parse(String(init?.body)).phase);
          return Response.json({ ok: true, admitted: 0 });
        }
        const response = await store.fetchImpl(url, init);
        if (
          (stage === "prepare" && path === "/config/get" && String(init?.body).includes("deploy-base-")) ||
          (stage === "supersede" && path === "/healthz")
        )
          control.abort();
        return response;
      });
      const result = await runDeployPlan(h.plan, h.io, h.deps);
      expect(store.state.document).toEqual(prior);
      if (stage === "valid") {
        expect(result).toMatchObject({ kind: "ran", ok: false });
        expect(phases).toEqual(["pending", "landed"]);
        expect(processes.calls).toEqual(["upload:bot"]);
      } else {
        expect(result).toEqual({ kind: "refused", problems: ["deployment cancelled"] });
        expect(phases).toEqual([]);
        expect(processes.calls).toEqual([]);
        expect(store.slotState.document).toBeNull();
      }
    },
  );

  it("an active unconfirmed cancellation leaves its observer window unconfirmed", async () => {
    const store = stateStore();
    const h = runner(store, ["bot"]);
    const control = new AbortController();
    h.deps.signal = control.signal;
    processes.onBot = () => control.abort();
    const phases: string[] = [];
    vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (new URL(String(url)).pathname === "/plane/deploy") {
        phases.push(JSON.parse(String(init?.body)).phase);
        return Response.json({ ok: true, admitted: 0 });
      }
      return store.fetchImpl(url, init);
    });
    const result = await runDeployPlan(h.plan, h.io, h.deps);
    expect(result).toMatchObject({
      kind: "ran",
      ok: false,
      results: [{ name: "bot", live: "upload outcome uncertain", status: "FAILED: deployment cancelled" }],
    });
    expect(phases).toEqual(["pending"]);
  });

  it("a known no-upload cancellation lifts its own observer window without claiming readiness", async () => {
    const store = stateStore();
    const h = runner(store, ["bot"]);
    const control = new AbortController();
    h.deps.signal = control.signal;
    h.deps.sleep = async () => {
      control.abort();
    };
    processes.botOutput = "[preflight] preflight REFUSED: fixture";
    const phases: string[] = [];
    vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (new URL(String(url)).pathname === "/plane/deploy") {
        phases.push(JSON.parse(String(init?.body)).phase);
        return Response.json({ ok: true, admitted: 0 });
      }
      return store.fetchImpl(url, init);
    });
    const result = await runDeployPlan(h.plan, h.io, h.deps);
    expect(result).toMatchObject({
      kind: "ran",
      ok: false,
      results: [{ name: "bot", live: "not deployed", status: "FAILED: deployment cancelled" }],
    });
    expect(processes.calls).toEqual(["upload:bot"]);
    expect(phases).toEqual(["pending", "landed"]);
  });

  it.each(["current", "original-legacy", "original-owned"])(
    "%s source refuses account A contradiction after the profile changes to eligible B",
    async (source) => {
      const store = stateStore();
      const h = runner(store);
      if (source !== "current") {
        const observed = configSourceObservation(
          await h.deps.readHealth(""),
          await h.deps.readAppState("", ""),
          await h.deps.readInstances("", ""),
        );
        if (!observed.ok) throw new Error(observed.problem);
        h.plan.config.originalSource =
          source === "original-owned" ? { ...observed.source, key: `base-${"b".repeat(40)}` } : observed.source;
        h.deps.readHealth = async () => ({ error: "A health unavailable" });
      }
      writeFileSync(h.profilePath, JSON.stringify({ ...h.plan.profile.selection, account: otherAccount }));
      const accounts: string[] = [];
      h.deps.readInstances = async (_dir, _app, config) => {
        const account = config ? JSON.parse(readFileSync(config, "utf8")).account_id : otherAccount;
        accounts.push(account);
        return { value: [{ name: "singleton", state: "running", version: account === TEST_PROFILE.account ? 2 : 3 }] };
      };
      expect(await runDeployPlan(h.plan, h.io, h.deps)).toMatchObject({ kind: "refused" });
      expect(accounts).toEqual([TEST_PROFILE.account]);
      expect(store.calls).toEqual([]);
      expect(store.snapshots.size).toBe(0);
      expect(processes.calls).toEqual([]);
    },
  );

  it.each(["local", "github"])(
    "renders and uploads the frozen account despite a changed %s profile",
    async (location) => {
      const store = stateStore();
      const h = runner(store);
      writeFileSync(h.profilePath, JSON.stringify({ ...h.plan.profile.selection, account: otherAccount }));
      if (location === "github") {
        h.plan.profile.path = "github://owner/repository/profile.json";
        vi.stubEnv("SWITCHBOARD_DEPLOY_PROFILE", h.plan.profile.path);
        vi.stubEnv("GITHUB_TOKEN", "read-only-test-token");
        const requests: string[] = [];
        vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          requests.push(String(input));
          if (new URL(String(input)).hostname === "api.github.com")
            return Response.json({
              content: Buffer.from(JSON.stringify({ ...h.plan.profile.selection, account: otherAccount })).toString(
                "base64",
              ),
              encoding: "base64",
            });
          return store.fetchImpl(input, init);
        });
        h.io.log = (line) => {
          const length = h.logs.push(line);
          expect(requests.some((url) => new URL(url).hostname === "api.github.com")).toBe(false);
          return length;
        };
      }

      expect(await runDeployPlan(h.plan, h.io, h.deps)).toMatchObject({ kind: "ran", ok: false });
      expect(processes.uploads.map(({ name, account }) => ({ name, account }))).toEqual([
        { name: "memory", account: TEST_PROFILE.account },
        { name: "bot", account: TEST_PROFILE.account },
      ]);
      expect(processes.uploads.every(({ bucketConfig }) => !!bucketConfig)).toBe(true);
      expect(store.slotState.document?.yaml).toBe(candidateText);
    },
  );

  it.each(["current", "original"])(
    "%s source rechecks A after the shared Wrangler file changes to B",
    async (source) => {
      const store = stateStore();
      const h = runner(store);
      if (source === "original") {
        const observed = configSourceObservation(
          await h.deps.readHealth(""),
          await h.deps.readAppState("", ""),
          await h.deps.readInstances("", ""),
        );
        if (!observed.ok) throw new Error(observed.problem);
        h.plan.config.originalSource = observed.source;
        h.deps.readHealth = async () => ({ error: "A health unavailable" });
      }
      const accounts: string[] = [];
      processes.onMemory = () => {
        writeFileSync(
          join(processes.workArea, "deploy/cloudflare/wrangler.jsonc"),
          JSON.stringify({ account_id: otherAccount }),
        );
        h.deps.readAppState = async (_dir, _app, config) => {
          const account = config ? JSON.parse(readFileSync(config, "utf8")).account_id : otherAccount;
          accounts.push(account);
          return {
            value:
              account === TEST_PROFILE.account
                ? { version: 4, image: "registry.example/newer" }
                : { version: 3, image: "registry.example/bot:old" },
          };
        };
      };
      expect(await runDeployPlan(h.plan, h.io, h.deps)).toMatchObject({ kind: "ran", ok: false });
      expect(accounts).toEqual([TEST_PROFILE.account]);
      expect(processes.calls).toEqual(["upload:memory"]);
      expect(store.slotState.document).toBeNull();
      expect(store.state.document).toEqual(prior);
    },
  );

  it.each(["live", "final", "valid", "cancelled"])(
    "%s acceptance reads A after upload changes the shared Wrangler account to B",
    async (phase) => {
      const store = stateStore();
      const h = runner(store);
      let uploaded = false;
      const control = new AbortController();
      h.deps.signal = control.signal;
      let inventoryReads = 0;
      let clock = 0;
      const accounts: string[] = [];
      const selectedImage = "registry.example/bot:new";
      h.plan.steps.find((step) => step.name === "bot")!.botImage = selectedImage;
      processes.botCode = 0;
      processes.onBot = () => {
        uploaded = true;
        writeFileSync(
          join(processes.workArea, "deploy/cloudflare/wrangler.jsonc"),
          JSON.stringify({ account_id: otherAccount }),
        );
      };
      h.deps.now = () => clock;
      h.deps.sleep = async (ms) => {
        clock += ms;
      };
      const accountOf = (config?: string) => {
        const account = config ? JSON.parse(readFileSync(config, "utf8")).account_id : otherAccount;
        accounts.push(account);
        return account;
      };
      h.deps.readAppState = async (_dir, _app, config) => {
        accountOf(config);
        return {
          value: uploaded ? { version: 4, image: selectedImage } : { version: 3, image: "registry.example/bot:old" },
        };
      };
      const legacyHealth = h.deps.readHealth;
      h.deps.readHealth = async (...args) =>
        uploaded
          ? {
              status: 200,
              body: {
                ok: true,
                draining: false,
                build: { commit: "a".repeat(40) },
                loadedBase: {
                  schema: 1,
                  source: { kind: "state", key: `base-${"a".repeat(40)}`, version: store.slotState.version },
                  sha256: store.slotState.document!.sha256,
                  process: { commit: "a".repeat(40) },
                },
              },
            }
          : legacyHealth(...args);
      h.deps.readInstances = async (_dir, _app, config) => {
        const account = accountOf(config);
        if (uploaded) inventoryReads++;
        if (phase === "cancelled" && inventoryReads === 2) control.abort();
        const contradictory =
          uploaded &&
          account === TEST_PROFILE.account &&
          (phase === "live" || (phase === "final" && inventoryReads >= 2));
        return {
          value: [{ name: contradictory ? "foreign" : "singleton", state: "running", version: uploaded ? 4 : 3 }],
        };
      };
      const result = await runDeployPlan(h.plan, h.io, h.deps);
      expect(result).toMatchObject({ kind: "ran", ok: phase === "valid" });
      expect(accounts.length).toBeGreaterThan(4);
      expect(new Set(accounts)).toEqual(new Set([TEST_PROFILE.account]));
      expect(processes.calls).toEqual(["upload:memory", "upload:bot"]);
      expect(store.calls.filter((call) => call === "put")).toHaveLength(1);
      expect(store.state.document).toEqual(prior);
      if (phase === "cancelled") {
        expect(result).toMatchObject({
          results: [
            expect.anything(),
            { live: "deployed, not live: deployment cancelled", status: "FAILED: deployment cancelled" },
          ],
        });
        expect(store.calls).toEqual(["get", "get", "put"]);
        expect(inventoryReads).toBe(2);
      }
      if (phase === "final") {
        expect(result).toMatchObject({
          results: [expect.anything(), { live: expect.stringContaining("deployed, not live") }],
        });
        expect(inventoryReads).toBe(2);
      }
    },
  );

  it("captures before Memory upload and preserves a setting changed during that upload", async () => {
    const store = stateStore();
    const h = runner(store);
    let readsAtUpload: string[] = [];
    processes.onMemory = () => {
      readsAtUpload = [...store.calls];

      store.state.document = successor;
      store.state.version++;
      writeFileSync(h.source, "# mutated source\n");
    };
    const result = await runDeployPlan(h.plan, h.io, h.deps);
    expect(result, JSON.stringify(result)).toMatchObject({ kind: "ran", ok: false });
    expect(processes.calls).toEqual(["upload:memory"]);
    expect(readsAtUpload).toEqual(["get", "get"]);
    expect(store.snapshotCalls).toEqual(["put", "get"]);
    expect(store.calls).toEqual(["get", "get", "put"]);
    expect(store.state.document).toEqual(successor);
    expect(h.logs.join("\n")).not.toContain("private config");
  });

  it("stops before Bot on an unknown committed config write without restoring or retrying", async () => {
    const store = stateStore();
    store.loseAck();
    const h = runner(store);
    const outcome = await runDeployPlan(h.plan, h.io, h.deps);
    expect(outcome).toMatchObject({ kind: "ran", ok: false });
    expect(processes.calls).toEqual(["upload:memory"]);
    expect(store.calls).toEqual(["get", "get", "put"]);
    expect(store.slotState.document?.yaml).toBe(candidateText);
    expect(store.state.document).toEqual(prior);
    expect(store.slotState.version).toBe(1);
    expect(store.state.version).toBe(4);
  });

  it.each(["lost", "mismatch"])(
    "snapshot %s uncertainty stops before any Worker upload and sends no base",
    async (failure) => {
      const store = stateStore();
      if (failure === "lost") store.loseSnapshotAck();
      else store.mismatchSnapshot();
      const h = runner(store);
      expect(await runDeployPlan(h.plan, h.io, h.deps)).toMatchObject({ kind: "refused" });
      expect(processes.calls).toEqual([]);
      expect(store.calls).toEqual(["get", "get"]);
      expect(store.snapshotCalls).toEqual(failure === "lost" ? ["put"] : ["put", "get"]);
      expect(store.snapshots.size).toBe(1);
      expect(store.state.document).toEqual(prior);
      expect(h.logs.join("\n")).toContain("deploy-base-");
      expect(h.logs.join("\n")).not.toContain("original private config");
    },
  );

  it("unknown prior consumer cannot bootstrap merely from a readable legacy document", async () => {
    const store = stateStore();
    const h = runner(store);
    h.deps.readHealth = async () => ({ error: "unavailable" });
    expect(await runDeployPlan(h.plan, h.io, h.deps)).toMatchObject({ kind: "refused" });
    expect(processes.calls).toEqual([]);
    expect(store.calls).toEqual([]);
    expect(store.snapshots.size).toBe(0);
  });

  it("original legacy document/native observations are input data without claiming an owned CID", async () => {
    const store = stateStore();
    const h = runner(store);
    const app = await h.deps.readAppState("", "");
    const frozen = frozenLegacyConfigSourceInput({ ok: true, document: prior, version: 4 }, app);
    if (!frozen.ok) throw new Error(frozen.problem);
    expect(frozen.source).not.toHaveProperty("observedProcessCommit");
    expect(originalConfigSourceObservation(frozen.source, app, await h.deps.readInstances("", ""))).toBe(true);
    h.plan.config.originalSource = frozen.source;
    h.deps.readHealth = async () => ({ error: "unavailable" });
    expect(await runDeployPlan(h.plan, h.io, h.deps)).toMatchObject({ kind: "ran", ok: false });
    expect(store.state.document).toEqual(prior);
    expect(store.slotState.document?.yaml).toBe(candidateText);
  });

  it("an exact original source observation can stage while its unchanged native target remains", async () => {
    const store = stateStore();
    const h = runner(store);
    const observation = configSourceObservation(
      await h.deps.readHealth("unused"),
      await h.deps.readAppState("", ""),
      await h.deps.readInstances("", ""),
    );
    if (!observation.ok) throw new Error(observation.problem);
    h.plan.config.originalSource = observation.source;
    h.deps.readHealth = async () => ({ error: "unavailable" });
    expect(await runDeployPlan(h.plan, h.io, h.deps)).toMatchObject({ kind: "ran", ok: false });
    expect(processes.calls).toEqual(["upload:memory"]);
    expect(store.slotState.document?.yaml).toBe(candidateText);
    expect(store.state.document).toEqual(prior);
  });

  it("a newer source setting invalidates the original observation before uploads or snapshots", async () => {
    const store = stateStore();
    const h = runner(store);
    const observation = configSourceObservation(
      await h.deps.readHealth("unused"),
      await h.deps.readAppState("", ""),
      await h.deps.readInstances("", ""),
    );
    if (!observation.ok) throw new Error(observation.problem);
    h.plan.config.originalSource = observation.source;
    h.deps.readHealth = async () => ({ error: "unavailable" });
    store.state.document = successor;
    store.state.version = 5;
    expect(await runDeployPlan(h.plan, h.io, h.deps)).toMatchObject({ kind: "refused" });
    expect(processes.calls).toEqual([]);
    expect(store.snapshots.size).toBe(0);
    expect(store.state.document).toEqual(successor);
  });

  it("a native target change during Memory upload refuses activation without publishing the slot", async () => {
    const store = stateStore();
    const h = runner(store);
    processes.onMemory = () => {
      h.deps.readAppState = async () => ({ value: { version: 4, image: "registry.example/newer" } });
    };
    expect(await runDeployPlan(h.plan, h.io, h.deps)).toMatchObject({ kind: "ran", ok: false });
    expect(processes.calls).toEqual(["upload:memory"]);
    expect(store.calls).toEqual(["get", "get"]);
    expect(store.slotState.document).toBeNull();
    expect(store.state.document).toEqual(prior);
  });

  it("retains the frozen candidate on Bot failure without claiming rollback", async () => {
    const store = stateStore();
    const h = runner(store);
    processes.onMemory = () => writeFileSync(h.source, "# later source\n");
    const result = await runDeployPlan(h.plan, h.io, h.deps);
    expect(result, JSON.stringify(result)).toMatchObject({ kind: "ran", ok: false });
    expect(processes.calls).toEqual(["upload:memory", "upload:bot"]);
    expect(store.calls).toEqual(["get", "get", "put"]);
    expect(store.slotState.document?.yaml).toBe(candidateText);
    expect(store.state.document).toEqual(prior);
  });

  it("does not publish config after a failed Memory upload", async () => {
    const store = stateStore();
    const h = runner(store);
    processes.memoryCode = 1;
    const result = await runDeployPlan(h.plan, h.io, h.deps);
    expect(result, JSON.stringify(result)).toMatchObject({ kind: "ran", ok: false });
    expect(store.calls).toEqual(["get", "get"]);
    expect(store.state.document).toEqual(prior);
  });

  it.each([{ only: ["memory"] as WorkerName[] }, { only: [] as WorkerName[] }])(
    "selection %j reads and writes no base config",
    async ({ only }) => {
      const store = stateStore();
      const h = runner(store, only);
      expect(await runDeployPlan(h.plan, h.io, h.deps)).toMatchObject({ kind: "ran", ok: true });
      expect(store.calls).toEqual([]);
      expect(store.state.document).toEqual(prior);
    },
  );

  it("preserves file-mode deployment without a state Worker", async () => {
    const store = stateStore();
    const h = runner(store, ["bot"], false);
    const result = await runDeployPlan(h.plan, h.io, h.deps);
    expect(result, JSON.stringify(result)).toMatchObject({ kind: "ran", ok: false });
    expect(processes.calls).toEqual(["upload:bot"]);
    expect(store.calls).toEqual([]);
  });

  it("refuses an unreadable canonical base before any selected upload", async () => {
    const store = stateStore();
    const h = runner(store);
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    expect(await runDeployPlan(h.plan, h.io, h.deps)).toMatchObject({ kind: "refused" });
    expect(processes.calls).toEqual([]);
  });
});

describe("config publication process survival", () => {
  it("recovers exact inputs after both the writer process and SQLite Worker restart", async () => {
    const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "config-process-"));
    dirs.push(dir);
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const address = socket.address();
    if (!address || typeof address === "string") throw new Error("no test port");
    const port = address.port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = { PATH: process.env.PATH, WRANGLER_SEND_METRICS: "false", CI: "1" };
    const root = process.cwd();
    const compatibilityDate = /"compatibility_date":\s*"([^"]+)"/.exec(
      readFileSync(join(root, "deploy/cloudflare-memory/wrangler.template.jsonc"), "utf8"),
    )?.[1];
    if (!compatibilityDate) throw new Error("missing production compatibility date");
    // This fixture projects the real runtime exports to isolate store durability.
    // It does not certify that the production Worker's unfiltered entry starts.
    const entry = join(dir, "worker-entry.ts");
    writeFileSync(
      entry,
      `export { default, MemoryDO, ScheduleDO, ConfigDO, DeliveryDO, CostsSnapshotDO, RunHistoryDO, RunTranscriptDO, SessionLogDO } from ${JSON.stringify(join(root, "deploy/cloudflare-memory/worker.ts"))};`,
    );
    let worker: ReturnType<typeof spawn> | undefined;
    const stop = async () => {
      if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
      const stopped = new Promise<void>((resolve) => worker!.once("exit", () => resolve()));
      if (process.platform === "win32") worker.kill("SIGTERM");
      else process.kill(-worker.pid!, "SIGTERM");
      await stopped;
      worker = undefined;
    };
    const start = async () => {
      worker = spawn(
        "npm",
        [
          "run",
          "dev",
          "-w",
          "deploy/cloudflare-memory",
          "--",
          entry,
          "--local",
          "--config",
          "wrangler.test.jsonc",
          "--compatibility-date",
          compatibilityDate,
          "--compatibility-flags",
          "nodejs_compat",
          "--var",
          "MEMORY_TOKEN:test-token",
          "--ip",
          "127.0.0.1",
          "--port",
          String(port),
          "--inspector-port",
          "0",
          "--persist-to",
          join(dir, "sqlite"),
        ],
        { cwd: root, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      worker.stdout?.on("data", (b) => {
        output += String(b);
      });
      worker.stderr?.on("data", (b) => {
        output += String(b);
      });
      for (let n = 0; n < 150; n++) {
        if (worker.exitCode !== null) throw new Error(`local test Worker exited: ${output}`);
        try {
          if ((await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(200) })).ok) return;
        } catch {
          /* starting */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`local test Worker did not start: ${output}`);
    };
    const script = join(dir, "client.mjs");
    writeFileSync(
      script,
      `
import { ConfigDocumentClient, baseConfigDocument } from ${JSON.stringify(join(root, "src/configDocument.ts"))};
const [phase, baseUrl, publicationId] = process.argv.slice(2);
const key = 'deploy-base-' + publicationId;
const client = new ConfigDocumentClient({baseUrl, token: 'test-token'});
const prior = baseConfigDocument('prior process bytes\\n', 'prior-source', new Date(0));
const candidate = baseConfigDocument('candidate process bytes\\n', 'candidate-source', new Date(1));
if (phase === 'write') {
  const storedPrior = await client.pushBase(prior, 'base', 0);
  if (!storedPrior.ok) throw new Error(storedPrior.problem);
  const canonical = await client.readBase();
  if (!canonical.ok || canonical.version !== 1) throw new Error('prior read failed');
  const snapshot = {schema:1,kind:'base-config-publication',publicationId,stateWorkerUrl:baseUrl,baseKey:'base',priorVersion:canonical.version,priorDocument:canonical.document,expectedCandidateVersion:canonical.version+1,candidate};
  const result = await client.recordPublicationSnapshot(key, snapshot);
  if (!result.ok) throw new Error(result.problem);
  const read = await client.readPublicationSnapshot(key);
  if (!read.ok) throw new Error(read.problem);
  process.stdout.write(JSON.stringify({key,version:result.version}));
} else {
  const read = await client.readPublicationSnapshot(key);
  if (!read.ok) throw new Error(read.problem);
  process.stdout.write(JSON.stringify({priorRecovered:JSON.stringify(read.snapshot.priorDocument)===JSON.stringify(prior),candidateRecovered:JSON.stringify(read.snapshot.candidate)===JSON.stringify(candidate),version:read.snapshot.expectedCandidateVersion}));
}
`,
    );
    const { randomUUID } = await import("node:crypto");
    const publicationId = randomUUID();
    const clientProcess = (phase: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", script, phase, baseUrl, publicationId], {
          cwd: root,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        let errors = "";
        child.stdout.on("data", (b) => {
          output += String(b);
        });
        child.stderr.on("data", (b) => {
          errors += String(b);
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0) reject(new Error(errors));
          else {
            try {
              resolve(JSON.parse(output));
            } catch (err) {
              reject(err);
            }
          }
        });
      });
    try {
      await start();
      expect(await clientProcess("write")).toEqual({ key: `deploy-base-${publicationId}`, version: 1 });
      await stop();
      await start();
      expect(await clientProcess("read")).toEqual({ priorRecovered: true, candidateRecovered: true, version: 2 });
    } finally {
      await stop();
    }
  }, 45_000);
});

describe("actual consumer config publication", () => {
  const commit = "a".repeat(40);
  const health = () => ({
    status: 200,
    body: {
      ok: true,
      draining: false,
      build: { commit: "b".repeat(40) },
      loadedBase: {
        schema: 1,
        source: { kind: "state", key: `base-${commit}`, version: 3 },
        sha256: "c".repeat(64),
        process: { commit },
      },
    },
  });
  const app = { value: { version: 3, image: "registry.example/current" } };
  const instances = { value: [{ name: "singleton", state: "running", version: 3 }] };
  it("uses actual owned identity and native target despite a differing display or desired build", () => {
    expect(
      eligibleConfigPublicationConsumer({ commit }, health(), app, instances, "registry.example/current"),
    ).toMatchObject({ ok: true, consumer: { identity: { commit } } });
  });
  it("a foreign publisher cannot update even a valid current slot", () => {
    expect(eligibleConfigPublicationConsumer({ commit: "b".repeat(40) }, health(), app, instances)).toMatchObject({
      ok: false,
    });
  });
  it("a desired/actual image mismatch refuses config publication", () => {
    expect(
      eligibleConfigPublicationConsumer({ commit }, health(), app, instances, "registry.example/desired"),
    ).toMatchObject({ ok: false });
  });
  it("an unversioned or mixed instance cannot establish application binding", () => {
    expect(
      eligibleConfigPublicationConsumer({ commit }, health(), app, {
        value: [{ ...instances.value[0], version: null }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      eligibleConfigPublicationConsumer({ commit }, health(), app, { value: [{ ...instances.value[0], version: 2 }] }),
    ).toMatchObject({ ok: false });
  });
  it("a boot refusal cannot masquerade as an installed eligible config", () => {
    expect(
      eligibleConfigPublicationConsumer(
        { commit },
        { status: 503, body: { ok: false, consumer: { commit, expectedKey: `base-${commit}` } } },
        app,
        instances,
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("consumer read diagnostics", () => {
  const target = {
    account: "private-account",
    dir: "deploy/cloudflare",
    containerApp: "private-app",
    healthUrl: "https://private.example/healthz",
    adminUrl: "https://private.example/admin/restart",
  };
  const good = {
    health: { status: 200, body: { private: "private-body" } },
    application: { value: { version: 3, image: "private-image" } },
    instances: { value: [] },
  };
  it.each([
    [
      "list",
      1,
      JSON.stringify({
        error:
          'There has been an unknown error listing containers.\n{"errors":[{"code":10000,"message":"private-secret"}]}',
      }),
      403,
      "command-error",
      "api-error",
      "json",
      [10000],
    ],
    [
      "list",
      1,
      JSON.stringify({
        error: 'There has been an unknown error listing containers.\n"<!DOCTYPE html><html>private-secret</html>"',
      }),
      403,
      "command-error",
      "api-error",
      "html",
      [],
    ],
    ["list", 0, "private-invalid-json", undefined, "invalid-json", "unknown", "unknown", []],
    ["list", 1, "", 403, "command-error", "unknown", "unknown", []],
    [
      "list",
      1,
      JSON.stringify({ error: "There has been an internal error listing containers.\nprivate-exception" }),
      undefined,
      "command-error",
      "producer-internal",
      "unknown",
      [],
    ],
    ["list", 0, '{"private-shape":true}', 200, "application-list-shape", "unknown", "unknown", []],
    ["list", 0, "[]", 200, "application-not-found", "unknown", "unknown", []],
    ["info", 0, '{"version":"private-invalid-version"}', 200, "application-shape", "unknown", "unknown", []],
    [
      "instances",
      1,
      JSON.stringify({
        error:
          'There has been an unknown error fetching instances.\n{"errors":[{"code":10000,"message":"private-secret"}]}',
      }),
      403,
      "command-error",
      "api-error",
      "json",
      [10000],
    ],
  ] as const)(
    "retains %s failure evidence (%s) before the not-written refusal",
    async (command, code, output, status, reason, errorClass, responseFormat, codes) => {
      const dir = mkdtempSync(join(tmpdir(), "consumer-command-"));
      vi.stubEnv("RUNNER_TEMP", dir);
      const logs = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      vi.spyOn(defaultSandboxGateDeps, "readHealth").mockResolvedValue({ status: 200, body: { ok: true } });
      const producerLogs: string[] = [];
      processes.wrangler = (args, env) => {
        if (env.WRANGLER_LOG_PATH) producerLogs.push(env.WRANGLER_LOG_PATH);
        const selected = args[2] === command;
        if (selected && env.WRANGLER_LOG_PATH && status !== undefined) {
          const suffix = command === "list" ? "" : command === "info" ? "/private-id" : "/private-id/instances";
          writeFileSync(
            env.WRANGLER_LOG_PATH,
            `-- START CF API REQUEST: https://api.cloudflare.com/client/v4/accounts/private-account/containers/dash/applications${suffix}\nAuthorization: Bearer private-secret\n-- START CF API RESPONSE: Status ${status}\nRESPONSE: private-body`,
          );
        }
        return selected
          ? { output, code }
          : {
              output:
                args[2] === "list"
                  ? '[{"id":"private-id","name":"private-app"}]'
                  : args[2] === "info"
                    ? '{"version":3,"configuration":{"image":"private-image"}}'
                    : '{"instances":[],"result_info":{}}',
              code: 0,
            };
      };
      try {
        const binding = await defaultRestartRunnerDeps.actualConsumer(target);
        expect(
          await pushConfigForServedConsumer(
            { ok: true, text: "private-yaml", how: "fixture" },
            { stateWorkerUrl: "https://private.example", key: "private-slot", env: {} },
            { commit: "a".repeat(40) },
            binding.health,
            binding.application,
            binding.instances,
          ),
        ).toEqual({
          ok: false,
          problem: "actual config consumer or application target is unavailable",
          write: "not-written",
        });
        const text = readFileSync(join(dir, "config-read-diagnostic.json"), "utf8");
        const saved = JSON.parse(text);
        const expected = {
          stage: command === "list" ? "application-list" : command === "info" ? "application-info" : "instances",
          reason,
          commandExit: code,
          httpStatus: status ?? null,
          errorClass,
          responseFormat,
          providerCodes: codes,
        };
        expect(saved.consumerFailures[command === "instances" ? "instances" : "application"]).toEqual(expected);
        if (command === "list") {
          expect(saved.consumerFailures.instances).toEqual(expected);
          expect(saved.frames).toEqual([]);
        }
        expect(saved.consumerReads).toMatchObject({ health: "available", healthStatus: 200 });
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16384);
        expect(text + logs.mock.calls.map((c) => c[0]).join("\n")).not.toContain("private-");
        expect(new Set(producerLogs).size).toBe(producerLogs.length);
        for (const file of producerLogs) expect(() => readFileSync(file)).toThrow();
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it("retains successful read predicates without changing eligible consumer identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consumer-success-"));
    const commit = "a".repeat(40);
    const reads = {
      health: {
        status: 200,
        body: {
          ok: true,
          draining: false,
          loadedBase: {
            schema: 1,
            source: { kind: "state", key: `base-${commit}`, version: 3 },
            sha256: "c".repeat(64),
            process: { commit },
          },
        },
      },
      application: { value: { version: 3, image: "private-image" } },
      instances: { value: [{ name: "singleton", state: "running", version: 3 }] },
    };
    vi.stubEnv("RUNNER_TEMP", dir);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(defaultSandboxGateDeps, "readHealth").mockResolvedValue(reads.health);
    vi.spyOn(defaultSandboxGateDeps, "readAppState").mockResolvedValue(reads.application);
    vi.spyOn(defaultSandboxGateDeps, "readInstances").mockResolvedValue(reads.instances);
    try {
      const binding = await defaultRestartRunnerDeps.actualConsumer(target);
      expect(
        eligibleConfigPublicationConsumer({ commit }, binding.health, binding.application, binding.instances),
      ).toMatchObject({
        ok: true,
        consumer: {
          identity: { commit: "a".repeat(40) },
          key: `base-${"a".repeat(40)}`,
          version: 3,
          sha256: "c".repeat(64),
        },
      });
      expect(JSON.parse(readFileSync(join(dir, "config-read-diagnostic.json"), "utf8")).consumerReads).toEqual({
        health: "available",
        healthStatus: 200,
        application: "available",
        instances: "complete",
      });
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each([
    [
      "health-error",
      { ...good, health: { error: "private-error" } },
      { health: "read-error", healthStatus: null, application: "available", instances: "complete" },
    ],
    [
      "health-non200",
      { ...good, health: { status: 503, body: { private: "private-body" } } },
      { health: "non-200", healthStatus: 503, application: "available", instances: "complete" },
    ],
    [
      "app-error",
      { ...good, application: { error: "private-error" } },
      { health: "available", healthStatus: 200, application: "read-error", instances: "complete" },
    ],
    [
      "instances-error",
      { ...good, instances: { error: "private-error" } },
      { health: "available", healthStatus: 200, application: "available", instances: "read-error" },
    ],
  ])("%s retains the failed predicate and the exact not-written public outcome", async (_name, reads, expected) => {
    const dir = mkdtempSync(join(tmpdir(), "consumer-diagnostic-"));
    vi.stubEnv("RUNNER_TEMP", dir);
    const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(defaultSandboxGateDeps, "readHealth").mockResolvedValue(reads.health as any);
    vi.spyOn(defaultSandboxGateDeps, "readAppState").mockResolvedValue(reads.application as any);
    vi.spyOn(defaultSandboxGateDeps, "readInstances").mockResolvedValue(reads.instances as any);
    try {
      const binding = await defaultRestartRunnerDeps.actualConsumer(target);
      expect(
        await pushConfigForServedConsumer(
          { ok: true, text: "private-yaml", how: "fixture" },
          { stateWorkerUrl: "https://private.example", key: "private-slot", env: {} },
          { commit: "a".repeat(40) },
          binding.health,
          binding.application,
          binding.instances,
        ),
      ).toEqual({
        ok: false,
        problem: "actual config consumer or application target is unavailable",
        write: "not-written",
      });
      const text = readFileSync(join(dir, "config-read-diagnostic.json"), "utf8");
      expect(JSON.parse(text).consumerReads).toEqual(expected);
      expect(text + log.mock.calls.map((call) => call[0]).join("")).not.toContain("private-");
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
