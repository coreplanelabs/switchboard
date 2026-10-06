import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseConfigDocument } from "../configDocument.js";
import { pushConfigOnHost } from "./run.js";
import { TEST_PROFILE } from "./testing/profile.js";

const host = vi.hoisted(() => ({ root: "", account: "", nativeAccounts: [] as string[] }));
vi.mock("./host.js", async (load) => ({
  ...(await load<typeof import("./host.js")>()),
  OPERATOR_ROOT: {
    mode: "package",
    chosenBy: "cwd",
    get root() {
      return host.root;
    },
    get workArea() {
      return host.root;
    },
    get assets() {
      return host.root;
    },
  },
  packageSourceOnHost: () => ({ commit: "a".repeat(40), version: "1.0.0" }),
}));
vi.mock("node:child_process", () => ({
  spawn: (_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    queueMicrotask(() => {
      const config = args.indexOf("--config");
      const account = config < 0 ? host.account : JSON.parse(readFileSync(args[config + 1], "utf8")).account_id;
      host.nativeAccounts.push(account);
      const result = args.includes("list")
        ? [{ id: "app-id", name: "switchboard-switchboardserver" }]
        : args.includes("info")
          ? { version: 18, configuration: { image: "registry.example/actual" } }
          : [{ name: "singleton", state: "running", version: 18 }];
      child.stdout.emit("data", Buffer.from(JSON.stringify(result)));
      child.emit("close", 0);
    });
    return child;
  },
  execFileSync: () => "",
}));

const commit = "a".repeat(40);
const sourceText = `organization: example
defaults:
  agent: general
  models:
    general: test/general-model
providers:
  test:
    wire: openai-responses
    apiKeyEnv: TEST_API_KEY
runHistory:
  worker:
    baseUrl: https://state.example
    tokenEnv: MEMORY_TOKEN
grants:
  'slack:UTEST':
    actions: [all]
`;
const doc = baseConfigDocument(sourceText, "source", new Date(0));
const target = {
  account: TEST_PROFILE.account,
  dir: "deploy/cloudflare",
  containerApp: "switchboard-switchboardserver",
  healthUrl: "https://fleet-a.example.test/healthz",
  adminUrl: "https://fleet-a.example.test/admin/restart",
  stateWorkerUrl: "https://state-a.example.test",
};

beforeEach(() => {
  host.root = mkdtempSync(join(tmpdir(), "consumer-target-test-"));
  host.nativeAccounts = [];
  host.account = "b".repeat(32);
  const profile = {
    ...TEST_PROFILE,
    account: host.account,
    workers: {
      ...TEST_PROFILE.workers,
      bot: { ...TEST_PROFILE.workers.bot, hostname: "fleet-b.example.test" },
    },
  };
  const profilePath = join(host.root, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile));
  vi.stubEnv("SWITCHBOARD_DEPLOY_PROFILE", profilePath);
  vi.stubEnv("MEMORY_TOKEN", "test-token");
  writeFileSync(join(host.root, "candidate.yaml"), sourceText);
});
afterEach(() => {
  rmSync(host.root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function backend(a: "foreign" | "eligible" | "unavailable") {
  const calls: string[] = [];
  const writes: string[] = [];
  const rows = new Map<string, { document: unknown; version: number }>([
    [`base-${commit}`, { document: doc, version: 7 }],
  ]);
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/healthz")) {
      if (url === target.healthUrl && a === "unavailable") throw new Error("A unavailable");
      const cid = url === target.healthUrl && a === "foreign" ? "f".repeat(40) : commit;
      return Response.json({
        ok: true,
        draining: false,
        loadedBase: {
          schema: 1,
          source: { kind: "state", key: `base-${cid}`, version: 7 },
          sha256: doc.sha256,
          process: { commit: cid },
        },
      });
    }
    const body = JSON.parse(String(init?.body));
    const row = rows.get(body.key) ?? { document: null, version: 0 };
    if (url.endsWith("/config/get")) return Response.json(row);
    writes.push(url);
    rows.set(body.key, { document: body.document, version: row.version + 1 });
    return Response.json({
      ok: true,
      version: row.version + 1,
      ...(body.sourcePrecondition ? { sourcePrecondition: body.sourcePrecondition } : {}),
    });
  });
  return { calls, writes };
}

describe("standalone publication frozen target", () => {
  it.each(["foreign", "unavailable"] as const)(
    "profile B cannot authorize frozen fleet A when A is %s",
    async (state) => {
      const b = backend(state);
      const opts = {
        source: join(host.root, "candidate.yaml"),
        stateWorkerUrl: "https://state-a.example.test",
        key: "base",
        consumerTarget: target,
      };
      expect(await pushConfigOnHost(opts)).toMatchObject({ ok: false, write: "not-written" });
      expect(b.calls).toContain(target.healthUrl);
      expect(b.calls.some((url) => url.includes("fleet-b"))).toBe(false);
      expect(b.writes).toEqual([]);
      expect(host.nativeAccounts.every((account) => account === target.account)).toBe(true);
    },
  );

  it("an explicit candidate source and a changed profile still publish only to frozen eligible A", async () => {
    const b = backend("eligible");
    const opts = {
      source: join(host.root, "candidate.yaml"),
      stateWorkerUrl: "https://state-a.example.test",
      key: "base",
      consumerTarget: target,
    };
    expect(await pushConfigOnHost(opts)).toMatchObject({ ok: true, document: `base-${commit}`, version: 8 });
    expect(b.calls.filter((url) => url.endsWith("/healthz"))).toEqual([target.healthUrl]);
    expect(b.writes.every((url) => url === `${opts.stateWorkerUrl}/config/put`)).toBe(true);
    expect(host.nativeAccounts.every((account) => account === target.account)).toBe(true);
  });

  it("an unchanged selected profile retains publication and the private snapshot on A", async () => {
    host.account = target.account;
    writeFileSync(
      join(host.root, "profile.json"),
      JSON.stringify({
        ...TEST_PROFILE,
        workers: { ...TEST_PROFILE.workers, bot: { ...TEST_PROFILE.workers.bot, hostname: "fleet-a.example.test" } },
      }),
    );
    const b = backend("eligible");
    const opts = {
      source: join(host.root, "candidate.yaml"),
      stateWorkerUrl: target.stateWorkerUrl,
      key: "base",
      consumerTarget: target,
    };
    expect(await pushConfigOnHost(opts)).toMatchObject({ ok: true, document: `base-${commit}`, version: 8 });
    expect(b.writes).toHaveLength(2);
    expect(b.writes.every((url) => url === `${target.stateWorkerUrl}/config/put`)).toBe(true);
    expect(host.nativeAccounts.every((account) => account === target.account)).toBe(true);
  });

  it("a state endpoint detached from the selected target refuses before observations", async () => {
    const b = backend("eligible");
    const opts = {
      source: join(host.root, "candidate.yaml"),
      stateWorkerUrl: "https://state-b.example.test",
      key: "base",
      consumerTarget: target,
    };
    expect(await pushConfigOnHost(opts)).toMatchObject({ ok: false, write: "not-written" });
    expect(b.calls).toEqual([]);
    expect(host.nativeAccounts).toEqual([]);
  });

  it("a later remote profile reference is never loaded for an already selected target", async () => {
    vi.stubEnv("SWITCHBOARD_DEPLOY_PROFILE", "github://example/infra/profile.json@main");
    const b = backend("eligible");
    const opts = {
      source: join(host.root, "candidate.yaml"),
      stateWorkerUrl: target.stateWorkerUrl,
      key: "base",
      consumerTarget: target,
    };
    expect(await pushConfigOnHost(opts)).toMatchObject({ ok: true, version: 8 });
    const allowed = new Set([
      target.healthUrl,
      `${target.stateWorkerUrl}/config/get`,
      `${target.stateWorkerUrl}/config/put`,
    ]);
    expect(b.calls.every((url) => allowed.has(url))).toBe(true);
  });
});
