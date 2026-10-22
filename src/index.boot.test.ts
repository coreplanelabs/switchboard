import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const servers: Server[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  servers.splice(servers.indexOf(server), 1);
  return port;
}

// The child starts through tsx with a cold module cache: about 3s warm and 8s
// cold on an idle machine, and slower on a loaded runner. Wait a minute for the
// health server, and end the wait as soon as the child exits, so a boot that dies
// reports the exit and the child's output instead of a bare fetch failure.
async function waitForHealth(url: string, child: ChildProcess, output: () => string): Promise<Response> {
  const deadline = Date.now() + 60_000;
  let last: unknown;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `boot fixture exited before its health server answered (code ${String(child.exitCode)}, signal ${String(child.signalCode)}):\n${output()}`,
      );
    }
    try {
      return await fetch(url, { signal: AbortSignal.timeout(1_000) });
    } catch (err) {
      last = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(`boot fixture health server never answered (${String(last)}):\n${output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("the production process boot fixture", () => {
  it("boots with unavailable state config or image identity into refusal-only health, never a bare default runtime", async () => {
    const statePort = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ document: null, version: 0 }));
      }),
    );
    const botPort = await freePort();
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SWITCHBOARD_CONFIG: "state://base",
        STATE_WORKER_URL: `http://127.0.0.1:${statePort}`,
        MEMORY_TOKEN: "fixture-memory-token",
        PORT: String(botPort),
        SLACK_BOT_TOKEN: "xoxb-fixture",
        SLACK_APP_TOKEN: "xapp-fixture",
        ANTHROPIC_API_KEY: "fixture-provider-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout?.on("data", (b) => {
      output += String(b);
    });
    child.stderr?.on("data", (b) => {
      output += String(b);
    });

    const health = await waitForHealth(`http://127.0.0.1:${botPort}/healthz`, child, () => output);
    expect(health.status).toBe(503);
    const body = await health.json();
    expect(body).toMatchObject({
      ok: false,
      inFlight: 0,
    });
    expect(typeof body.config).toBe("string");
    expect(body.config.length).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("loadedBase");
    const blocked = await fetch(`http://127.0.0.1:${botPort}/ingress`, { method: "POST" });
    expect(blocked.status).toBe(503);
    expect(child.exitCode).toBeNull();
    expect(child.kill("SIGTERM")).toBe(true);
    const [code, signal] = await once(child, "exit", { signal: AbortSignal.timeout(5_000) });
    expect({ code, signal }).toEqual({ code: 0, signal: null });
  }, 90_000);
});
