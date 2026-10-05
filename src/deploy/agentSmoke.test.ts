import { describe, expect, it, vi } from "vitest";
import { agentSmokeTransport, parseSmokeConfig, runAgentSmoke } from "./agentSmoke.js";
import { MCP_PROTOCOL_VERSION } from "../mcp/client.js";

import { commit, config, fixture, head } from "./testing/agentSmoke.js";

describe("bounded agent smoke", () => {
  it("accepts three capability representatives from original runs and typed publication", async () => {
    const { transport } = fixture();
    const receipt = await runAgentSmoke({ config, expectedCommit: commit, thread: "release-1", transport });
    expect(receipt.capabilityOutcome).toBe("passed");
    expect(receipt.scenarios.map((s) => [s.id, s.outcome, s.runId])).toEqual([
      ["answer", "passed", "run-answer"],
      ["workspace", "passed", "run-workspace"],
      ["review", "passed", "run-review"],
    ]);
    expect(receipt.scenarios[2].artifact).toEqual({ repo: config.repo, number: 7, head });
    expect(receipt.liveGaps).toContain("private-question-fix-draft-pr");
    expect(receipt.productAcceptance).toEqual({
      outcome: "incomplete",
      reason: "private-question-fix-draft-pr-unproven",
    });
    expect(receipt.observedUsd).toBeCloseTo(0.3);
    expect(transport.request).toHaveBeenCalledTimes(3);
  });

  it("refuses health-only, fallback output, missing execution and mismatched publication", async () => {
    for (const change of [
      { answerOutcome: undefined },
      { answerOutcome: { version: 1, ending: "answered", output: "absent" } },
      { answerOutcome: { version: 1, ending: "time_budget", output: "present" } },
      { usage: { turns: 0 } },
      { userId: "http:another" },
      { threadKey: "http:smoke:old" },
      { replyOk: false },
      { persisted: false },
      { cost: { usd: null } },
    ]) {
      const { transport, records } = fixture();
      transport.readRun = vi.fn(async (id) => ({ ...(records.get(id) as object), ...change }));
      const receipt = await runAgentSmoke({ config, thread: "release-1", transport });
      expect(receipt.capabilityOutcome).not.toBe("passed");
      expect(transport.request).toHaveBeenCalledTimes(1);
      expect(receipt.scenarios[1].outcome).toBe("skipped");
    }
    for (const change of [{ events: [] }, { reviewPost: { posted: false } }, { reviewHead: "c".repeat(40) }]) {
      const { transport, records } = fixture();
      transport.readRun = vi.fn(async (id) => ({
        ...(records.get(id) as object),
        ...(id === "run-review" ? change : {}),
      }));
      expect((await runAgentSmoke({ config, thread: "release-1", transport })).capabilityOutcome).not.toBe("passed");
    }
    const { transport } = fixture();
    transport.request = vi.fn(async () => ({ reply: "4" }));
    expect((await runAgentSmoke({ config, thread: "release-1", transport })).capabilityOutcome).toBe("failed");
  });

  it("retains an admitted identity on monitoring failure and never retries or rolls back", async () => {
    const { transport } = fixture();
    transport.readRun = vi.fn(async () => {
      throw new Error("unavailable");
    });
    const receipt = await runAgentSmoke({ config, thread: "release-1", transport });
    expect(receipt.capabilityOutcome).toBe("incomplete");
    expect(receipt.scenarios[0]).toMatchObject({ runId: "run-answer", outcome: "incomplete" });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it("stops new admissions on spend or build mismatch and keeps exact served-build evidence", async () => {
    const { transport } = fixture();
    const receipt = await runAgentSmoke({
      config: { ...config, maxObservedUsd: 0.05 },
      thread: "release-1",
      transport,
    });
    expect(receipt.capabilityOutcome).toBe("failed");
    expect(receipt.scenarios[0].build?.commit).toBe(commit);
    expect(transport.request).toHaveBeenCalledTimes(1);
    const wrong = fixture();
    expect(
      (await runAgentSmoke({ config, expectedCommit: head, thread: "release-1", transport: wrong.transport }))
        .capabilityOutcome,
    ).toBe("incomplete");
    expect(wrong.transport.request).not.toHaveBeenCalled();
    const changed = fixture();
    changed.transport.health = vi
      .fn()
      .mockResolvedValueOnce({ commit, version: "1.0.0" })
      .mockResolvedValue({ commit: head, version: "1.0.0" });
    expect((await runAgentSmoke({ config, thread: "release-1", transport: changed.transport })).capabilityOutcome).toBe(
      "incomplete",
    );
    expect(changed.transport.request).toHaveBeenCalledTimes(1);
  });

  it("requires a disposable fixture and bounded configuration before any request", () => {
    expect(parseSmokeConfig(config).repo).toBe("acme/smoke");
    for (const changed of [
      { disposable: false },
      { repo: "" },
      { maxObservedUsd: 0 },
      { review: { number: 7, head: "short" } },
      { workspace: { path: "../private", answer: "x" } },
    ]) {
      expect(() => parseSmokeConfig({ ...config, ...changed })).toThrow();
    }
  });

  it("uses bounded ingress and the existing MCP JSON envelope with redirects refused", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit } });
      if (String(url).endsWith("/ingress"))
        return Response.json({ run: { id: "native-run", status: "completed" }, build: { commit } });
      const request = JSON.parse(String(init?.body));
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "initialize")
        return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
      expect(request.params).toEqual({ name: "runs_get", arguments: { id: "native-run", include: "messages" } });
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: 'runs.get: ok\n{"id":"native-run"}' }] },
      });
    });
    const transport = agentSmokeTransport({
      origin: "https://bot.example.test",
      healthUrl: "https://bot.example.test/healthz",
      token: "fixture-only",
      config,
      fetch,
    });
    expect(await transport.health()).toEqual({ commit });
    await transport.request({ id: "answer", agent: "general", text: "question", minutes: 4 }, "smoke-1");
    expect(await transport.readRun("native-run")).toEqual({ id: "native-run" });
    for (const [, init] of fetch.mock.calls) {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    const body = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(body).toEqual({ text: "question", channel: "smoke", thread: "smoke-1" });
  });
});
