import { describe, expect, it } from "vitest";
import { LIVE_GATE_DEADLINE_MS } from "./liveGate.js";
import type { SandboxGateDeps } from "./run.js";
import { probeThreadKey, type AppState, type ContainerInstance, type Read } from "./sandboxLiveGate.js";
import { verifySandboxOnce, inspectSandboxOnce, type SandboxVerificationOptions } from "./sandboxVerification.js";

const options: SandboxVerificationOptions = {
  expectedCommit: "a".repeat(40),
  expectedAppVersion: 12,
  expectedImage: "registry.example/sandbox@sha256:" + "b".repeat(64),
  inventoryOnly: false,
};
const target = {
  source: "c".repeat(40),
  dir: "deploy/cloudflare-sandbox",
  gate: {
    kind: "sandbox" as const,
    healthUrl: "https://sandbox.example.test/healthz",
    bearerEnv: "SANDBOX_TOKEN",
    containerApp: "example-sandbox",
  },
};
function harness() {
  const calls: string[] = [];
  let now = 0;
  let app: Read<AppState> = { value: { version: 12, image: options.expectedImage } };
  let instances: Read<ContainerInstance[]> = {
    value: [{ name: probeThreadKey(options.expectedCommit), state: "running", version: 12 }],
  };
  const deps: SandboxGateDeps = {
    readDeploymentStatus: async () => ({ state: "ready", reason: "fixture Worker deployment verified" }),
    env: { SANDBOX_TOKEN: "fixture" },
    now: () => now,
    sleep: async () => {
      throw new Error("no polling");
    },
    readHealth: async () => {
      calls.push("health");
      return { status: 200, body: { ok: true, build: { commit: options.expectedCommit } } };
    },
    readAppState: async () => {
      calls.push("app");
      return app;
    },
    readInstances: async () => {
      calls.push("inventory");
      return instances;
    },
    probeExec: async (url, bearer, key) => {
      calls.push(`probe:${url}:${bearer}:${key}`);
      return { body: { stdout: "ok\n", exitCode: 0 } };
    },
    postJson: async () => {
      throw new Error("no drain, restart or other write");
    },
  };
  return {
    deps,
    calls,
    setApp: (value: Read<AppState>) => {
      app = value;
    },
    setInstances: (value: Read<ContainerInstance[]>) => {
      instances = value;
    },
    tick: () => {
      now = LIVE_GATE_DEADLINE_MS;
    },
  };
}
describe("verification without upload", () => {
  it("refuses a prefixed Worker identity or non-success health before any application read", async () => {
    for (const [status, commit] of [
      [200, "aaaaaaa"],
      [502, "a".repeat(40)],
    ] as const) {
      const h = harness();
      h.deps.readHealth = async () => {
        h.calls.push("health");
        return { status, body: { ok: true, build: { commit } } };
      };
      expect(await verifySandboxOnce(options, target, h.deps)).toMatchObject({
        ok: false,
        live: false,
        inventoryVerified: false,
        reason: "Worker health does not carry HTTP 200 and the exact pinned commit",
      });
      expect(h.calls).toEqual(["health"]);
    }
  });
  it("refuses cancellation between completed inventory and acceptance for both read-only modes", async () => {
    for (const inspect of [false, true]) {
      const h = harness();
      const controller = new AbortController();
      h.deps.signal = controller.signal;
      h.deps.readInstances = async () => {
        queueMicrotask(() => queueMicrotask(() => controller.abort()));
        return { value: [] };
      };
      const actual = inspect
        ? await inspectSandboxOnce({ inspect: true, expectedCommit: options.expectedCommit }, target, h.deps)
        : await verifySandboxOnce({ ...options, inventoryOnly: true }, target, h.deps);
      expect(actual).toMatchObject({ ok: false, live: false });
      expect(
        inspect
          ? (actual as { inventoryComplete: boolean }).inventoryComplete
          : (actual as { inventoryVerified: boolean }).inventoryVerified,
      ).toBe(false);
    }
  });
  it("public metadata inspection cannot credit legacy inventory or invoke its runtime probe", async () => {
    const h = harness();
    h.deps.readPublicMetadata = async () => {
      h.calls.push("public-metadata");
      return {
        complete: true,
        pages: 3,
        rows: 2,
        states: { running: 2 },
        missingNames: 1,
        emptyImages: 0,
        reason: "public metadata traversal complete; application-version evidence unavailable",
      };
    };
    expect(
      await inspectSandboxOnce(
        { inspect: true, expectedCommit: options.expectedCommit, publicMetadata: true },
        { ...target, account: "d".repeat(32) },
        h.deps,
      ),
    ).toEqual({
      ok: true,
      live: false,
      targetVerified: false,
      inventoryComplete: false,
      source: "c".repeat(40),
      expectedCommit: "a".repeat(40),
      appVersion: null,
      imageDigest: null,
      reason: "public metadata traversal complete; application-version evidence unavailable",
      publicMetadata: {
        complete: true,
        pages: 3,
        rows: 2,
        states: { running: 2 },
        missingNames: 1,
        emptyImages: 0,
        reason: "public metadata traversal complete; application-version evidence unavailable",
      },
    });
    expect(h.calls).toEqual(["health", "public-metadata"]);
  });

  it("public metadata refuses non-success health even when the body claims the expected build", async () => {
    const h = harness();
    h.deps.readHealth = async () => {
      h.calls.push("health");
      return { status: 502, body: { ok: true, build: { commit: options.expectedCommit } } };
    };
    h.deps.readPublicMetadata = async () => {
      throw new Error("metadata must not run");
    };
    expect(
      await inspectSandboxOnce(
        { inspect: true, publicMetadata: true, expectedCommit: options.expectedCommit },
        { ...target, account: "d".repeat(32) },
        h.deps,
      ),
    ).toEqual({
      ok: false,
      live: false,
      targetVerified: false,
      inventoryComplete: false,
      source: "c".repeat(40),
      expectedCommit: "a".repeat(40),
      appVersion: null,
      imageDigest: null,
      reason: "Worker health does not carry HTTP 200 and the exact pinned commit",
    });
    expect(h.calls).toEqual(["health"]);
  });

  it("observes installed pins without granting target acceptance, even with complete inventory", async () => {
    const h = harness();
    expect(await inspectSandboxOnce({ inspect: true, expectedCommit: options.expectedCommit }, target, h.deps)).toEqual(
      {
        ok: true,
        live: false,
        targetVerified: false,
        inventoryComplete: true,
        source: "c".repeat(40),
        expectedCommit: "a".repeat(40),
        appVersion: 12,
        imageDigest: "sha256:" + "b".repeat(64),
        reason: "observation only; target acceptance and full readiness unverified",
      },
    );
    expect(h.calls).toEqual(["health", "app", "inventory"]);
  });
  it("keeps available installed facts when inventory fails without treating them as desired-release pins", async () => {
    const h = harness();
    h.setInstances({ error: "instance inventory repeated a page token; completeness unverified" });
    expect(await inspectSandboxOnce({ inspect: true, expectedCommit: options.expectedCommit }, target, h.deps)).toEqual(
      {
        ok: false,
        live: false,
        targetVerified: false,
        inventoryComplete: false,
        source: "c".repeat(40),
        expectedCommit: "a".repeat(40),
        appVersion: 12,
        imageDigest: "sha256:" + "b".repeat(64),
        reason: "instance inventory repeated a page token; completeness unverified",
      },
    );
    expect(h.calls).toEqual(["health", "app", "inventory"]);
  });
  it("matches an independently supplied content digest without accepting an unpinned tag", async () => {
    const h = harness();
    expect(
      await verifySandboxOnce(
        { ...options, expectedImage: "sha256:" + "b".repeat(64), inventoryOnly: true },
        target,
        h.deps,
      ),
    ).toMatchObject({ ok: true, live: false, inventoryVerified: true });
    expect(
      await verifySandboxOnce({ ...options, expectedImage: "registry.example/sandbox:latest" }, target, h.deps),
    ).toMatchObject({ ok: false, live: false, inventoryVerified: false });
    expect(h.calls).toEqual(["health", "app", "inventory"]);
  });
  it("keeps verifier source independent of the deployed Worker and distinguishes inventory-only proof", async () => {
    const h = harness();
    expect(await verifySandboxOnce({ ...options, inventoryOnly: true }, target, h.deps)).toEqual({
      ok: true,
      live: false,
      inventoryVerified: true,
      source: "c".repeat(40),
      expectedCommit: "a".repeat(40),
      reason: "inventory verified; echo probe not requested; full readiness unverified",
    });
    expect(h.calls).toEqual(["health", "app", "inventory"]);
  });
  it("does not probe incomplete inventory and preserves its failure", async () => {
    const h = harness();
    h.setInstances({ error: "instance inventory repeated a page token; completeness unverified" });
    expect(await verifySandboxOnce(options, target, h.deps)).toMatchObject({
      ok: false,
      live: false,
      inventoryVerified: false,
      reason: "instance inventory repeated a page token; completeness unverified",
    });
    expect(h.calls).toEqual(["health", "app", "inventory"]);
  });
  it("checks inventory before the exact echo and rereads the complete target before granting readiness", async () => {
    const h = harness();
    expect(await verifySandboxOnce(options, target, h.deps)).toEqual({
      ok: true,
      live: true,
      inventoryVerified: true,
      source: "c".repeat(40),
      expectedCommit: "a".repeat(40),
      reason: `Worker and pinned application match; complete inventory agrees; echo ok exit 0 from deploy-gate:${"a".repeat(40)} (version 12)`,
    });
    expect(h.calls).toEqual([
      "health",
      "app",
      "inventory",
      `probe:https://sandbox.example.test/exec:fixture:deploy-gate:${"a".repeat(40)}`,
      "health",
      "app",
      "inventory",
    ]);
  });
  it("refuses mismatched application images and stale running instances before any probe", async () => {
    const h = harness();
    h.setApp({ value: { version: 12, image: "registry.example/other@sha256:" + "d".repeat(64) } });
    expect(await verifySandboxOnce(options, target, h.deps)).toMatchObject({
      ok: false,
      live: false,
      reason: "container application does not match the pinned version and image",
    });
    expect(h.calls).toEqual(["health", "app"]);
    const stale = harness();
    stale.setInstances({ value: [{ name: "old", state: "running", version: 11 }] });
    expect(await verifySandboxOnce(options, target, stale.deps)).toMatchObject({
      ok: false,
      live: false,
      reason: "complete inventory includes a running instance outside the pinned application version",
    });
    expect(stale.calls).toEqual(["health", "app", "inventory"]);
  });
  it("refuses changed or incomplete inventory after a successful echo", async () => {
    const h = harness();
    h.deps.probeExec = async () => {
      h.setInstances({ error: "malformed continuation; completeness unverified" });
      return { body: { stdout: "ok", exitCode: 0 } };
    };
    expect(await verifySandboxOnce(options, target, h.deps)).toMatchObject({
      ok: false,
      live: false,
      inventoryVerified: false,
      reason: "malformed continuation; completeness unverified",
    });
    expect(h.calls).toEqual(["health", "app", "inventory", "health", "app", "inventory"]);
  });
  it("does not grant late inventory or start a probe after the existing deadline", async () => {
    const h = harness();
    const read = h.deps.readInstances;
    h.deps.readInstances = async (...args) => {
      const value = await read(...args);
      h.tick();
      return value;
    };
    expect(await verifySandboxOnce(options, target, h.deps)).toMatchObject({
      ok: false,
      live: false,
      inventoryVerified: false,
      reason: "verification interrupted or deadline reached",
    });
    expect(h.calls).toEqual(["health", "app", "inventory"]);
  });
  it("waits for the owned read to settle cancellation before returning without readiness credit", async () => {
    const h = harness();
    const controller = new AbortController();
    h.deps.signal = controller.signal;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let settle!: () => void;
    let signal: AbortSignal | undefined;
    h.deps.readInstances = async (_dir, _app, _config, readSignal) => {
      signal = readSignal;
      entered();
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
      return { value: [] };
    };
    let completed = false;
    const pending = verifySandboxOnce(options, target, h.deps).then((value) => {
      completed = true;
      return value;
    });
    await started;
    controller.abort();
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(completed).toBe(false);
    settle();
    expect(await pending).toMatchObject({
      ok: false,
      live: false,
      inventoryVerified: false,
      reason: "verification interrupted or deadline reached",
    });
  });
});
