import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleLinearWebhook, type LinearWebhookDeps } from "./webhook.js";

const now = 1_000_000;
const secret = "test-webhook-secret";
const event = {
  type: "AgentSessionEvent",
  action: "created",
  organizationId: "org",
  oauthClientId: "client",
  webhookTimestamp: now,
  agentSession: { id: "session" },
};
function signed(value: unknown = event, delivery = "delivery") {
  const body = JSON.stringify(value);
  return new Request("https://bot.example/webhooks/linear", {
    method: "POST",
    body,
    headers: {
      "linear-signature": createHmac("sha256", secret).update(body).digest("hex"),
      "linear-delivery": delivery,
    },
  });
}
function fixture() {
  const accept = vi.fn<LinearWebhookDeps["accept"]>().mockResolvedValue(true);
  const deps: LinearWebhookDeps = { secret, applicationId: "client", organizationId: "org", clock: () => now, accept };
  return { deps, accept };
}

describe("Linear signed webhook intake", () => {
  it("persists a verified event before acknowledging and records adapter arrival time", async () => {
    const f = fixture();
    const res = await handleLinearWebhook(signed(), f.deps);
    expect(res.status).toBe(202);
    expect(f.accept).toHaveBeenCalledWith(
      expect.objectContaining({ key: "org:session:created", receivedAt: now, payload: event }),
    );
  });
  it("uses signed session and activity ids for deduplication, not an unsigned delivery header", async () => {
    const f = fixture();
    f.accept.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await handleLinearWebhook(signed(event, "one"), f.deps)).status).toBe(202);
    expect((await handleLinearWebhook(signed({ ...event, webhookTimestamp: now + 1 }, "two"), f.deps)).status).toBe(
      200,
    );
    expect(f.accept.mock.calls[0][0].key).toBe(f.accept.mock.calls[1][0].key);
    const prompt = {
      ...event,
      action: "prompted",
      agentActivity: { id: "prompt-1", content: { type: "prompt", body: "continue" } },
    };
    await handleLinearWebhook(signed(prompt), f.deps);
    expect(f.accept.mock.calls[2][0].key).toBe("org:session:prompted:prompt-1");
  });
  it("rejects forged signatures, modified bytes, old or future timestamps, and other installations", async () => {
    const f = fixture();
    const forged = signed();
    forged.headers.set("linear-signature", "0".repeat(64));
    expect((await handleLinearWebhook(forged, f.deps)).status).toBe(401);
    const altered = signed();
    expect(
      (
        await handleLinearWebhook(
          new Request(altered.url, {
            method: "POST",
            headers: altered.headers,
            body: JSON.stringify({ ...event, action: "prompted" }),
          }),
          f.deps,
        )
      ).status,
    ).toBe(401);
    for (const offset of [-60_001, 60_001])
      expect((await handleLinearWebhook(signed({ ...event, webhookTimestamp: now + offset }), f.deps)).status).toBe(
        401,
      );
    expect((await handleLinearWebhook(signed({ ...event, organizationId: "another" }), f.deps)).status).toBe(403);
    expect((await handleLinearWebhook(signed({ ...event, oauthClientId: "another" }), f.deps)).status).toBe(403);
    expect(f.accept).not.toHaveBeenCalled();
  });
  it("fails closed when disabled and rejects methods, malformed events and oversized bodies", async () => {
    const f = fixture();
    expect((await handleLinearWebhook(signed(), { ...f.deps, secret: undefined })).status).toBe(503);
    expect((await handleLinearWebhook(new Request("https://bot.example/webhooks/linear"), f.deps)).status).toBe(405);
    expect((await handleLinearWebhook(signed({ ...event, agentSession: {} }), f.deps)).status).toBe(400);
    expect((await handleLinearWebhook(signed({ ...event, action: "prompted" }), f.deps)).status).toBe(400);
    expect((await handleLinearWebhook(signed({ ...event, text: "x".repeat(1024 * 1024) }), f.deps)).status).toBe(413);
    expect(f.accept).not.toHaveBeenCalled();
  });
  it("returns a retryable failure if persistence fails, never a success", async () => {
    const f = fixture();
    f.accept.mockRejectedValueOnce(new Error("store unavailable with private details"));
    const res = await handleLinearWebhook(signed(), f.deps);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("private details");
  });
  it("retains lifecycle events and ignores event types the integration did not subscribe to", async () => {
    const f = fixture();
    for (const type of ["OAuthApp", "PermissionChange", "AppUserNotification"]) {
      expect((await handleLinearWebhook(signed({ ...event, type, action: "revoked" }), f.deps)).status).toBe(202);
    }
    expect((await handleLinearWebhook(signed({ ...event, type: "Issue" }), f.deps)).status).toBe(200);
    expect(f.accept).toHaveBeenCalledTimes(3);
  });
});
