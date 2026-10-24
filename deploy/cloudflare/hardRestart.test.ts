import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ hardRestart: vi.fn(), restart: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
vi.mock("@cloudflare/containers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cloudflare/containers")>();
  return { ...actual, getContainer: () => sdk };
});
vi.mock("./coordinator", () => ({ ShipCoordinator: class {} }));

import worker, { SwitchboardServer, type Env } from "./worker.ts";

const startedAt = "2026-10-22T05:19:43.606Z";
const env = {
  SWITCHBOARD_INGRESS_TOKENS: JSON.stringify({ fixture: { subject: "deployer" } }),
  SWITCHBOARD_RESTART_DEPLOYER: "deployer",
} as Env;
const stateEnv = { ...env, STATE_WORKER_URL: "https://state.example", MEMORY_TOKEN: "memory-fixture" };

function hardRequest(token = "fixture") {
  return new Request("https://switchboard.example/admin/restart/hard", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ force: true, expectedStartedAt: startedAt }),
  });
}

function refusalOnlyServer(body: Record<string, unknown>) {
  const destroy = vi.fn().mockResolvedValue(undefined);
  const server = Object.assign(Object.create(SwitchboardServer.prototype) as SwitchboardServer, {
    ctx: { container: { running: true }, blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn() },
    defaultPort: 8080,
    containerFetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 503 })),
    destroy,
  });
  return { server, destroy };
}

describe("hard restart of one refusal-only Bot process", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("destroys the exact idle refusal-only process and reports its old identity", async () => {
    const { server, destroy } = refusalOnlyServer({
      ok: false,
      config: "base document missing",
      inFlight: 0,
      draining: false,
      startedAt,
    });
    expect(await server.hardRestart(startedAt)).toEqual({
      kind: "stopping",
      forced: true,
      hard: true,
      inFlight: 0,
      previousStartedAt: startedAt,
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it.each([
    { startedAt: "2026-10-22T05:20:00.000Z", ok: false, config: "missing", inFlight: 0, draining: false },
    { startedAt, ok: true, config: "missing", inFlight: 0, draining: false },
    { startedAt, ok: false, config: "missing", inFlight: 1, draining: false },
    { startedAt, ok: false, config: "missing", inFlight: 0, draining: true },
    { startedAt, ok: false, config: "missing", inFlight: 0, draining: false, held: [{ id: "run-1" }] },
  ])("refuses a changed or working process: %j", async (body) => {
    const { server, destroy } = refusalOnlyServer(body);
    expect(await server.hardRestart(startedAt)).toEqual({
      kind: "refused",
      problems: ["hard restart requires the same idle refusal-only process"],
    });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("keeps competing DO work behind the health read and hard stop", async () => {
    let answerHealth!: (response: Response) => void;
    const health = new Promise<Response>((resolve) => {
      answerHealth = resolve;
    });
    let finishDestroy!: () => void;
    const destroyed = new Promise<void>((resolve) => {
      finishDestroy = resolve;
    });
    let unlock!: () => void;
    const unlocked = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const events: string[] = [];
    const blockConcurrencyWhile = vi.fn(async (fn: () => Promise<unknown>) => {
      try {
        return await fn();
      } finally {
        unlock();
      }
    });
    const { server } = refusalOnlyServer({});
    Object.assign(server, {
      ctx: { container: { running: true }, blockConcurrencyWhile },
      containerFetch: vi.fn().mockReturnValue(health),
      destroy: vi.fn().mockImplementation(async () => {
        events.push("destroy started");
        await destroyed;
      }),
    });
    const stop = server.hardRestart(startedAt);
    expect(blockConcurrencyWhile).toHaveBeenCalledOnce();
    const competing = unlocked.then(() => events.push("new DO event"));
    answerHealth(
      new Response(JSON.stringify({ ok: false, config: "missing", inFlight: 0, draining: false, startedAt }), {
        status: 503,
      }),
    );
    await vi.waitFor(() => expect(events).toEqual(["destroy started"]));
    finishDestroy();
    await stop;
    await competing;
    expect(events).toEqual(["destroy started", "new DO event"]);
  });

  it("requires the existing deployer bearer and an exact process identity at the public route", async () => {
    sdk.hardRestart.mockResolvedValue({
      kind: "stopping",
      forced: true,
      hard: true,
      inFlight: 0,
      previousStartedAt: startedAt,
    });
    const request = (token: string, body: string) =>
      new Request("https://switchboard.example/admin/restart/hard", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body,
      });
    const validBody = JSON.stringify({ force: true, expectedStartedAt: startedAt });
    expect((await worker.fetch(request("wrong", validBody), env)).status).toBe(401);
    expect((await worker.fetch(request("fixture", JSON.stringify({ force: true })), env)).status).toBe(400);
    expect(sdk.hardRestart).not.toHaveBeenCalled();
    const response = await worker.fetch(request("fixture", validBody), env);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      stopping: true,
      forced: true,
      hard: true,
      inFlight: 0,
      previousStartedAt: startedAt,
    });
    expect(sdk.hardRestart).toHaveBeenCalledExactlyOnceWith(startedAt);
  });

  it.each(["web", "all"])("keeps the guarded hard stop available during %s maintenance", async (scope) => {
    const stateRead = vi.fn().mockResolvedValue(
      Response.json({
        version: 1,
        document: {
          episode: {
            id: "12345678-1234-4234-8234-123456789abc",
            phase: "active",
            scopes: [scope],
            reason: "maintenance",
            channel: "ops",
            timing: "now",
            actor: "cli:operator",
            updatedAt: 1,
            notice: { status: "sent" },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", stateRead);
    sdk.hardRestart.mockResolvedValue({
      kind: "stopping",
      forced: true,
      hard: true,
      inFlight: 0,
      previousStartedAt: startedAt,
    });
    try {
      expect((await worker.fetch(hardRequest("wrong"), stateEnv)).status).toBe(401);
      expect(sdk.hardRestart).not.toHaveBeenCalled();
      const response = await worker.fetch(hardRequest(), stateEnv);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        ok: true,
        stopping: true,
        forced: true,
        hard: true,
        inFlight: 0,
        previousStartedAt: startedAt,
      });
      expect(sdk.hardRestart).toHaveBeenCalledExactlyOnceWith(startedAt);
      expect(stateRead).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the guarded hard stop available when maintenance state cannot be read", async () => {
    const stateRead = vi.fn().mockRejectedValue(new Error("state unavailable"));
    vi.stubGlobal("fetch", stateRead);
    sdk.hardRestart.mockResolvedValue({
      kind: "stopping",
      forced: true,
      hard: true,
      inFlight: 0,
      previousStartedAt: startedAt,
    });
    try {
      const response = await worker.fetch(hardRequest(), stateEnv);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        ok: true,
        stopping: true,
        forced: true,
        hard: true,
        inFlight: 0,
        previousStartedAt: startedAt,
      });
      expect(sdk.hardRestart).toHaveBeenCalledExactlyOnceWith(startedAt);
      expect(stateRead).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports an unknown outcome when the platform destroy call fails", async () => {
    sdk.hardRestart.mockRejectedValue(new Error("container state unavailable"));
    const response = await worker.fetch(
      new Request("https://switchboard.example/admin/restart/hard", {
        method: "POST",
        headers: { authorization: "Bearer fixture" },
        body: JSON.stringify({ force: true, expectedStartedAt: startedAt }),
      }),
      env,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "hard restart outcome unknown: container state unavailable",
    });
  });
});
