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

  it("accepts only a completed bound Review command receipt and refuses metadata, cut, infrastructure and wrong-owner evidence", async () => {
    const check = {
      callId: "read-1",
      inputHash: "d".repeat(64),
      commandHash: "e".repeat(64),
      command: "npm test",
      purpose: "verification",
      owner: {
        runId: "run-review",
        requester: "http:smoke",
        threadKey: "http:smoke:release-1-review",
        repo: "acme/smoke",
      },
      workspace: { cwd: "/workspace/review", head: "b".repeat(40), fingerprint: "f".repeat(40) },
      timeoutMs: 1000,
      startedAt: 10,
      completedAt: 20,
      outcome: { kind: "completed", stdout: "2 tests passed", stderr: "", exitCode: 0, truncated: false },
    };
    const frame = (value: unknown) =>
      `Command completed.\n<untrusted-check-evidence>\n${JSON.stringify(value)}\n</untrusted-check-evidence>`;
    const cases = [
      { output: frame(check), passed: true },
      { output: "error: metadata unavailable", passed: false },
      { output: "<untrusted-check-evidence>metadata-only</untrusted-check-evidence>", passed: false },
      { output: frame(check), callId: "other-call", passed: false },
      { output: frame({ ...check, owner: { ...check.owner, requester: "http:other" } }), passed: false },
      { output: frame({ ...check, owner: { ...check.owner, threadKey: "http:smoke:other" } }), passed: false },
      { output: frame({ ...check, owner: { ...check.owner, repo: "acme/other" } }), passed: false },
      { output: frame({ ...check, outcome: { kind: "pending" } }), passed: false },
      { output: frame({ ...check, outcome: { kind: "not_started", reason: "command_refused" } }), passed: false },
      { output: frame(check), cut: true, passed: false },
      { output: frame(check), infra: true, passed: false },
      { output: frame(check), ok: false, passed: false },
      { output: frame({ ...check, callId: "other-call" }), passed: false },
      { output: frame({ ...check, owner: { ...check.owner, runId: "other-run" } }), passed: false },
      { output: frame({ ...check, workspace: { ...check.workspace, head: "c".repeat(40) } }), passed: false },
      { output: frame({ ...check, outcome: { kind: "unknown", reason: "transport" } }), passed: false },
      { output: frame({ ...check, outcome: { ...check.outcome, exitCode: 1 } }), passed: false },
      { output: frame({ ...check, outcome: { ...check.outcome, truncated: true } }), passed: false },
      { output: frame({ ...check, completedAt: undefined }), passed: false },
    ];
    for (const { passed, ...change } of cases) {
      const { transport, records } = fixture();
      transport.readRun = vi.fn(async (id) => {
        const record = records.get(id) as { events: Array<{ type: string; tool?: string }> };
        if (id !== "run-review") return record;
        return {
          ...record,
          events: record.events.map((event) =>
            event.tool === "read"
              ? { ...event, tool: "run_check", ...(event.type === "tool_result" ? change : {}) }
              : event,
          ),
        };
      });
      const receipt = await runAgentSmoke({ config, expectedCommit: commit, thread: "release-1", transport });
      expect(receipt.capabilityOutcome).toBe(passed ? "passed" : "failed");
      if (!passed) expect(receipt.scenarios[2].reason).toBe("workspace_execution_unproven");
    }
  });

  it("requires Slack connection before and after runs when configured", async () => {
    for (const connected of [false, undefined]) {
      const { transport } = fixture();
      transport.health = vi.fn(async () => ({ commit, version: "1.0.0", slackConnected: connected }));
      const receipt = await runAgentSmoke({
        config,
        expectedCommit: commit,
        thread: "release-1",
        transport,
        requireSlackConnection: true,
      });
      expect(receipt.scenarios[0]).toMatchObject({ outcome: "incomplete", reason: "slack_connection_unproven" });
      expect(receipt.scenarios[1].outcome).toBe("skipped");
      expect(transport.request).not.toHaveBeenCalled();
    }
    const before = fixture();
    before.transport.health = vi.fn(async () => ({ commit, version: "1.0.0", slackConnected: true }));
    const passed = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "release-1",
      transport: before.transport,
      requireSlackConnection: true,
    });
    expect(passed.capabilityOutcome).toBe("passed");
    expect(passed.slackConnection).toEqual({ required: true, connected: true, checks: 6 });
    const lost = fixture();
    lost.transport.health = vi
      .fn()
      .mockResolvedValueOnce({ commit, version: "1.0.0", slackConnected: true })
      .mockResolvedValue({ commit, version: "1.0.0", slackConnected: false });
    const failed = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "release-1",
      transport: lost.transport,
      requireSlackConnection: true,
    });
    expect(failed.scenarios[0]).toMatchObject({
      runId: "run-answer",
      outcome: "incomplete",
      reason: "slack_connection_unproven",
    });
    expect(failed.slackConnection).toEqual({ required: true, connected: false, checks: 2 });
    expect(lost.transport.request).toHaveBeenCalledTimes(1);
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

  it("requires the configured fixture verdict and refuses a missing or wrong posted verdict", async () => {
    for (const verdict of [undefined, "approve", "request_changes"] as const) {
      const { transport, records } = fixture();
      transport.readRun = vi.fn(async (id) => {
        const record = records.get(id) as { reviewPost?: object };
        return id === "run-review" ? { ...record, reviewPost: { ...record.reviewPost, verdict } } : record;
      });
      const receipt = await runAgentSmoke({
        config: { ...config, review: { ...config.review, expectedVerdict: "request_changes" } },
        thread: "release-1",
        transport,
      });
      expect(receipt.capabilityOutcome).toBe(verdict === "request_changes" ? "passed" : "failed");
      if (verdict !== "request_changes") expect(receipt.scenarios[2].reason).toBe("review_verdict_mismatch");
    }
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

  it("waits for the original asynchronous runs to be saved without another admission", async () => {
    vi.useFakeTimers();
    try {
      const original = fixture();
      const polls = new Map<string, number>();
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit, version: "1.0.0" } });
        const request = JSON.parse(String(init?.body));
        if (String(url).endsWith("/ingress")) {
          expect(request.async).toBe(true);
          const id = request.thread.split("-").at(-1);
          const agent = id === "answer" ? "general" : id === "workspace" ? "explore" : "review";
          const result = (await original.transport.request(
            { id, agent, text: request.text, minutes: id === "review" ? 7 : 4 },
            request.thread,
          )) as { run: { id: string }; build: unknown };
          return Response.json(
            { runId: result.run.id, threadKey: `http:smoke:${request.thread}`, build: result.build },
            { status: 202 },
          );
        }
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (request.method === "initialize")
          return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
        const id = request.params.arguments.id;
        const count = (polls.get(id) ?? 0) + 1;
        polls.set(id, count);
        const record =
          count === 1
            ? { id, finished: false, persisted: false }
            : count === 2
              ? { id, finished: true, persisted: false }
              : original.records.get(id);
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: { content: [{ type: "text", text: `runs.get: ok\n${JSON.stringify(record)}` }] },
        });
      });
      const transport = agentSmokeTransport({
        origin: "https://bot.example.test",
        healthUrl: "https://bot.example.test/healthz",
        token: "fixture-only",
        config,
        fetch,
      });
      const pending = runAgentSmoke({ config, expectedCommit: commit, thread: "release-1", transport });
      await vi.runAllTimersAsync();
      const receipt = await pending;
      expect(receipt.capabilityOutcome).toBe("passed");
      expect(receipt.scenarios.map((row) => [row.runId, row.outcome])).toEqual([
        ["run-answer", "passed"],
        ["run-workspace", "passed"],
        ["run-review", "passed"],
      ]);
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/ingress"))).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains an asynchronous admission when its build or thread evidence is refused", async () => {
    for (const change of [
      { build: undefined },
      { build: { commit: "wrong" } },
      { build: { commit: head } },
      { threadKey: "http:smoke:other" },
      { threadKey: undefined },
      { threadKey: 99 },
    ]) {
      const fetch = vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit } });
        if (String(url).endsWith("/ingress"))
          return Response.json(
            { runId: "admitted-run", threadKey: "http:smoke:release-1-answer", build: { commit }, ...change },
            { status: 202 },
          );
        throw new Error("refused admission must not be monitored");
      });
      const transport = agentSmokeTransport({
        origin: "https://bot.example.test",
        healthUrl: "https://bot.example.test/healthz",
        token: "fixture-only",
        config,
        fetch,
      });
      const receipt = await runAgentSmoke({ config, expectedCommit: commit, thread: "release-1", transport });
      expect(receipt.scenarios[0]).toMatchObject({
        runId: "admitted-run",
        outcome: "incomplete",
        reason: "threadKey" in change ? "run_identity_mismatch" : "served_build_mismatch",
      });
      expect(receipt.scenarios[1].outcome).toBe("skipped");
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/ingress"))).toHaveLength(1);
    }
  });

  it("keeps the admitted identity when asynchronous completion exceeds the deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit } });
        if (String(url).endsWith("/ingress"))
          return Response.json(
            { runId: "slow-run", threadKey: "http:smoke:release-1-answer", build: { commit } },
            { status: 202 },
          );
        const request = JSON.parse(String(init?.body));
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (request.method === "initialize")
          return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [{ type: "text", text: 'runs.get: ok\n{"id":"slow-run","finished":false,"persisted":false}' }],
          },
        });
      });
      const transport = agentSmokeTransport({
        origin: "https://bot.example.test",
        healthUrl: "https://bot.example.test/healthz",
        token: "fixture-only",
        config,
        fetch,
      });
      const pending = runAgentSmoke({ config, expectedCommit: commit, thread: "release-1", transport });
      await vi.runAllTimersAsync();
      const receipt = await pending;
      expect(receipt.capabilityOutcome).toBe("incomplete");
      expect(receipt.scenarios.map((row) => [row.runId, row.outcome, row.reason])).toEqual([
        ["slow-run", "incomplete", "run_record_unproven"],
        [undefined, "skipped", "prior_scenario_unproven"],
        [undefined, "skipped", "prior_scenario_unproven"],
      ]);
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/ingress"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses bounded ingress and the existing MCP JSON envelope with redirects refused", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit } });
      if (String(url).endsWith("/ingress"))
        return Response.json(
          { runId: "native-run", threadKey: "http:smoke:smoke-1", build: { commit } },
          { status: 202 },
        );
      const request = JSON.parse(String(init?.body));
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "initialize")
        return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
      expect(request.params).toEqual({ name: "runs_get", arguments: { id: "native-run", include: "messages" } });
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: 'runs.get: ok\n{"id":"native-run","finished":true,"persisted":true}' }],
        },
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
    expect(
      await transport.request({ id: "answer", agent: "general", text: "question", minutes: 4 }, "smoke-1"),
    ).toEqual({
      run: { id: "native-run", status: "started" },
      build: { commit },
      threadKey: "http:smoke:smoke-1",
    });
    expect(await transport.readRun("native-run")).toEqual({ id: "native-run", finished: true, persisted: true });
    for (const [, init] of fetch.mock.calls) {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    const body = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(body).toEqual({ text: "question", channel: "smoke", thread: "smoke-1", async: true });
  });
});
