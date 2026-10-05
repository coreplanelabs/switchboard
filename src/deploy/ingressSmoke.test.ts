import { describe, expect, it, vi } from "vitest";
import { assertSmokeOriginMatchesPlan } from "./ingressSmoke.js";
import { agentSmokeTransport, runAgentSmoke } from "./agentSmoke.js";
import { config, fixture } from "./testing/agentSmoke.js";

const origin = "https://switchboard.example.test";
const healthUrl = `${origin}/healthz`;

describe("production ingress smoke", () => {
  it("sends an ordinary read through the deployed Door and requires a completed answer", async () => {
    const { transport } = fixture();
    assertSmokeOriginMatchesPlan(origin, healthUrl);
    const receipt = await runAgentSmoke({ config, thread: "release-123", transport });
    expect(receipt.capabilityOutcome).toBe("passed");
    expect(receipt.scenarios[0]).toMatchObject({ runId: "run-answer", outcome: "passed" });
    expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({ agent: "general" }), "release-123-answer");
  });

  it("fails when health is green but the Door asks again before starting an agent", async () => {
    const { transport } = fixture();
    transport.request = vi.fn(async () => ({ reply: "Which settings did you mean?" }));
    const receipt = await runAgentSmoke({ config, thread: "release-123", transport });
    expect(receipt.capabilityOutcome).toBe("failed");
    expect(receipt.scenarios[0].reason).toBe("no_agent_run");
  });

  it("fails on a run failure, wrong answer, missing credential, or unsafe URL", async () => {
    const failedIngress = fixture();
    const request = failedIngress.transport.request;
    failedIngress.transport.request = vi.fn(async (...args: Parameters<typeof request>) => {
      const body = (await request(...args)) as { run: { id: string; status: string } };
      return { ...body, run: { ...body.run, status: "failed" } };
    });
    expect(
      (await runAgentSmoke({ config, thread: "release-123", transport: failedIngress.transport })).capabilityOutcome,
    ).toBe("failed");
    const failed = fixture();
    failed.transport.readRun = vi.fn(async (id) => ({ ...(failed.records.get(id) as object), status: "failed" }));
    expect(
      (await runAgentSmoke({ config, thread: "release-123", transport: failed.transport })).capabilityOutcome,
    ).toBe("failed");
    for (const scenario of ["answer", "workspace"]) {
      const wrong = fixture();
      wrong.transport.readRun = vi.fn(async (id) => {
        const view = wrong.records.get(id) as { events: { type: string; text?: string }[] };
        return {
          ...view,
          events: view.events.map((event) =>
            id === `run-${scenario}` && event.type === "answer" ? { ...event, text: "wrong answer" } : event,
          ),
        };
      });
      expect(
        (await runAgentSmoke({ config, thread: "release-123", transport: wrong.transport })).capabilityOutcome,
      ).toBe("failed");
    }
    const fetch = vi.fn();
    expect(() => agentSmokeTransport({ origin, healthUrl, token: "", config, fetch })).toThrow("not set");
    expect(fetch).not.toHaveBeenCalled();
    for (const invalid of [
      "",
      "http://switchboard.example.test",
      "https://elsewhere.example.test",
      `${origin}/another-path`,
      `${origin}?query=1`,
      "https://user:pass@switchboard.example.test",
    ]) {
      expect(() => assertSmokeOriginMatchesPlan(invalid, healthUrl)).toThrow();
    }
  });
});
