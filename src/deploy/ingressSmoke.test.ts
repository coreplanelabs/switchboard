import { describe, expect, it, vi } from "vitest";
import { assertSmokeOriginMatchesPlan, smokeIngress } from "./ingressSmoke.js";

const origin = "https://switchboard.example.test";
const healthUrl = `${origin}/healthz`;
const token = "secret";
const thread = "release-123";

describe("production ingress smoke", () => {
  it("sends an ordinary read through the deployed Door and requires a completed answer", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ reply: "2 + 2 is 4.", run: { id: "run-1", status: "completed" } }), {
          status: 200,
        }),
    );
    assertSmokeOriginMatchesPlan(origin, healthUrl);
    await expect(smokeIngress({ origin, token, thread, fetch })).resolves.toEqual({
      runId: "run-1",
      reply: "2 + 2 is 4.",
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://switchboard.example.test/ingress"),
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({ text: "What is 2 + 2? Answer in one sentence.", thread }),
      }),
    );
  });

  it("fails when health is green but the Door asks again before starting an agent", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ reply: "Which settings did you mean?" }), { status: 200 }),
    );
    await expect(smokeIngress({ origin, token, thread, fetch })).rejects.toThrow("did not complete an agent run");
  });

  it("fails on a run failure, wrong answer, missing credential, or unsafe URL", async () => {
    const failed = vi.fn(
      async () => new Response(JSON.stringify({ reply: "4", run: { id: "run-1", status: "failed" } }), { status: 200 }),
    );
    await expect(smokeIngress({ origin, token, thread, fetch: failed })).rejects.toThrow("did not complete");
    const wrong = vi.fn(
      async () =>
        new Response(JSON.stringify({ reply: "I cannot answer.", run: { id: "run-1", status: "completed" } }), {
          status: 200,
        }),
    );
    await expect(smokeIngress({ origin, token, thread, fetch: wrong })).rejects.toThrow("did not answer");
    await expect(smokeIngress({ origin, token: "", thread, fetch: wrong })).rejects.toThrow("not set");
    await expect(
      smokeIngress({ origin: "http://switchboard.example.test", token, thread, fetch: wrong }),
    ).rejects.toThrow("HTTPS");
    expect(() => assertSmokeOriginMatchesPlan("https://elsewhere.example.test", healthUrl)).toThrow(
      "differs from the deployment profile",
    );
    expect(() => assertSmokeOriginMatchesPlan(`${origin}/another-path`, healthUrl)).toThrow("bare HTTPS origin");
    expect(() => assertSmokeOriginMatchesPlan("https://user:pass@switchboard.example.test", healthUrl)).toThrow(
      "bare HTTPS origin",
    );
  });
});
