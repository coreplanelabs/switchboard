import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { configRefusalReason, createConfigRefusalServer } from "./configBoot.js";

const servers: ReturnType<typeof createConfigRefusalServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("the production config boot refusal", () => {
  it("renders a missing base document as the stable health reason and keeps a validator's sentence", () => {
    expect(
      configRefusalReason(
        new Error(
          'SWITCHBOARD_CONFIG=state://base: no "base" document on state Worker https://state.example — push one with `deploy config`',
        ),
      ),
    ).toBe("missing base document — push one with `deploy config`");
    expect(configRefusalReason(new Error("production config requires runHistory.worker so runs survive"))).toBe(
      "production config requires runHistory.worker so runs survive",
    );
  });

  it("boots a refusal-only HTTP fixture: /healthz is 503 JSON naming the config problem and no request is served as a live bot", async () => {
    const server = createConfigRefusalServer({
      problem: "missing base document — push one with `deploy config`",
      startedAt: 0,
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({
      ok: false,
      config: "missing base document — push one with `deploy config`",
      inFlight: 0,
      draining: false,
      startedAt: "1970-01-01T00:00:00.000Z",
    });

    const ingress = await fetch(`http://127.0.0.1:${port}/ingress`, { method: "POST" });
    expect(ingress.status).toBe(503);
    expect(await ingress.text()).toContain("config: missing base document");
  });
});
