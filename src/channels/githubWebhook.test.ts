import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createGithubWebhookHandler } from "./githubWebhook.js";

// Feature: docs/reference/specs/http-ingress.md — authenticated native delivery identity.
describe("GitHub native push delivery source", () => {
  it("carries the authenticated delivery header rather than payload text and refuses missing or unsigned source", async () => {
    const secret = "local-webhook-fixture";
    const watch = { pushToBase: vi.fn(async (_repo: string, _base: string, _eventId?: string) => []) };
    const handler = createGithubWebhookHandler({
      secret,
      watch,
      checksSettled: async () => false,
      instancesWaitingAt: async () => [],
      workflow: undefined,
      now: () => 1,
    });
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const body = JSON.stringify({
        ref: "refs/heads/main",
        repository: { full_name: "acme/api" },
        delivery: "payload-is-not-the-source",
      });
      const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      const post = (headers: Record<string, string>) =>
        fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: "POST",
          headers: { "x-github-event": "push", "x-hub-signature-256": signature, ...headers },
          body,
        });
      const admitted = await post({ "x-github-delivery": "actual-native-delivery" });
      expect(admitted.status).toBe(200);
      await admitted.json();
      expect(watch.pushToBase).toHaveBeenCalledWith("acme/api", "main", "github:actual-native-delivery");
      const missing = await post({});
      expect(missing.status).toBe(400);
      await missing.json();
      const unsigned = await post({ "x-github-delivery": "fake-delivery", "x-hub-signature-256": "sha256=bad" });
      expect(unsigned.status).toBe(401);
      await unsigned.json();
      expect(watch.pushToBase).toHaveBeenCalledTimes(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
