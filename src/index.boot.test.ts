import { spawn, type ChildProcess } from "node:child_process";
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

async function waitForHealth(url: string): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < 300; i++) {
    try {
      return await fetch(url);
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw last;
}

describe("the production process boot fixture", () => {
  it("boots against a missing base document into refusal-only health, never a bare default runtime", async () => {
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

    const health = await waitForHealth(`http://127.0.0.1:${botPort}/healthz`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({
      ok: false,
      config: "missing base document — push one with `deploy config`",
      inFlight: 0,
    });
    expect(child.exitCode).toBeNull();
  }, 25_000);
});
